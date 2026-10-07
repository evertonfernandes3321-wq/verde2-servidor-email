import { createCipheriv, createDecipheriv, createPublicKey, publicEncrypt, privateDecrypt, randomBytes, createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import { once } from 'node:events';

const magic = 'VERDE2_BACKUP_1 ';
export async function encryptBackup(input, filename, publicKey, metadata) {
  const recipient = createPublicKey(publicKey);
  if (recipient.asymmetricKeyType !== 'rsa' || recipient.asymmetricKeyDetails.modulusLength < 2048) throw new Error('backup_key_invalid');
  const key = randomBytes(32), iv = randomBytes(12);
  const header = Buffer.from(magic + JSON.stringify({ algorithm: 'RSA-OAEP-SHA256/AES-256-GCM', metadata, iv: iv.toString('base64'), wrappedKey: publicEncrypt({ key: recipient, oaepHash: 'sha256' }, key).toString('base64') }) + '\n');
  const handle = await open(filename, 'wx', 0o600);
  try {
    await handle.write(header);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(header);
    const output = createWriteStream(filename, { fd: handle.fd, autoClose: false, start: header.length });
    await pipeline(input, cipher, output, { end: false });
    const finished = once(output, 'finish');
    output.end(cipher.getAuthTag());
    await finished;
    await handle.sync();
  } finally { key.fill(0); await handle.close(); }
  return digestFile(filename);
}
export async function digestFile(filename) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  return digest.digest('hex');
}
async function frame(filename, privateKey) {
  const handle = await open(filename, 'r');
  try {
    const size = (await handle.stat()).size;
    const prefix = Buffer.alloc(Math.min(size, 65536));
    await handle.read(prefix, 0, prefix.length, 0);
    const boundary = prefix.indexOf(10);
    if (boundary < 0 || !prefix.subarray(0, boundary).toString().startsWith(magic) || size < boundary + 18) throw new Error('backup_frame_invalid');
    const header = prefix.subarray(0, boundary + 1);
    const parsed = JSON.parse(header.toString().slice(magic.length));
    if (parsed.algorithm !== 'RSA-OAEP-SHA256/AES-256-GCM') throw new Error('backup_algorithm_invalid');
    const key = privateDecrypt({ key: privateKey, oaepHash: 'sha256' }, Buffer.from(parsed.wrappedKey, 'base64'));
    const iv = Buffer.from(parsed.iv, 'base64');
    if (key.length !== 32 || iv.length !== 12) throw new Error('backup_key_invalid');
    const tag = Buffer.alloc(16);
    await handle.read(tag, 0, 16, size - 16);
    return { handle, size, header, metadata: parsed.metadata, key, iv, tag };
  } catch (error) { await handle.close(); throw error; }
}
export async function decryptBackup(filename, privateKey, output) {
  const f = await frame(filename, privateKey);
  try {
    const decipher = createDecipheriv('aes-256-gcm', f.key, f.iv);
    decipher.setAAD(f.header);
    decipher.setAuthTag(f.tag);
    await pipeline(createReadStream(filename, { fd: f.handle.fd, autoClose: false, start: f.header.length, end: f.size - 17 }), decipher, output);
    return f.metadata;
  } finally { f.key.fill(0); await f.handle.close(); }
}
// Authenticate every byte before using an archive. Plaintext never becomes a file.
export function verifyBackup(filename, privateKey) {
  return decryptBackup(filename, privateKey, new Writable({ write(_chunk, _encoding, done) { done(); } }));
}
