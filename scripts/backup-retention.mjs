import { readFile, readdir, rm, rmdir, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createPublicKey, verify } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { required, within, regular } from './backup-support.mjs';
export async function expireBackups(env=process.env,{alreadyLocked=false}={}) {
  const directory=resolve(required('BACKUP_DIRECTORY',env)), namespace=required('BACKUP_NAMESPACE',env);
  const lockPath=join(directory,'.backup.lock');
  const lock=alreadyLocked?null:await open(lockPath,'wx',0o600);
  try {
  const key=createPublicKey(await readFile(required('BACKUP_SIGN_PUBLIC_KEY_FILE',env)));
  if(key.asymmetricKeyType!=='ed25519') throw new Error('backup_verification_key_invalid');
  let removed=0;
  for(const folder of await readdir(directory,{withFileTypes:true})) {
    if(!folder.isDirectory() || !/^verde2-backup-[a-f0-9-]{36}$/.test(folder.name)) continue;
    const target=within(directory,folder.name), file=within(target,'manifest.json');
    await regular(file);
    const manifest=JSON.parse(await readFile(file,'utf8')), signature=manifest.signature;
    delete manifest.signature;
    if(typeof signature!=='string' || !verify(null,Buffer.from(JSON.stringify(manifest)),key,Buffer.from(signature,'base64'))) throw new Error('backup_retention_signature_invalid');
    const created=Date.parse(manifest.createdAt);
    if(!Number.isFinite(created) || manifest.id!==folder.name || manifest.format!=='verde2-backup-1' || manifest.namespace!==namespace) throw new Error('backup_retention_metadata_invalid');
    // Ten-minute margin for a five-minute scheduled sweep: never intentionally exceed seven days.
    if(created>=Date.now()-(7*86400000-600000)) continue;
    const files=await readdir(target);
    if(files.some(name=>!['manifest.json','manifest.tmp','postgres.v2b','spool.v2b'].includes(name))) throw new Error('backup_retention_unknown_files');
    for(const name of files) await regular(within(target,name));
    for(const name of files) await rm(within(target,name));
    await rmdir(target); removed++;
  }
  return {removed};
  } finally {if(lock){await lock.close();await rm(lockPath);}}
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {console.log(JSON.stringify({event:'backup_retention_complete',...await expireBackups()}));}
  catch {console.error('backup_retention_failed');process.exitCode=1;}
}
