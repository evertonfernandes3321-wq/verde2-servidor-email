// Local-only qualification. No production .env is read and no external SMTP route exists.
import { spawn } from 'node:child_process';
import { randomBytes, createHash, generateKeyPairSync } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile, stat, lstat, realpath, rm } from 'node:fs/promises';
import { resolve, dirname, basename, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
let backup,restore;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const id = `verde2-qualify-${Date.now()}-${process.pid}`;
const folder = join(root, '.qualification', id);
const tree = join(folder, 'source');
const network = `${id}-isolated`;
const containers = [];
const scope=process.env.VERDE2_QUALIFICATION_SCOPE||'full';
if(!['full','recovery'].includes(scope)) throw new Error('qualification_scope_invalid');
const evidence = { id, scope, startedAt: new Date().toISOString(), checks: [], images: {} };
let reused;
const frozenImages={};
const components=['api','postfix','policy','opendkim','postgres','redis'];
const secret = () => randomBytes(32).toString('base64url');
const password = secret();
const redisPassword = secret();
const internalToken = secret();
const pepper = secret();
const key = randomBytes(32).toString('base64');
const pgImage = 'verde2/postgres:local';
const redisImage = 'verde2/redis:local';

function command(executable, args, { cwd = root, input, quiet = false, allowFailure = false } = {}) {
  return new Promise((done, fail) => {
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', stdout = '';
    child.stdout.on('data', data => { stdout += data; output += data; if (!quiet) process.stdout.write(data); });
    child.stderr.on('data', data => { output += data; if (!quiet) process.stderr.write(data); });
    child.on('error', fail);
    child.on('close', code => code === 0 || allowFailure ? done({ code, output, stdout }) : fail(new Error(`qualification_command_failed:${executable}:${code}`)));
    child.stdin.end(input);
  });
}
const docker = (args, options) => command('docker',args.map(arg=>frozenImages[arg]||arg), options);
async function check(name, fn) {
  const started = Date.now();
  console.log(`Qualification: ${name}`);
  try { const result = await fn(); evidence.checks.push({ name, status: 'PASS', milliseconds: Date.now() - started }); return result; }
  catch (error) { evidence.checks.push({ name, status: 'FAIL', milliseconds: Date.now() - started }); throw error; }
}
async function start(name, alias, image, args = [], cmd = []) {
  const full = `${id}-${name}`;
  await docker(['run', '-d', '--name', full, '--label', `verde2.qualification=${id}`, '--label', `verde2.role=${name}`, '--network', network, '--network-alias', alias, ...args, image, ...cmd], { quiet: true });
  containers.push(full);
  return full;
}
async function eventually(fn, seconds = 90) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('qualification_readiness_timeout');
}
const envFile = join(folder, 'synthetic.env');
const certs = join(folder, 'secrets');
const control = join(folder, 'control');
const fixtureUser=process.platform==='win32'?'0':`${process.getuid()}:${process.getgid()}`;
const mount = (source, target, readonly = true) => ['--mount', `type=bind,source=${source},target=${target}${readonly ? ',readonly' : ''}`];
async function snapshot() {
  const listing = await command('git', ['ls-files', '-c', '-o', '--exclude-standard', '-z'], { quiet: true });
  const manifest = [];
  for (const file of [...new Set(listing.output.split('\0').filter(Boolean))].sort()) {
    const source = resolve(root, file);
    if (!source.startsWith(root + '\\') && !source.startsWith(root + '/')) throw new Error('snapshot_path_invalid');
    let info;
    try { info = await stat(source); } catch { continue; }
    if (!info.isFile()) continue;
    const bytes = await readFile(source);
    manifest.push({ path: file, sha256: createHash('sha256').update(bytes).digest('hex') });
    const target = resolve(tree, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  evidence.head = (await command('git', ['rev-parse', 'HEAD'], { quiet: true })).output.trim();
  evidence.branch = (await command('git', ['branch', '--show-current'], { quiet: true })).output.trim();
  evidence.sourceDigest = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  await writeFile(join(folder, 'source-manifest.json'), JSON.stringify(manifest, null, 2));
}

await mkdir(certs, { recursive: true });
await mkdir(control, { recursive: true, mode: 0o700 });
let resultCode = 0;
try {
  await check('clean candidate snapshot', snapshot);
  if(scope==='recovery') await check('bind scoped recovery to prior qualified load and unchanged runtime sources',async()=>{
    const priorPath=resolve(process.env.VERDE2_REUSE_IMAGES_EVIDENCE||'');
    const artifacts=await realpath(join(root,'.qualification')),canonical=await realpath(priorPath),info=await lstat(priorPath);
    if(basename(priorPath)!=='evidence.json'||!info.isFile()||info.isSymbolicLink()||!canonical.startsWith(artifacts+sep)) throw new Error('qualification_prior_evidence_outside_workspace');
    let prior;
    try {prior=JSON.parse(await readFile(canonical,'utf8'));}catch{throw new Error('qualification_prior_evidence_invalid');}
    if(prior.head!==evidence.head||prior.branch!==evidence.branch||!Array.isArray(prior.checks)||!prior.checks.some(c=>c.name.startsWith('1000 messages')&&c.status==='PASS')||prior.load?.messages!==1000||prior.load?.duplicates!==0||prior.load?.verifiedDkim!==1000||prior.load?.internetDelivery!==false) throw new Error('qualification_prior_load_not_proven');
    for(const name of [...components.map(c=>'build '+c),'build API test image','SMTP test image']) if(!prior.checks.some(c=>c.name===name&&c.status==='PASS')) throw new Error('qualification_prior_build_not_proven');
    let oldManifest,currentManifest;
    try {oldManifest=JSON.parse(await readFile(join(dirname(canonical),'source-manifest.json'),'utf8'));currentManifest=JSON.parse(await readFile(join(folder,'source-manifest.json'),'utf8'));}catch{throw new Error('qualification_prior_manifest_invalid');}
    if(!Array.isArray(oldManifest)||!Array.isArray(currentManifest)) throw new Error('qualification_prior_manifest_invalid');
    if(createHash('sha256').update(JSON.stringify(oldManifest)).digest('hex')!==prior.sourceDigest) throw new Error('qualification_prior_manifest_digest_invalid');
    const product=p=>/^(api\/|postfix\/|opendkim\/|policy\/|postgres\/|redis\/)/.test(p)||['docker-compose.yml','docker-compose.qualified.yml','.env.example','config.example.yaml'].includes(p);
    if(JSON.stringify(oldManifest.filter(f=>product(f.path)))!==JSON.stringify(currentManifest.filter(f=>product(f.path)))) throw new Error('qualification_runtime_sources_changed_require_full');
    for(const component of components) {
      const alias=`verde2/${component}:local`,item=JSON.parse((await docker(['image','inspect',alias],{quiet:true})).output)[0];
      if(item.Id!==prior.images[component]) throw new Error('qualification_runtime_image_changed_require_full');
      frozenImages[alias]=item.Id;
    }
    reused=prior;evidence.reusedFrom={id:prior.id,sourceDigest:prior.sourceDigest,loadProof:prior.load,builds:prior.checks.filter(c=>c.name.startsWith('build '))};
  });
  ({backup}=await import(pathToFileURL(join(tree,'scripts','backup.mjs'))));
  ({restore}=await import(pathToFileURL(join(tree,'scripts','restore.mjs'))));
  await check('Gitleaks candidate (no local .env)', () => docker(['run', '--rm', '--network', 'none', ...mount(tree, '/source'), 'zricethezav/gitleaks:v8.24.3@sha256:e1b35e12a8c6fa8901f060459cfb6b2fc4c484d3afbe3b029733a3bbfab07055', 'dir', '/source', '--redact', '--no-banner']));
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  // Windows .cmd uses the normal local npm launcher; no secret occurs in its arguments.
  const npmRun = args => process.platform === 'win32'
    ? command('cmd.exe', ['/d', '/c', 'npm.cmd', ...args], { cwd: join(tree, 'api') })
    : command(npm, args, { cwd: join(tree, 'api') });
  await check('npm ci clean candidate', () => npmRun(['ci', '--ignore-scripts']));
  await check('lint', () => npmRun(['run', 'lint']));
  await check('unit and OpenAPI contract', () => npmRun(['test']));
  await check('npm dependency audit', () => npmRun(['audit', '--audit-level=high']));
  await check('encrypted backup, authenticated retention and CI evidence unit tests',()=>command('node',['--test','tests/backup.test.mjs','tests/scanner.test.mjs','tests/ci-evidence.test.mjs'],{cwd:tree}));
  for (const component of components) {
    if(!reused) await check(`build ${component}`, () => docker(['build', '--tag', `verde2/${component}:local`, join(tree, component)]));
    else await check(`reuse exact qualified ${component} image`,async()=>{});
    evidence.images[component] = JSON.parse((await docker(['image', 'inspect', `verde2/${component}:local`], { quiet: true })).output)[0].Id;
  }
  await check('policy canonicalization, redaction, release fencing and DSN unit tests',()=>docker(['run','--rm','--network','none','--entrypoint','python3',...mount(tree,'/source'),'verde2/policy:local','/source/tests/smtp/test_policy.py']));
  evidence.versions={node:(await docker(['run','--rm','--network','none','--entrypoint','node','verde2/api:local','--version'],{quiet:true})).output.trim()};
  for(const component of ['postfix','policy','opendkim','postgres','redis']) evidence.versions[component]=(await docker(['run','--rm','--network','none','--entrypoint','cat',`verde2/${component}:local`,'/usr/share/verde2-package-versions.txt'],{quiet:true})).output.trim().split('\n');
  evidence.testImages={};
  await check('build API test image', () => docker(['build', '--target', 'test', '--tag', 'verde2/api-test:local', join(tree, 'api')]));
  evidence.testImages.api=JSON.parse((await docker(['image','inspect','verde2/api-test:local'],{quiet:true})).output)[0].Id;
  frozenImages['verde2/api-test:local']=evidence.testImages.api;
  await docker(['network', 'create', '--internal', '--label', `verde2.qualification=${id}`, network], { quiet: true });
  const inspected = JSON.parse((await docker(['network', 'inspect', network], { quiet: true })).output)[0];
  if (!inspected.Internal) throw new Error('qualification_egress_not_blocked');
  evidence.network = { name: network, internal: true, publishedPorts: [] };
  const databaseName = 'verde2_test_qualify';
  const pg = await start('postgres', 'postgres', pgImage, ['-e', 'POSTGRES_USER=qualify', '-e', `POSTGRES_PASSWORD=${password}`, '-e', `POSTGRES_DB=${databaseName}`], ['postgres', '-c', 'log_statement=none', '-c', 'log_error_verbosity=terse', '-c', 'log_min_error_statement=fatal']);
  evidence.images.postgres=JSON.parse((await docker(['image','inspect',pgImage],{quiet:true})).output)[0].Id;
  if(reused&&evidence.images.postgres!==reused.images.postgres) throw new Error('qualification_postgres_image_changed_require_full');
  const redisConf = join(certs, 'redis.conf');
  await writeFile(redisConf, `bind 0.0.0.0\nprotected-mode yes\nuser default on >${redisPassword} ~* &* +@all\nappendonly no\nsave ""\n`, { mode: 0o600 });
  await docker(['run','--rm','--network','none','--entrypoint','sh',...mount(certs,'/secrets',false),redisImage,'-ec','chown "$(id -u redis):$(id -g redis)" /secrets/redis.conf; chmod 0600 /secrets/redis.conf'],{quiet:true});
  const redis=await start('redis', 'redis', redisImage, [...mount(redisConf, '/run/secrets/redis.conf')], ['redis-server','/run/secrets/redis.conf']);
  evidence.images.redis=JSON.parse((await docker(['image','inspect',redisImage],{quiet:true})).output)[0].Id;
  if(reused&&evidence.images.redis!==reused.images.redis) throw new Error('qualification_redis_image_changed_require_full');
  await eventually(async () => (await docker(['exec', pg, 'pg_isready', '-h', '127.0.0.1', '-U', 'qualify', '-d', databaseName], { quiet: true, allowFailure: true })).code === 0);
  await check('PostgreSQL and Redis servers preserve non-root privilege drop',async()=>{
    for(const server of [pg,redis]) {
      const processInfo=(await docker(['exec',server,'cat','/proc/1/status'],{quiet:true})).stdout;
      const uid=processInfo.match(/^Uid:\s+(\d+)/m);assert.ok(uid);assert.notEqual(Number(uid[1]),0);
    }
    evidence.dependenciesNonRoot=true;
  });
  const databaseUrl = `postgresql://qualify:${password}@postgres:5432/${databaseName}`;
  const lines = { NODE_ENV: 'test', DATABASE_URL: databaseUrl, TEST_DATABASE_URL: databaseUrl, REDIS_URL: `redis://default:${redisPassword}@redis:6379`, TEST_REDIS_URL: `redis://default:${redisPassword}@redis:6379`, CONTENT_KEY: key, CREDENTIAL_PEPPER: pepper, INTERNAL_TOKEN: internalToken, SMTP_HOST: 'mail.example.test', SMTP_PORT: '587', SMTP_CA_FILE: '/run/secrets/submission-ca.crt', EMAIL_DOMAIN: 'example.test', BOUNCE_DOMAIN: 'bounce.example.test', MAIL_INSTANCE_ID: id, INTERNAL_TLS_CERT_FILE: '/run/secrets/internal.crt', INTERNAL_TLS_KEY_FILE: '/run/secrets/internal.key', SERVICE_DAILY_QUOTA: '5000', HTTP_RATE_LIMIT: '5000', QUALIFICATION_MODE: 'synthetic' };
  await writeFile(envFile, Object.entries(lines).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
  await check('operational Compose immutable images and private services (config only)',async()=>{
    const composeEnvironment={...lines,MAIL_HOSTNAME:'mail.example.test',DKIM_SELECTOR:'qualify',POSTGRES_USER:'qualify',POSTGRES_PASSWORD:password,POSTGRES_DB:databaseName,SECRETS_DIR:certs,DKIM_PRIVATE_KEY_FILE:join(certs,'dkim.private'),ENCRYPTED_DATA_DIR:join(folder,'data'),OPERATIONS_EVIDENCE_DIR:join(folder,'operations'),API_QUALIFIED_IMAGE:evidence.images.api,POSTFIX_QUALIFIED_IMAGE:evidence.images.postfix,POLICY_QUALIFIED_IMAGE:evidence.images.policy,OPENDKIM_QUALIFIED_IMAGE:evidence.images.opendkim,POSTGRES_QUALIFIED_IMAGE:evidence.images.postgres,REDIS_QUALIFIED_IMAGE:evidence.images.redis};
    const path=join(certs,'compose.env');await writeFile(path,Object.entries(composeEnvironment).map(([k,v])=>`${k}=${v}`).join('\n')+'\n',{mode:0o600});
    const composed=JSON.parse((await docker(['compose','--env-file',path,'-f',join(tree,'docker-compose.yml'),'-f',join(tree,'docker-compose.qualified.yml'),'--profile','operations','config','--format','json'],{quiet:true})).output);
    for(const name of ['api','internal','worker','maintenance','migrate','postfix','policy','opendkim','journal-maintenance','postgres','redis']) {assert.equal(composed.services[name].build,undefined);assert.match(composed.services[name].image,/^sha256:[a-f0-9]{64}$/);}
    for(const name of ['postgres','redis','internal','policy','opendkim']) assert.ok(!composed.services[name].ports?.length);
    for(const name of ['api','postfix']) for(const port of composed.services[name].ports||[]) assert.equal(port.host_ip,'127.0.0.1');
    assert.equal(composed.networks.private.internal,true);assert.equal(composed.services['journal-maintenance'].network_mode,'none');
  });
  // Certificates and DKIM keys remain outside snapshot/images and are destroyed after the run.
  await check('synthetic TLS and DKIM material with strict certificate validation', () => docker(['run', '--rm', '--network', 'none', ...mount(certs, '/secrets', false), '--entrypoint', 'sh', 'verde2/postfix:local', '-ec', 'openssl req -x509 -newkey rsa:2048 -nodes -keyout /secrets/ca.key -out /secrets/ca.crt -days 2 -subj /CN=verde2-synthetic-ca -addext basicConstraints=critical,CA:TRUE,pathlen:1 -addext keyUsage=critical,keyCertSign,cRLSign -addext subjectKeyIdentifier=hash >/dev/null 2>&1; for host in postfix internal; do openssl req -newkey rsa:2048 -nodes -keyout /secrets/$host.key -out /secrets/$host.csr -subj /CN=$host >/dev/null 2>&1; printf "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\nsubjectAltName=DNS:%s,DNS:mail.example.test\n" "$host" > /secrets/$host.ext; openssl x509 -req -in /secrets/$host.csr -CA /secrets/ca.crt -CAkey /secrets/ca.key -CAcreateserial -out /secrets/$host.crt -days 2 -extfile /secrets/$host.ext >/dev/null 2>&1; openssl verify -x509_strict -purpose sslserver -verify_hostname "$host" -CAfile /secrets/ca.crt /secrets/$host.crt; done; cp /secrets/postfix.crt /secrets/submission.crt; cp /secrets/postfix.key /secrets/submission.key; cp /secrets/ca.crt /secrets/submission-ca.crt; cp /secrets/ca.crt /secrets/internal-ca.crt; openssl genrsa -out /secrets/dkim.private 2048 >/dev/null 2>&1; openssl pkey -in /secrets/dkim.private -pubout -outform DER 2>/dev/null | openssl base64 -A > /secrets/dkim.txt; chmod 600 /secrets/*.key /secrets/dkim.private; chown 1000:1000 /secrets/internal.key']));
  const appArgs = ['--env-file', envFile, ...mount(join(certs, 'submission-ca.crt'), '/run/secrets/submission-ca.crt')];
  await check('PostgreSQL integration and failure injection', () => docker(['run', '--rm', '--network', network, ...appArgs, 'verde2/api-test:local', 'npm', 'run', 'test:integration']));
  // Only the database in the uniquely named disposable container is reset.
  await docker(['exec', pg, 'psql', '-U', 'qualify', '-d', databaseName, '-v', 'ON_ERROR_STOP=1', '-c', 'DROP SCHEMA IF EXISTS verde2 CASCADE'], { quiet: true });
  await check('fresh authority migrations', () => docker(['run', '--rm', '--network', network, ...appArgs, 'verde2/api:local', 'node', 'src/db/migrate.js']));
  await check('PostgreSQL restart preserves migrated authority and privilege drop',async()=>{
    await docker(['restart',pg],{quiet:true});
    await eventually(async()=>(await docker(['exec',pg,'pg_isready','-h','127.0.0.1','-U','qualify','-d',databaseName],{quiet:true,allowFailure:true})).code===0);
    const uid=(await docker(['exec',pg,'cat','/proc/1/status'],{quiet:true})).stdout.match(/^Uid:\s+(\d+)/m);
    assert.ok(uid);assert.notEqual(Number(uid[1]),0);
    await docker(['run','--rm','--network',network,...appArgs,'verde2/api:local','node','src/db/migrate.js']);
    evidence.postgresRestarted=true;
  });
  await check('SMTP test image', async()=>{
    // The Dockerfile consumes the qualified Postfix tag; verify its identity on
    // both sides of the build, then run tests by the newly built immutable ID.
    const postfixId=async()=>JSON.parse((await command('docker',['image','inspect','verde2/postfix:local'],{quiet:true})).output)[0].Id;
    assert.equal(await postfixId(),evidence.images.postfix);
    await docker(['build', '--tag', 'verde2/smtp-test:local', join(tree, 'tests', 'smtp')]);
    assert.equal(await postfixId(),evidence.images.postfix);
  });
  evidence.testImages.smtp=JSON.parse((await docker(['image','inspect','verde2/smtp-test:local'],{quiet:true})).output)[0].Id;
  frozenImages['verde2/smtp-test:local']=evidence.testImages.smtp;
  await start('sink', 'sink', 'verde2/smtp-test:local', ['--entrypoint', 'python3', ...mount(join(tree, 'tests', 'smtp'), '/tests'), ...mount(join(certs, 'dkim.txt'), '/run/public/dkim.txt')], ['/tests/sink.py']);
  await start('internal', 'internal', 'verde2/api:local', [...appArgs,'--no-healthcheck', ...mount(join(certs, 'internal.crt'), '/run/secrets/internal.crt'), ...mount(join(certs, 'internal.key'), '/run/secrets/internal.key')], ['node', 'src/internal.js']);
  await start('api', 'api', 'verde2/api:local', appArgs);
  const system = phase => docker(['run', '--rm', '--user', fixtureUser, '--network', network, ...appArgs, ...mount(join(tree, 'tests'), '/app/qualification'), ...mount(control, '/control', false), 'verde2/api:local', 'node', '/app/qualification/system.mjs', phase]);
  await check('synthetic fixture provisioning through real API', () => system('provision'));
  await start('dkim', 'opendkim', 'verde2/opendkim:local', ['-e', 'EMAIL_DOMAIN=example.test', '-e', 'DKIM_SELECTOR=qualify', ...mount(join(certs, 'dkim.private'), '/run/secrets/dkim.private')]);
  const controls = ['--env-file', envFile, '-e', 'INTERNAL_URL=https://internal:3001', '-e', 'INTERNAL_CA_FILE=/run/secrets/internal-ca.crt', ...mount(join(certs, 'internal-ca.crt'), '/run/secrets/internal-ca.crt')];
  await start('policy', 'policy', 'verde2/policy:local', controls);
  // A tmpfs-backed volume plus an idle keeper permits an OFFLINE consistent spool snapshot.
  await docker(['volume','create','--driver','local','--opt','type=tmpfs','--opt','device=tmpfs','--opt','o=size=128m','--label',`verde2.qualification=${id}`,`${id}-source-spool`],{quiet:true});
  await start('source-spool-keeper','source-spool-keeper','verde2/postfix:local',['--entrypoint','sh','--mount',`type=volume,source=${id}-source-spool,target=/spool`],['-c','sleep infinity']);
  const mta = await start('postfix', 'postfix', 'verde2/postfix:local', [...controls, '--network-alias', 'mail.example.test', '-e', 'MAIL_HOSTNAME=mail.example.test', '--mount',`type=volume,source=${id}-source-spool,target=/var/spool/postfix`, ...mount(join(certs, 'submission.crt'), '/run/secrets/submission.crt'), ...mount(join(certs, 'submission.key'), '/run/secrets/submission.key')]);
  await check('MTA starts with validated policy TLS',()=>eventually(async () => {
    const state=(await docker(['inspect','--format','{{.State.Running}}',mta],{quiet:true})).output.trim();
    if(state!=='true') throw new Error('qualification_mta_startup_failed');
    return (await docker(['exec', mta, 'postfix', 'status'], { quiet: true, allowFailure: true })).code === 0;
  }));
  await start('worker', 'worker', 'verde2/api:local', [...appArgs,'--no-healthcheck'], ['node', 'src/worker.js']);
  await check('SMTP TLS, certificate, relay, credentials, headers and recipients', () => docker(['run', '--rm', '--network', network, '--entrypoint', 'python3', '--env-file', envFile, '-e', 'SMTP_FIXTURE_FILE=/control/fixture.json', ...mount(control, '/control'), ...mount(join(tree, 'tests', 'smtp'), '/tests'), ...mount(join(certs, 'submission-ca.crt'), '/run/secrets/submission-ca.crt'), 'verde2/smtp-test:local', '/tests/check.py']));
  await check('HTTP/SMTP contracts over real transports', () => system('contracts'));
  await check('revoked SMTP credential rejects new admission',()=>system('revoked'));
  await check('untrusted DSN reception, duplicate normalization and invalid return rejection',()=>system('dsn'));
  for (const name of ['policy', 'dkim']) {
    await docker(['stop', `${id}-${name}`], { quiet: true });
    await check(`SMTP fail-closed ${name} outage`, () => system('outage'));
    await docker(['start', `${id}-${name}`], { quiet: true });
    await new Promise(r => setTimeout(r, 1000));
  }
  if(!reused){
    const loadResult=await check('1000 messages through API/worker/Postfix, ten clients, verified DKIM', () => system('load'));
    evidence.load=JSON.parse(loadResult.output.split(/\r?\n/).find(line=>line.startsWith('{"proof":"synthetic_load"')));
  }else evidence.checks.push({name:'1000-message load',status:'NOT_RUN',reason:'Scoped recovery; separate prior load proof bound to byte-identical runtime and exact immutable images'});
  await check('encrypted backup, authenticated corruption rejection and held restore',async()=>{
    await docker(['stop',`${id}-worker`],{quiet:true});
    await system('checkpoint');
    await eventually(async()=>!(await docker(['exec',mta,'postqueue','-j'],{quiet:true})).output.trim());
    await docker(['stop',`${id}-sink`],{quiet:true});
    await system('spool-checkpoint');
    await docker(['stop',mta],{quiet:true});
    await system('spool-expire');
    const beforeBackupFixture=JSON.parse(await readFile(join(control,'fixture.json'),'utf8'));
    beforeBackupFixture.recovery.journal={created:Date.now()/1000,payload:{eventId:createHash('sha256').update(id+':restore-pending-observation').digest('hex'),instanceId:id,queueId:beforeBackupFixture.recovery.spoolHeld.queueId,type:'deferred',enhancedStatus:'4.4.1'}};
    await writeFile(join(control,'fixture.json'),JSON.stringify(beforeBackupFixture),{mode:0o600});
    const journalPhase=(volume,phase)=>docker(['run','--rm','-i','--network','none','--entrypoint','python3','--mount',`type=volume,source=${id}-${volume},target=/spool`,...mount(join(tree,'tests','smtp','recovery-journal.py'),'/test.py'),'verde2/postfix:local','/test.py',phase],{input:JSON.stringify(beforeBackupFixture.recovery.journal)});
    await journalPhase('source-spool','inject');await system('journal-absent');
    for(const name of ['api','internal']) await docker(['stop',`${id}-${name}`],{quiet:true});
    await docker(['exec',pg,'psql','-U','qualify','-d',databaseName,'-v','ON_ERROR_STOP=1','-c','UPDATE verde2.control SET dispatch_enabled=false WHERE id=true'],{quiet:true});
    const encryption=generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
    const signing=generateKeyPairSync('ed25519',{publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
    for(const [name,bytes]of Object.entries({'backup-public.pem':encryption.publicKey,'backup-private.pem':encryption.privateKey,'sign-public.pem':signing.publicKey,'sign-private.pem':signing.privateKey})) await writeFile(join(certs,name),bytes,{mode:0o600});
    const operations={...process.env,OPERATIONS_SCOPE:'synthetic',BACKUP_DIRECTORY:join(folder,'backups'),BACKUP_NAMESPACE:id,BACKUP_POSTGRES_CONTAINER:pg,BACKUP_MTA_CONTAINER:mta,BACKUP_STOPPED_CONTAINERS:['api','worker','internal'].map(n=>`${id}-${n}`).join(','),BACKUP_PUBLIC_KEY_FILE:join(certs,'backup-public.pem'),BACKUP_SIGN_PRIVATE_KEY_FILE:join(certs,'sign-private.pem'),BACKUP_SIGN_PUBLIC_KEY_FILE:join(certs,'sign-public.pem'),BACKUP_KEY_ID:'synthetic-backup',CONTENT_KEY_ID:'synthetic-content'};
    const saved=await backup(operations);
    const restoredPg=await start('restored-postgres','restored-postgres',pgImage,['-e','POSTGRES_USER=qualify','-e',`POSTGRES_PASSWORD=${password}`,'-e','POSTGRES_DB=verde2_test_restore'],['postgres','-c','log_statement=none','-c','log_error_verbosity=terse','-c','log_min_error_statement=fatal']);
    await eventually(async()=>(await docker(['exec',restoredPg,'pg_isready','-h','127.0.0.1','-U','qualify','-d','verde2_test_restore'],{quiet:true,allowFailure:true})).code===0);
    await docker(['volume','create','--driver','local','--opt','type=tmpfs','--opt','device=tmpfs','--opt','o=size=128m','--label',`verde2.qualification=${id}`,`${id}-restore-spool`],{quiet:true});
    await start('restore-spool-keeper','restore-spool-keeper','verde2/postfix:local',['--entrypoint','sh','--mount',`type=volume,source=${id}-restore-spool,target=/spool`],['-c','sleep infinity']);
    const restoredMta=await start('restored-mta','restored-mta','verde2/postfix:local',['--entrypoint','sh','--mount',`type=volume,source=${id}-restore-spool,target=/var/spool/postfix,volume-nocopy`],['-c','sleep infinity']);
    await docker(['stop',restoredMta],{quiet:true});
    const stagingBase=join(certs,'restore-staging');await mkdir(stagingBase,{mode:0o700});
    const settings={...operations,RESTORE_BACKUP_DIRECTORY:dirname(saved.manifest),RESTORE_NAMESPACE:id,RESTORE_POSTGRES_CONTAINER:restoredPg,RESTORE_MTA_CONTAINER:restoredMta,RESTORE_STOPPED_CONTAINERS:operations.BACKUP_STOPPED_CONTAINERS,RESTORE_PRIVATE_KEY_FILE:join(certs,'backup-private.pem'),RESTORE_ADMIN_OUTPUT_FILE:join(control,'restored-admin.json'),RESTORE_PRIVATE_STAGING_DIRECTORY:stagingBase,CREDENTIAL_PEPPER:pepper};
    const archive=join(settings.RESTORE_BACKUP_DIRECTORY,'postgres.v2b'),original=await readFile(archive),modified=Buffer.from(original);modified[modified.length-1]^=1;
    await writeFile(archive,modified);
    await assert.rejects(restore(settings),e=>e.message==='restore_digest_invalid');
    await writeFile(archive,original);
    const started=Date.now();await restore(settings);
    await journalPhase('restore-spool','verify');
    await check('journal retention independent of paused dispatch and MTA',()=>docker(['run','--rm','--network','none','--entrypoint','python3','--mount',`type=volume,source=${id}-restore-spool,target=/var/spool/postfix`,'verde2/postfix:local','/opt/verde2/journal.py']));
    const restoredArgs=[...appArgs,'-e',`DATABASE_URL=postgresql://qualify:${password}@restored-postgres:5432/verde2_test_restore`];
    const restoredSystem=phase=>docker(['run','--rm','--user',fixtureUser,'--network',network,...restoredArgs,...mount(join(tree,'tests'),'/app/qualification'),...mount(control,'/control',false),'verde2/api:local','node','/app/qualification/system.mjs',phase]);
    await restoredSystem('recovered');
    await check('restored migrations checksum and catalog',()=>docker(['run','--rm','--network',network,...appArgs,'-e',`DATABASE_URL=postgresql://qualify:${password}@restored-postgres:5432/verde2_test_restore`,'verde2/api:local','node','src/db/migrate.js']));
    const restoredInternal=await start('restored-internal','internal','verde2/api:local',[...restoredArgs,'--no-healthcheck','--label','verde2.role=internal',...mount(join(certs,'internal.crt'),'/run/secrets/internal.crt'),...mount(join(certs,'internal.key'),'/run/secrets/internal.key')],['node','src/internal.js']);
    await start('restored-api','api','verde2/api:local',[...restoredArgs,'--label','verde2.role=api']);
    await eventually(async()=>(await docker(['exec',restoredInternal,'node','-e',"require('node:https').get('https://internal:3001/health/ready',{ca:require('node:fs').readFileSync('/run/secrets/submission-ca.crt'),rejectUnauthorized:true,timeout:3000},r=>{r.resume();process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"],{quiet:true,allowFailure:true})).code===0);
    await restoredSystem('recovery-readiness');
    // Same physical spool and instance; the production readiness gate must reject
    // startup while restored dispatch is paused. Do not bypass that gate in tests.
    await docker(['rm',restoredMta],{quiet:true});
    await start('restored-mta','restored-postfix','verde2/postfix:local',[...controls,'-e','MAIL_HOSTNAME=mail.example.test','--mount',`type=volume,source=${id}-restore-spool,target=/var/spool/postfix`,...mount(join(certs,'submission.crt'),'/run/secrets/submission.crt'),...mount(join(certs,'submission.key'),'/run/secrets/submission.key')]);
    await eventually(async()=>{const state=JSON.parse((await docker(['inspect','--format','{{json .State}}',restoredMta],{quiet:true})).output);return !state.Running && state.ExitCode===1;});
    await restoredSystem('recovery-release'); // Explicit, audited synthetic test action only.
    await docker(['start',`${id}-sink`],{quiet:true});
    const sinkCounter=async()=>JSON.parse((await docker(['exec',`${id}-sink`,'python3','-c',"import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8080').read().decode())"],{quiet:true})).output).total;
    await eventually(async()=>(await docker(['exec',`${id}-sink`,'python3','-c',"import urllib.request;urllib.request.urlopen('http://127.0.0.1:8080')"],{quiet:true,allowFailure:true})).code===0);
    const receivedBefore=await sinkCounter();assert.equal(receivedBefore,0);
    await docker(['start',restoredMta],{quiet:true});
    const recoveryFixture=JSON.parse(await readFile(join(control,'fixture.json'),'utf8')).recovery;
    await eventually(async()=>{
      if((await docker(['inspect','--format','{{.State.Running}}',restoredMta],{quiet:true})).output.trim()!=='true') throw new Error('restored_mta_start_failed');
      if((await docker(['exec',restoredMta,'postfix','status'],{quiet:true,allowFailure:true})).code!==0) return false;
      const report=await docker(['exec',restoredMta,'postqueue','-j'],{quiet:true,allowFailure:true});
      if(report.code!==0) return false;
      const queues=report.stdout.trim().split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
      return queues.some(q=>q.queue_id===recoveryFixture.spoolHeld.queueId && q.queue_name==='hold') && !queues.some(q=>q.queue_id===recoveryFixture.spoolExpired.queueId);
    });
    await new Promise(resolve=>setTimeout(resolve,3000));assert.equal(await sinkCounter(),receivedBefore);
    await restoredSystem('recovery-pause');await restoredSystem('recovered');
    evidence.recovery={localMilliseconds:Date.now()-started,dispatchEnabled:false,credentialsRevoked:true,queuedOutcomeUnknown:true,expiredContentPurged:true,pendingJournalQuarantined:true,pausedMtaStartupRejected:true,explicitAuditedRestartTest:true,uncertainSpoolHeld:true,expiredSpoolRemoved:true,restartRecipientDelta:0,offVmCopyVerified:false,productionRpoRtoQualified:false};
  });
  await check('operational log redaction', async () => {
    const fixture=JSON.parse(await readFile(join(control,'fixture.json'),'utf8'));
    const emitted=[fixture.adminSecret,...Object.values(fixture.tenants).flatMap(t=>[t.full.secret,t.sendOnly.secret,t.smtp.secret,t.workerSmtp.secret]),JSON.parse(await readFile(join(control,'restored-admin.json'),'utf8')).secret];
    for (const name of containers) {
      const log = await docker(['logs', name], { quiet: true });
      if (/SYNTHETIC_REDACTION_CANARY|[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}|Bearer /i.test(log.output) || [password,redisPassword,internalToken,pepper,key,...emitted].some(value=>log.output.includes(value))) throw new Error('qualification_log_redaction_failed');
    }
  });
} catch (error) {
  resultCode = 1;
  evidence.failure = error.message.replace(/[^a-zA-Z0-9_:.-]/g, '_');
  console.error(evidence.failure);
} finally {
  for (const name of containers.reverse()) await docker(['rm', '-f', '-v', name], { quiet: true, allowFailure: true });
  await docker(['network', 'rm', network], { quiet: true, allowFailure: true });
  for(const name of ['source-spool','restore-spool']) await docker(['volume','rm',`${id}-${name}`],{quiet:true,allowFailure:true});
  for (const file of [certs, envFile, control,join(folder,'backups')]) {
    if (!resolve(file).startsWith(resolve(folder) + (process.platform === 'win32' ? '\\' : '/'))) throw new Error('qualification_cleanup_path_invalid');
    await rm(file, { recursive: true, force: true });
  }
  evidence.finishedAt = new Date().toISOString();
  evidence.status = resultCode ? 'FAIL' : 'PASS';
  await writeFile(join(folder, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(`Sanitized evidence: .qualification/${id}/evidence.json`);
  process.exitCode = resultCode;
}
