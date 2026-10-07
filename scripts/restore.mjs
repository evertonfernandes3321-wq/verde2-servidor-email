import { readFile, open, rm, mkdtemp, copyFile, rmdir, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, createHmac, createPublicKey, verify, createHash } from 'node:crypto';
import { verifyBackup, decryptBackup, digestFile } from './backup-envelope.mjs';
import { required, inspectContainer, processCommand, postgresArgs, sql, within, regular, enforceBarrier, acquireRestoreLock, capture } from './backup-support.mjs';

export async function restore(env = process.env) {
  const directory = resolve(required('RESTORE_BACKUP_DIRECTORY', env));
  const namespace = required('RESTORE_NAMESPACE', env);
  const pgName = required('RESTORE_POSTGRES_CONTAINER', env), mtaName = required('RESTORE_MTA_CONTAINER', env);
  const key = await readFile(required('RESTORE_PRIVATE_KEY_FILE', env));
  const stagingBase=await realpath(resolve(required('RESTORE_PRIVATE_STAGING_DIRECTORY',env)));
  const sourceRoot=await realpath(directory),stagingInfo=await lstat(stagingBase);
  if(!stagingInfo.isDirectory() || stagingInfo.isSymbolicLink() || stagingBase===sourceRoot || stagingBase.startsWith(sourceRoot+sep) || (process.platform!=='win32' && ((stagingInfo.mode&0o077)!==0 || stagingInfo.uid!==process.getuid()))) throw new Error('restore_staging_must_be_private_outside_source');
  const lockPath = join(directory, '.restore.lock');
  const rootLockPath=join(dirname(directory),'.backup.lock');
  const rootLock=await open(rootLockPath,'wx',0o600);
  let lock;
  try {lock=await open(lockPath,'wx',0o600);}
  catch(error){await rootLock.close();await rm(rootLockPath);throw error;}
  let staging;
  let adminOutput;
  let releaseTarget;
  let spoolLock;
  try {
    staging=await mkdtemp(join(stagingBase,'restore-'));
    await regular(join(directory, 'manifest.json'));
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    const verifyingKey = createPublicKey(await readFile(required('BACKUP_SIGN_PUBLIC_KEY_FILE',env)));
    const signature = manifest.signature;
    delete manifest.signature;
    if (verifyingKey.asymmetricKeyType !== 'ed25519' || typeof signature !== 'string' || !verify(null,Buffer.from(JSON.stringify(manifest)),verifyingKey,Buffer.from(signature,'base64'))) throw new Error('restore_signature_invalid');
    if (manifest.format !== 'verde2-backup-1' || !manifest.localComplete || !/^verde2-backup-[a-f0-9-]{36}$/.test(manifest.id)) throw new Error('restore_manifest_invalid');
    for (const kind of ['postgres', 'spool']) {
      const component = manifest.components[kind];
      if (component?.file !== kind + '.v2b') throw new Error('restore_component_invalid');
      const sourceFile = within(directory, component.file),file=within(staging,component.file);
      await regular(sourceFile);
      // Only encrypted bytes are staged. Untrusted original paths are never reopened for use.
      await copyFile(sourceFile,file,constants.COPYFILE_EXCL);
      await import('node:fs/promises').then(fs=>fs.chmod(file,0o600));
      if (await digestFile(file) !== component.sha256) throw new Error('restore_digest_invalid');
      const authenticated = await verifyBackup(file, key);
      if (authenticated.id !== manifest.id || authenticated.kind !== kind || authenticated.sourceMtaImage !== manifest.sourceMtaImage || authenticated.namespace !== manifest.namespace || authenticated.createdAt !== manifest.createdAt || authenticated.keyId !== manifest.keyId || authenticated.contentKeyId !== manifest.contentKeyId || authenticated.keyId !== env.BACKUP_KEY_ID || authenticated.contentKeyId !== env.CONTENT_KEY_ID) throw new Error('restore_metadata_invalid');
    }
    const pg = await inspectContainer(pgName, namespace,env), mta = await inspectContainer(mtaName, namespace,env);
    releaseTarget=await acquireRestoreLock(pgName,pg);
    const roles = [];
    for (const name of required('RESTORE_STOPPED_CONTAINERS',env).split(',')) {
      const item = await inspectContainer(name,namespace,env);
      if (item.State.Running) throw new Error('restore_consumers_must_be_stopped');
      roles.push(item.Config.Labels['verde2.role'] || item.Config.Labels['com.docker.compose.service']);
    }
    if (!['api','worker','internal'].every(role=>roles.includes(role))) throw new Error('restore_barrier_incomplete');
    await enforceBarrier(namespace,env);
    if (mta.State.Running || mta.Image !== manifest.sourceMtaImage) throw new Error('restore_mta_must_be_offline_same_image');
    if ((await sql(pgName, pg, "SELECT count(*) FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema','public') AND left(nspname,3)<>'pg_';")).trim() !== '0' || (await sql(pgName, pg, "SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public')+(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public')+(SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public');")).trim() !== '0') throw new Error('restore_database_must_be_empty');
    const mount = mta.Mounts.find(m => m.Destination === '/var/spool/postfix');
    if (!mount || !mount.Source || !['bind','volume'].includes(mount.Type)) throw new Error('restore_spool_mount_required');
    const lockName='verde2-restore-lock-'+createHash('sha256').update(mount.Type+':'+mount.Source).digest('hex').slice(0,32);
    await capture(['create','--name',lockName,'--label',`verde2.restore=${namespace}`,'--network','none','--entrypoint','true',mta.Image]);
    spoolLock=lockName;
    const source = mount.Type === 'volume' ? `type=volume,source=${mount.Name}` : `type=bind,source=${mount.Source}`;
    const extractor = resolve(dirname(fileURLToPath(import.meta.url)), 'restore-spool.py');
    const spool = processCommand(['run','--rm','-i','--network','none','--entrypoint','python3','--mount',`${source},target=/spool`,'--mount',`type=bind,source=${extractor},target=/restore.py,readonly`,mta.Image,'/restore.py'], undefined, { streamInput: true });
    spool.stdout.resume();
    try {await decryptBackup(within(staging,'spool.v2b'), key, spool.stdin);await spool.completion;}
    catch(error){const ended=await spool.completion.then(()=>null,failure=>failure);throw new Error('restore_spool_extract_failed'+(ended?.safeCode?'_'+ended.safeCode:''));}
    const { user, database } = postgresArgs(pg);
    const databaseRestore = processCommand(['exec','-i',pgName,'pg_restore','-U',user,'-d',database,'--exit-on-error','--single-transaction','--no-owner','--no-privileges'], undefined, { streamInput: true });
    databaseRestore.stdout.resume();
    try {await decryptBackup(within(staging,'postgres.v2b'), key, databaseRestore.stdin);await databaseRestore.completion;}
    catch {throw new Error('restore_postgres_archive_failed');}
    await sql(pgName,pg,"BEGIN; UPDATE verde2.control SET dispatch_enabled=false WHERE id=true; UPDATE verde2.credentials SET revoked_at=clock_timestamp(),secret_cipher=NULL; COMMIT;");
    const secret = randomBytes(32).toString('base64url'), credentialId = randomUUID();
    const pepper = required('CREDENTIAL_PEPPER', env);
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(pepper)) throw new Error('restore_pepper_invalid');
    const hash = createHmac('sha256',pepper).update(secret).digest('hex');
    adminOutput = await open(required('RESTORE_ADMIN_OUTPUT_FILE',env),'wx',0o600);
    const expiresAt = new Date(Date.now()+30*86400000).toISOString();
    await adminOutput.writeFile(JSON.stringify({id:credentialId,secret,expiresAt})); await adminOutput.sync();
    await sql(pgName,pg,`BEGIN; SET LOCAL search_path=verde2,public; SELECT pg_advisory_xact_lock(741102402); UPDATE control SET dispatch_enabled=false WHERE id=true; UPDATE credentials SET revoked_at=clock_timestamp(),secret_cipher=NULL; DELETE FROM smtp_connections; DELETE FROM outbox; UPDATE attempts SET finished_at=COALESCE(finished_at,clock_timestamp()),outcome=COALESCE(outcome,'restore_unknown'); UPDATE messages SET state='outcome_unknown',lease_id=NULL,lease_until=NULL WHERE state IN ('queued','in_flight','accepted_local','deferred','outcome_unknown'); UPDATE reservations SET state='uncertain',lease_id=NULL WHERE message_id IN (SELECT id FROM messages WHERE state='outcome_unknown'); UPDATE messages SET state='expired',terminal_at=COALESCE(terminal_at,clock_timestamp()),content_cipher=NULL WHERE expires_at<=clock_timestamp() AND state IN ('queued','in_flight','accepted_local','deferred','outcome_unknown'); UPDATE messages SET content_cipher=NULL WHERE terminal_at<clock_timestamp()-interval '24 hours'; INSERT INTO credentials(id,kind,secret_hash,expires_at) VALUES('${credentialId}','admin','${hash}','${expiresAt}'); INSERT INTO audit(actor_id,action,resource_id) VALUES('${credentialId}','restore_credentials_revoked_dispatch_paused',NULL); COMMIT;`);
    await sql(pgName,pg,"UPDATE verde2.messages SET content_cipher=NULL WHERE expires_at<=clock_timestamp() OR terminal_at<clock_timestamp()-interval '23 hours 50 minutes';");
    return { id: manifest.id, dispatchEnabled:false, restoredCredentialsRevoked:true, reconciliationRequired:true };
  } finally {
    await adminOutput?.close();
    await releaseTarget?.();
    if(spoolLock) await capture(['rm',spoolLock]);
    if(staging){
      for(const name of ['postgres.v2b','spool.v2b']) await rm(within(staging,name),{force:true});
      await rmdir(staging).catch(error=>{if(error.code!=='ENOENT') throw error;});
    }
    await lock.close(); await rm(lockPath);
    await rootLock.close();await rm(rootLockPath);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify({event:'restore_completed_held',...await restore()})); }
  catch { console.error('restore_failed_keep_all_consumers_offline'); process.exitCode=1; }
}
