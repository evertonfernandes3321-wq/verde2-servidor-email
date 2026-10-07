import { mkdir, readFile, open, rm, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID, createPrivateKey, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { encryptBackup } from './backup-envelope.mjs';
import { required, inspectContainer, processCommand, postgresArgs, sql, within, enforceBarrier } from './backup-support.mjs';
import { expireBackups } from './backup-retention.mjs';

export async function backup(env = process.env) {
  const directory = resolve(required('BACKUP_DIRECTORY', env));
  const namespace = required('BACKUP_NAMESPACE', env);
  const pgName = required('BACKUP_POSTGRES_CONTAINER', env), mtaName = required('BACKUP_MTA_CONTAINER', env);
  const publicKey = await readFile(required('BACKUP_PUBLIC_KEY_FILE', env));
  const signingKey = createPrivateKey(await readFile(required('BACKUP_SIGN_PRIVATE_KEY_FILE',env)));
  if (signingKey.asymmetricKeyType !== 'ed25519') throw new Error('backup_signing_key_invalid');
  const stopped = required('BACKUP_STOPPED_CONTAINERS', env).split(',');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, '.backup.lock');
  const lock = await open(lockPath, 'wx', 0o600);
  const id = 'verde2-backup-' + randomUUID();
  const target = within(directory, id);
  try {
    await expireBackups(env,{alreadyLocked:true});
    const pg = await inspectContainer(pgName, namespace,env), mta = await inspectContainer(mtaName, namespace,env);
    const roles = [];
    for (const name of stopped) {
      const item = await inspectContainer(name, namespace,env);
      if (item.State.Running) throw new Error('backup_consumers_must_be_stopped');
      roles.push(item.Config.Labels['verde2.role'] || item.Config.Labels['com.docker.compose.service']);
    }
    if (!['api', 'worker', 'internal'].every(role => roles.includes(role))) throw new Error('backup_barrier_incomplete');
    await enforceBarrier(namespace,env);
    const enabled = (await sql(pgName, pg, 'SELECT dispatch_enabled FROM verde2.control WHERE id=true;')).trim();
    if (enabled !== 'f') throw new Error('backup_dispatch_must_be_paused');
    if (mta.State.Running) throw new Error('backup_mta_must_be_stopped');
    const mount = mta.Mounts.find(m => m.Destination === '/var/spool/postfix');
    if (!mount || !mount.Source || !['volume','bind'].includes(mount.Type)) throw new Error('backup_spool_mount_required');
    const source = mount.Type === 'volume' ? `type=volume,source=${mount.Name}` : `type=bind,source=${mount.Source}`;
    const spoolArgs = ['run', '--rm', '--network', 'none', '--entrypoint', 'tar', '--mount', `${source},target=/spool,readonly`, mta.Image, '-C', '/spool', '-cf', '-', '.'];
    await mkdir(target, { mode: 0o700 });
    const metadata = { id, namespace, createdAt: new Date().toISOString(), sourceMtaImage: mta.Image, keyId: required('BACKUP_KEY_ID', env), contentKeyId: required('CONTENT_KEY_ID', env) };
    const manifest = { format: 'verde2-backup-1', ...metadata, localComplete: false, externalCopyVerified: false, components: {} };
    const persistManifest=async()=>{
      delete manifest.signature;
      manifest.signature=sign(null,Buffer.from(JSON.stringify(manifest)),signingKey).toString('base64');
      const temporary=within(target,'manifest.tmp');
      const output=await open(temporary,'wx',0o600);
      try {await output.writeFile(JSON.stringify(manifest,null,2));await output.sync();}
      finally {await output.close();}
      await rename(temporary,within(target,'manifest.json'));
    };
    await persistManifest();
    const { user, database } = postgresArgs(pg);
    const commands = { postgres: ['exec', pgName, 'pg_dump', '-U', user, '-d', database, '--format=custom', '--no-owner', '--no-privileges'], spool: spoolArgs };
    for (const [kind, args] of Object.entries(commands)) {
      const child = processCommand(args);
      const file = kind + '.v2b';
      const sha256 = await encryptBackup(child.stdout, within(target, file), publicKey, { ...metadata, kind });
      await child.completion;
      manifest.components[kind] = { file, sha256 };
      await persistManifest();
    }
    manifest.localComplete = true;
    await persistManifest();
    return { id, manifest: join(target, 'manifest.json'), externalCopyVerified: false };
  } finally { await lock.close(); await rm(lockPath); }
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try { const result = await backup(); console.log(JSON.stringify({ event: 'encrypted_local_backup_complete', id: result.id, externalCopyVerified: false })); }
  catch { console.error('backup_failed'); process.exitCode = 1; }
}
