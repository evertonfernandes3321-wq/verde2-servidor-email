import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {Readable,Writable} from 'node:stream';
import {mkdir,readFile,writeFile,rm,rmdir,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {encryptBackup,decryptBackup,verifyBackup} from '../scripts/backup-envelope.mjs';
import {expireBackups} from '../scripts/backup-retention.mjs';
import {operationFailure} from '../scripts/backup-support.mjs';
const base=resolve('.qualification','backup-unit-'+randomUUID());
test('operation diagnostics publish only fixed failure codes, never raw stderr',()=>{
  const privateDiagnostic='untrusted body and authorization value';
  const known=operationFailure(privateDiagnostic+'\nrestore_spool_not_empty\n'+privateDiagnostic,1);
  assert.equal(known.message,'docker_operation_failed');assert.equal(known.safeCode,'restore_spool_not_empty');assert.equal(known.exitCode,1);
  const unknown=operationFailure('restore_spool_not_empty_'+privateDiagnostic,2);
  assert.equal(unknown.safeCode,undefined);assert.equal(unknown.message,'docker_operation_failed');
  assert.equal(JSON.stringify(known).includes(privateDiagnostic),false);
});
test('encrypted streams authenticate corruption and never require plaintext files',async()=>{
  await mkdir(base,{recursive:true,mode:0o700});
  const file=join(base,'synthetic.v2b');
  const pair=generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
  try {
    await encryptBackup(Readable.from(['synthetic_payload']),file,pair.publicKey,{kind:'test'});
    assert.equal((await verifyBackup(file,pair.privateKey)).kind,'test');
    let output='';
    await decryptBackup(file,pair.privateKey,new Writable({write(chunk,_enc,done){output+=chunk;done();}}));
    assert.equal(output,'synthetic_payload');
    const corrupt=await readFile(file);corrupt[corrupt.length-1]^=1;await writeFile(file,corrupt);
    await assert.rejects(verifyBackup(file,pair.privateKey));
  } finally {await rm(file,{force:true});}
});
test('retention expires signed incomplete backups but rejects tampered dates',async()=>{
  const pair=generateKeyPairSync('ed25519',{publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
  const pub=join(base,'verification.pem');await writeFile(pub,pair.publicKey,{mode:0o600});
  const env={BACKUP_DIRECTORY:base,BACKUP_NAMESPACE:'verde2-synthetic',BACKUP_SIGN_PUBLIC_KEY_FILE:pub};
  const id='verde2-backup-'+randomUUID(),directory=join(base,id);await mkdir(directory);
  const manifest={format:'verde2-backup-1',id,namespace:env.BACKUP_NAMESPACE,createdAt:new Date(Date.now()-8*86400000).toISOString(),localComplete:false};
  const signed=()=>({...manifest,signature:sign(null,Buffer.from(JSON.stringify(manifest)),pair.privateKey).toString('base64')});
  const file=join(directory,'manifest.json');
  await writeFile(file,JSON.stringify(signed()));await writeFile(join(directory,'postgres.v2b'),'encrypted_test_only');
  const tampered=signed();tampered.createdAt='invalid';await writeFile(file,JSON.stringify(tampered));
  await assert.rejects(expireBackups(env),e=>e.message==='backup_retention_signature_invalid');
  await access(join(directory,'postgres.v2b'));
  await writeFile(file,JSON.stringify(signed()));
  assert.equal((await expireBackups(env)).removed,1);
  await assert.rejects(access(directory));
  await rm(pub);await rmdir(base);
});
