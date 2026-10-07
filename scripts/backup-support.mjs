import { spawn } from 'node:child_process';
import { resolve, sep } from 'node:path';
import { lstat } from 'node:fs/promises';
export function required(name, env = process.env) { if (!env[name]) throw new Error('required_' + name); return env[name]; }
const safeOperationCodes=new Set(['restore_spool_not_empty','restore_spool_entry_invalid','restore_spool_path_invalid','restore_spool_entry_oversized','restore_spool_permissions_invalid','restore_journal_invalid']);
export function operationFailure(stderr,code) {
  const error=new Error('docker_operation_failed');
  error.exitCode=Number.isInteger(code)?code:null;
  error.safeCode=String(stderr).split(/\r?\n/).map(line=>line.trim()).find(line=>safeOperationCodes.has(line));
  return error;
}
export function processCommand(args, input, { streamInput = false } = {}) {
  const child = spawn('docker', args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let errorOutput = '';
  child.stderr.on('data', chunk => { if (errorOutput.length < 1000) errorOutput = (errorOutput + chunk).slice(0,1000); });
  child.completion = new Promise((done, fail) => { child.on('error', fail); child.on('close', code => code === 0 ? done() : fail(operationFailure(errorOutput,code))); });
  // Always attach a rejection handler while streaming, then await completion explicitly.
  child.completion.catch(() => {});
  if (input !== undefined) child.stdin.end(input); else if (!streamInput) child.stdin.end();
  return child;
}
export async function capture(args, input) {
  const child = processCommand(args, input); let output = '';
  for await (const chunk of child.stdout) { output += chunk; if (output.length > 10000000) { child.kill(); throw new Error('operation_output_too_large'); } }
  await child.completion;
  return output;
}
export async function inspectContainer(name, namespace, env = process.env) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,200}$/.test(name)) throw new Error('container_name_invalid');
  const item = JSON.parse(await capture(['container', 'inspect', name]))[0];
  const labels = item.Config.Labels || {};
  const synthetic = env.OPERATIONS_SCOPE === 'synthetic';
  if (synthetic) {
    if (labels['verde2.qualification'] !== namespace || !namespace.startsWith('verde2-')) throw new Error('synthetic_resource_mismatch');
    for (const network of Object.keys(item.NetworkSettings.Networks)) {
      if (!JSON.parse(await capture(['network', 'inspect', network]))[0].Internal) throw new Error('restore_egress_not_blocked');
    }
  } else if (env.OPERATIONS_SCOPE !== 'authorized-operations' || labels['com.docker.compose.project'] !== namespace) throw new Error('operations_scope_invalid');
  return item;
}
export async function enforceBarrier(namespace,env=process.env) {
  const label=env.OPERATIONS_SCOPE==='synthetic'?'verde2.qualification':'com.docker.compose.project';
  const names=(await capture(['ps','-a','--filter',`label=${label}=${namespace}`,'--format','{{.Names}}'])).trim().split(/\r?\n/).filter(Boolean);
  const roles=[];
  for(const name of names) {
    const item=await inspectContainer(name,namespace,env);
    const role=item.Config.Labels['verde2.role'] || item.Config.Labels['com.docker.compose.service'];
    if(['api','worker','internal'].includes(role)) {
      if(item.State.Running) throw new Error('operation_consumers_must_be_stopped');
      roles.push(role);
    }
  }
  if(!['api','worker','internal'].every(role=>roles.includes(role))) throw new Error('operation_barrier_incomplete');
}
export async function acquireRestoreLock(name,item) {
  const {user,database}=postgresArgs(item);
  const child=processCommand(['exec','-i',name,'psql','-U',user,'-d',database,'-At','-v','ON_ERROR_STOP=1'],undefined,{streamInput:true});
  const result=new Promise((done,fail)=>{
    let data='';
    const timer=setTimeout(()=>{child.kill();fail(new Error('restore_lock_timeout'));},10000);
    child.stdout.on('data',chunk=>{
      data+=chunk;
      if(data.includes('\n')) {clearTimeout(timer);data.trim()==='t'?done():fail(new Error('restore_target_busy'));}
    });
    child.completion.catch(()=>{clearTimeout(timer);fail(new Error('restore_lock_failed'));});
  });
  child.stdin.write('SELECT pg_try_advisory_lock(741102499);\n');
  try {await result;}
  catch(error){child.stdin.end('\\q\n');await child.completion.catch(()=>{});throw error;}
  return async()=>{child.stdin.end('\\q\n');await child.completion;};
}
export function postgresArgs(item) {
  const values = Object.fromEntries(item.Config.Env.map(value => { const i = value.indexOf('='); return [value.slice(0, i), value.slice(i + 1)]; }));
  const user = values.POSTGRES_USER, database = values.POSTGRES_DB;
  if (!/^[a-zA-Z0-9_]{1,63}$/.test(user) || !/^[a-zA-Z0-9_]{1,63}$/.test(database)) throw new Error('postgres_identity_invalid');
  return { user, database };
}
export async function sql(name, item, statement) {
  const { user, database } = postgresArgs(item);
  return capture(['exec', '-i', name, 'psql', '-U', user, '-d', database, '-At', '-v', 'ON_ERROR_STOP=1'], statement);
}
export function within(directory, file) {
  const target = resolve(directory, file);
  if (!target.startsWith(resolve(directory) + sep)) throw new Error('backup_path_invalid');
  return target;
}
export async function regular(file) { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink()) throw new Error('backup_file_invalid'); }
