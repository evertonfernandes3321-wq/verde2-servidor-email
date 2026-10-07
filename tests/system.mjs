// Real HTTP, PostgreSQL, Redis, STARTTLS Postfix and controlled SMTP sink.
// Only the qualification runner executes this fixture; all data is synthetic.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import https from 'node:https';
import { createPool } from '../src/db/postgres.js';
import { loadConfig } from '../src/config/index.js';
import { bootstrap } from '../src/bootstrap.js';
import { Store } from '../src/store.js';

const config = loadConfig();
assert.equal(process.env.QUALIFICATION_MODE, 'synthetic');
assert.ok(config.emailDomain.endsWith('.test'));
const pool = createPool(config);
const fixtureFile = '/control/fixture.json';
const origin = 'http://api:3000';
const expiresAt = new Date(Date.now() + 3600000).toISOString();
const phase = process.argv[2] || 'all';
const canary = 'SYNTHETIC_REDACTION_CANARY_8fe102a3';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function api(method, path, token, body, expected = 200, key) {
  const response = await fetch(origin + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}), ...(key ? { 'idempotency-key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  // Never include the response/body in an assertion: credential responses contain secrets.
  assert.equal(response.status, expected, `HTTP contract ${method} ${path.split('/').slice(0, 4).join('/')} status`);
  return response.json();
}
async function waitFor(fn, seconds = 120) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) { if (await fn()) return; await sleep(500); }
  throw new Error('synthetic_readiness_timeout');
}
async function stats() { return (await fetch('http://sink:8080')).json(); }
async function prepare() {
  await waitFor(async () => { try { return (await fetch(origin + '/health/ready')).ok; } catch { return false; } });
  await bootstrap(new Store(pool,config),'/control/bootstrap-admin.json');
  const adminSecret=JSON.parse(await readFile('/control/bootstrap-admin.json','utf8')).secret;
  await api('PUT','/api/v1/admin/dispatch',adminSecret,{enabled:true});
  const tenants = {};
  for (const name of ['a', 'b', 'load']) {
    const tenant = await api('POST', '/api/v1/admin/tenants', adminSecret, { slug: `synthetic-${name}`, name: `Synthetic ${name}`, application: `qualification-${name}`, environment: 'qualification', perMinute: name === 'load' ? 10000 : 60, perDay: name === 'load' ? 10000 : 1000 }, 201);
    const from = `${name}@example.test`;
    await api('PUT', `/api/v1/admin/tenants/${tenant.id}/senders`, adminSecret, { address: from, replyTo: true });
    const full = await api('POST', `/api/v1/admin/tenants/${tenant.id}/credentials`, adminSecret, { kind: 'http', scopes: ['send:raw', 'logs:read', 'stats:read', 'templates:manage'], expiresAt }, 201);
    const sendOnly = await api('POST', `/api/v1/admin/tenants/${tenant.id}/credentials`, adminSecret, { kind: 'http', expiresAt }, 201);
    const smtp = await api('POST', `/api/v1/admin/tenants/${tenant.id}/credentials`, adminSecret, { kind: 'smtp', purpose: 'keycloak', expiresAt }, 201);
    const workerSmtp=await api('POST', `/api/v1/admin/tenants/${tenant.id}/credentials`, adminSecret, { kind: 'smtp', purpose: 'worker', expiresAt }, 201);
    const template = await api('POST', '/api/v1/templates', full.secret, { slug: `synthetic-${name}`, from, subject: 'Hello {{name}}', text: 'Hello {{name}}, {{resetUrl}}', variables: [{ name: 'name', required: true }, { name: 'resetUrl', required: true }] }, 201);
    tenants[name] = { id: tenant.id, from, full, sendOnly, smtp, workerSmtp, templateId: template.id };
  }
  const fixture = { adminSecret, tenants };
  await writeFile(fixtureFile, JSON.stringify(fixture), { mode: 0o600 });
  console.log('Synthetic fixtures provisioned (credentials withheld)');
  return fixture;
}
async function smtp(fixture, failure = false) {
  const tenant = fixture.tenants.a;
  const before = failure ? (await pool.query("SELECT count(*)::int n FROM reservations WHERE tenant_id=$1 AND state<>'released'", [tenant.id])).rows[0].n : null;
  const received = failure ? await stats() : null;
  const transport = nodemailer.createTransport({ host: 'postfix', port: 587, secure: false, requireTLS: true, auth: { user: tenant.smtp.username, pass: tenant.smtp.secret }, tls: { ca: await readFile(process.env.SMTP_CA_FILE), rejectUnauthorized: true, servername: 'postfix', minVersion: 'TLSv1.2' }, connectionTimeout: 10000, socketTimeout: 15000 });
  try {
    await transport.sendMail({ from: tenant.from, to: 'recipient@sink.test', subject: 'Synthetic SMTP', text: canary, disableUrlAccess: true, disableFileAccess: true });
    assert.equal(failure, false, 'SMTP outage must reject before acceptance');
  } catch (error) {
    if (!failure) throw new Error('synthetic_smtp_submission_failed');
    assert.ok(error.responseCode >= 400 && error.responseCode < 500, 'SMTP outage must yield a temporary rejection');
  } finally { transport.close(); }
  if (failure) {
    await sleep(1500);
    assert.equal((await pool.query("SELECT count(*)::int n FROM reservations WHERE tenant_id=$1 AND state<>'released'", [tenant.id])).rows[0].n, before, 'failed admission consumes no quota');
    assert.equal((await stats()).total, received.total, 'failed admission reaches no recipient');
  }
  console.log(failure ? 'SMTP fail-closed outage verified' : 'Authenticated SMTP admission verified');
}
async function contracts(fixture) {
  const { a, b } = fixture.tenants;
  await api('GET', '/api/v1/admin/tenants', a.sendOnly.secret, undefined, 401);
  for (const path of ['/api/v1/logs', '/api/v1/stats', '/api/v1/templates']) await api('GET', path, a.sendOnly.secret, undefined, 403);
  await api('POST', '/api/v1/send/raw', a.sendOnly.secret, { to: 'recipient@sink.test', from: a.from, subject: 'Synthetic', text: canary }, 403, randomUUID());
  await api('POST', '/api/v1/send', a.full.secret, { to: 'recipient@sink.test', templateId: b.templateId, variables: { name: 'Synthetic', resetUrl: canary } }, 404, randomUUID());
  await api('POST', `/api/v1/templates/${b.templateId}/preview`, a.full.secret, { variables: { name: 'Synthetic', resetUrl: canary } }, 404);
  await api('DELETE', `/api/v1/templates/${b.templateId}`, a.full.secret, undefined, 404);
  await api('POST', '/api/v1/send', a.full.secret, { to: 'recipient@sink.test', templateId: a.templateId }, 400, randomUUID());
  await api('POST', '/api/v1/send', a.full.secret, { to: 'recipient@sink.test', templateId: randomUUID(), variables: { name: 'Synthetic' } }, 404, randomUUID());
  const request = { to: 'recipient@sink.test', templateId: a.templateId, variables: { name: 'Synthetic', resetUrl: `https://example.test/reset/${canary}` } };
  const key = randomUUID();
  const logical = await Promise.all(Array.from({ length: 10 }, () => api('POST', '/api/v1/send', a.full.secret, request, 202, key)));
  assert.equal(new Set(logical.map(m => m.id)).size, 1, 'concurrent idempotency creates one logical message');
  await api('POST', '/api/v1/send', a.full.secret, { ...request, to: 'different@sink.test' }, 409, key);
  await api('GET', `/api/v1/messages/${logical[0].id}`, b.full.secret, undefined, 404);
  const raw = await api('POST', '/api/v1/send/raw', a.full.secret, { to: 'recipient@sink.test', from: a.from, subject: 'Synthetic raw', text: canary }, 202, randomUUID());
  await waitFor(async () => {
    const results = await Promise.all([logical[0].id, raw.id].map(id => api('GET', `/api/v1/messages/${id}`, a.full.secret)));
    return results.every(message => message.state === 'accepted_remote');
  });
  for (const id of [logical[0].id, raw.id]) {
    const view = await api('GET', `/api/v1/messages/${id}`, a.full.secret);
    const text = JSON.stringify(view);
    assert.ok(!text.includes(canary) && !text.includes('recipient@') && !text.includes('reset/'), 'sanitized message events');
  }
  console.log('HTTP templates/raw, scopes, tenant isolation and concurrent idempotency verified');
  fixture.deliveredMessageId=logical[0].id;
  await writeFile(fixtureFile,JSON.stringify(fixture),{mode:0o600});
}
async function revoked(fixture) {
  const credential=fixture.tenants.b.smtp;
  await api('DELETE',`/api/v1/admin/credentials/${credential.id}`,fixture.adminSecret);
  const transport=nodemailer.createTransport({host:'postfix',port:587,secure:false,requireTLS:true,auth:{user:credential.username,pass:credential.secret},tls:{ca:await readFile(process.env.SMTP_CA_FILE),rejectUnauthorized:true,servername:'postfix',minVersion:'TLSv1.2'},connectionTimeout:10000,socketTimeout:15000});
  try {await assert.rejects(transport.verify(),error=>error.code==='EAUTH' && error.responseCode>=500);}
  finally {transport.close();}
  console.log('Revoked SMTP credential rejected with no admission');
}
async function dsn(fixture) {
  const id=fixture.deliveredMessageId;
  const state=(await pool.query('SELECT state FROM messages WHERE id=$1',[id])).rows[0].state;
  const target=`b+${id}@bounce.example.test`,boundary='synthetic-dsn-boundary';
  const raw=['From: Mail Delivery System <mailer-daemon@sink.test>','To: '+target,'Message-ID: <synthetic-dsn-'+id+'@sink.test>','Subject: synthetic untrusted DSN','MIME-Version: 1.0',`Content-Type: multipart/report; report-type=delivery-status; boundary="${boundary}"`,'','--'+boundary,'Content-Type: text/plain','','Synthetic report','--'+boundary,'Content-Type: message/delivery-status','','Reporting-MTA: dns; sink.test','','Final-Recipient: rfc822; recipient@sink.test','Action: failed','Status: 5.1.1','','--'+boundary+'--',''].join('\r\n');
  const transport=nodemailer.createTransport({host:'postfix',port:25,secure:false,tls:{ca:await readFile(process.env.SMTP_CA_FILE),rejectUnauthorized:true,servername:'postfix'},connectionTimeout:10000,socketTimeout:15000});
  try {
    for(let n=0;n<2;n++){await transport.sendMail({envelope:{from:'',to:[target]},raw,disableFileAccess:true,disableUrlAccess:true});await sleep(1100);}
    await waitFor(async()=>(await pool.query("SELECT count(*)::int n FROM events WHERE message_id=$1 AND type='dsn_unverified'",[id])).rows[0].n===1);
    await sleep(2000);
    assert.equal((await pool.query("SELECT count(*)::int n FROM events WHERE message_id=$1 AND type='dsn_unverified'",[id])).rows[0].n,1);
    await assert.rejects(transport.sendMail({envelope:{from:'',to:[`b+${randomUUID()}@bounce.example.test`]},raw,disableFileAccess:true,disableUrlAccess:true}),e=>e.responseCode>=400);
    assert.equal((await pool.query('SELECT state FROM messages WHERE id=$1',[id])).rows[0].state,state);
    assert.equal((await pool.query('SELECT count(*)::int n FROM suppressions WHERE tenant_id=$1',[fixture.tenants.a.id])).rows[0].n,0);
  } finally {transport.close();}
  console.log('DSN via port25 and local pipe: duplicate normalized, unverified observation only, invalid return denied');
}
async function load(fixture) {
  const tenant = fixture.tenants.load;
  const before = await stats();
  const messages = [];
  const started = Date.now();
  await Promise.all(Array.from({ length: 10 }, async (_, client) => {
    for (let n = 0; n < 100; n++) {
      const response = await api('POST', '/api/v1/send', tenant.full.secret, { to: 'recipient@sink.test', templateId: tenant.templateId, variables: { name: `Synthetic ${client}-${n}`, resetUrl: canary } }, 202, `load-${client}-${n}`);
      messages.push(response.id);
    }
  }));
  assert.equal(new Set(messages).size, 1000);
  await waitFor(async () => {
    const row = (await pool.query("SELECT count(*)::int AS count FROM messages WHERE tenant_id=$1 AND state='accepted_remote'", [tenant.id])).rows[0];
    return row.count === 1000;
  }, 1200);
  const after = await stats();
  assert.equal(after.unique - before.unique, 1000, 'sink saw 1000 unique messages');
  assert.equal(after.total - before.total, 1000, 'sink saw no duplicates');
  assert.equal(after.signed - before.signed, 1000, 'all messages signed');
  assert.equal(after.verified - before.verified, 1000, 'all DKIM signatures verified locally');
  assert.equal(after.oversized, 0);
  console.log(JSON.stringify({ proof: 'synthetic_load', clients: 10, messages: 1000, duplicates: 0, verifiedDkim: 1000, milliseconds: Date.now() - started, completionWaitLimitSeconds: 1200, quotas: { tenantPerMinute: 10000, tenantPerDay: 10000, servicePerDay: 5000 }, internetDelivery: false }));
}
async function checkpoint(fixture) {
  const tenant = fixture.tenants.a;
  const m = await api('POST','/api/v1/send',tenant.full.secret,{to:'recipient@sink.test',templateId:tenant.templateId,variables:{name:'Synthetic restore',resetUrl:canary}},202,randomUUID());
  const expired = await api('POST','/api/v1/send',tenant.full.secret,{to:'recipient@sink.test',templateId:tenant.templateId,variables:{name:'Synthetic expired',resetUrl:canary}},202,randomUUID());
  await pool.query("UPDATE messages SET expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1",[expired.id]);
  fixture.recovery = {queued:m.id,expired:expired.id};
  await writeFile(fixtureFile,JSON.stringify(fixture),{mode:0o600});
  console.log('Recovery fixtures persisted with dispatcher stopped');
}
async function recovered(fixture) {
  assert.equal((await pool.query('SELECT dispatch_enabled FROM control')).rows[0].dispatch_enabled,false);
  assert.equal((await pool.query("SELECT count(*)::int n FROM credentials WHERE id<>$1 AND revoked_at IS NULL",[JSON.parse(await readFile('/control/restored-admin.json','utf8')).id])).rows[0].n,0);
  const messages = (await pool.query('SELECT id,state,content_cipher FROM messages WHERE id=ANY($1::uuid[])',[[fixture.recovery.queued,fixture.recovery.expired]])).rows;
  assert.equal(messages.find(m=>m.id===fixture.recovery.queued).state,'outcome_unknown');
  const expired=messages.find(m=>m.id===fixture.recovery.expired);
  assert.equal(expired.state,'expired'); assert.equal(expired.content_cipher,null);
  assert.equal((await pool.query('SELECT count(*)::int n FROM outbox')).rows[0].n,0);
  console.log('Encrypted restore verified: dispatch paused, restored credentials revoked, queued unknown, expired content purged');
  const spool=(await pool.query('SELECT id,state,content_cipher,queue_id FROM messages WHERE id=ANY($1::uuid[])',[[fixture.recovery.spoolHeld.id,fixture.recovery.spoolExpired.id]])).rows;
  assert.equal(spool.find(m=>m.id===fixture.recovery.spoolHeld.id).state,'outcome_unknown');
  const expiredSpool=spool.find(m=>m.id===fixture.recovery.spoolExpired.id);
  assert.equal(expiredSpool.state,'expired');assert.equal(expiredSpool.content_cipher,null);
  for(const entry of [fixture.recovery.spoolHeld,fixture.recovery.spoolExpired]) assert.equal(spool.find(m=>m.id===entry.id).queue_id,entry.queueId);
  await journalAbsent(fixture);
}
async function journalAbsent(fixture) {
  const eventKey=config.instanceId+':'+fixture.recovery.journal.payload.eventId;
  assert.equal((await pool.query('SELECT count(*)::int n FROM events WHERE event_key=$1',[eventKey])).rows[0].n,0,'historical pending observation must not be reapplied automatically');
}
async function spoolCheckpoint(fixture) {
  const before=(await pool.query("SELECT id FROM messages WHERE tenant_id=$1 AND source='smtp'",[fixture.tenants.a.id])).rows.map(m=>m.id);
  await smtp(fixture);await smtp(fixture);
  let rows;
  await waitFor(async()=>{rows=(await pool.query("SELECT id,state,queue_id FROM messages WHERE tenant_id=$1 AND source='smtp' AND id<>ALL($2::uuid[]) ORDER BY created_at,id",[fixture.tenants.a.id,before])).rows;return rows.length===2 && rows.every(m=>['accepted_local','deferred'].includes(m.state)&&m.queue_id);});
  fixture.recovery.spoolHeld={id:rows[0].id,queueId:rows[0].queue_id};fixture.recovery.spoolExpired={id:rows[1].id,queueId:rows[1].queue_id};
  await writeFile(fixtureFile,JSON.stringify(fixture),{mode:0o600});
  console.log('Two locally accepted SMTP messages persisted with physical queue bindings and controlled destination offline');
}
async function spoolExpire(fixture) {
  assert.equal((await pool.query("UPDATE messages SET expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1 AND state IN ('accepted_local','deferred')",[fixture.recovery.spoolExpired.id])).rowCount,1);
}
async function recoveryGate(enabled) {
  const credential=JSON.parse(await readFile('/control/restored-admin.json','utf8'));
  await api('PUT','/api/v1/admin/dispatch',credential.secret,{enabled});
  assert.equal((await pool.query('SELECT dispatch_enabled FROM control')).rows[0].dispatch_enabled,enabled);
  console.log(enabled?'Explicit audited synthetic restart test release enabled':'Synthetic restart test paused again');
}
async function recoveryReadiness() {
  const ca=await readFile(config.smtpCaFile);
  const result=await new Promise((resolve,reject)=>{
    const request=https.request('https://internal:3001/internal/v1/readiness',{method:'POST',ca,rejectUnauthorized:true,headers:{authorization:`Bearer ${config.internalToken}`,'content-type':'application/json'}},response=>{
      let body='';response.on('data',chunk=>{body+=chunk;});response.on('end',()=>{try{resolve({status:response.statusCode,error:JSON.parse(body).error});}catch{reject(new Error('synthetic_readiness_parse_failed'));}});
    });
    request.on('error',reject);request.setTimeout(5000,()=>request.destroy(new Error('synthetic_readiness_timeout')));request.end(JSON.stringify({instanceId:config.instanceId}));
  });
  assert.equal(result.status,503);assert.equal(result.error,'dispatch_paused');
  console.log('Private readiness rejected with 503 dispatch_paused over validated TLS');
}
try {
  const fixture = phase === 'provision' || phase === 'all' ? await prepare() : JSON.parse(await readFile(fixtureFile, 'utf8'));
  if (['smtp', 'outage'].includes(phase)) await smtp(fixture, phase === 'outage');
  if (phase === 'contracts' || phase === 'all') await contracts(fixture);
  if (phase === 'load' || phase === 'all') await load(fixture);
  if (phase === 'checkpoint') await checkpoint(fixture);
  if (phase === 'recovered') await recovered(fixture);
  if (phase === 'revoked') await revoked(fixture);
  if (phase === 'dsn') await dsn(fixture);
  if (phase === 'spool-checkpoint') await spoolCheckpoint(fixture);
  if (phase === 'spool-expire') await spoolExpire(fixture);
  if (phase === 'recovery-release') await recoveryGate(true);
  if (phase === 'recovery-pause') await recoveryGate(false);
  if (phase === 'recovery-readiness') await recoveryReadiness();
  if (phase === 'journal-absent') await journalAbsent(fixture);
} catch(error) {
  console.error(`synthetic_phase_failed:${phase}`);
  if(error.code && /^[A-Z_0-9]+$/.test(error.code)) console.error('synthetic_error_code:'+error.code);
  if(Number.isInteger(error.responseCode)) console.error('synthetic_smtp_response:'+error.responseCode);
  if(error.code==='ERR_ASSERTION' && typeof error.actual==='number' && typeof error.expected==='number') console.error(JSON.stringify({actual:error.actual,expected:error.expected}));
  process.exitCode = 1;
} finally { await pool.end(); }
