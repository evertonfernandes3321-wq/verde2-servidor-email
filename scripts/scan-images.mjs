import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeScan } from './scan-sanitize.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, '.qualification', 'scans',String(Date.now()));
const scanner = 'aquasec/trivy:0.74.0@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969';
const images = ['verde2/api:local', 'verde2/postfix:local', 'verde2/policy:local', 'verde2/opendkim:local', 'verde2/postgres:local', 'verde2/redis:local'];
function docker(args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn('docker', args, { cwd: root, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let data = '';
    child.stdout.on('data', chunk => { data += chunk; });
    child.stderr.on('data', () => {}); // Raw tool diagnostics stay private.
    child.on('error', reject);
    child.on('close', code => resolveResult({ code, output: data }));
  });
}
await mkdir(output, { recursive: true, mode: 0o700 });
// Raw scanner output never matches the CI artifact globs. Publish only host-owned
// files written after successful parsing/sanitization, including on failed gates.
const privateOutput=join(output,'.private');
await mkdir(privateOutput,{mode:0o700});
let failures = 0;
const results=[];
for (const image of images) {
  const name = image.split('@')[0].replace(/[^a-z0-9]/gi, '-');
  const inspected=await docker(['image','inspect',image]);
  if(inspected.code) throw new Error('image_inspection_failed');
  const qualifiedImageId=JSON.parse(inspected.output)[0].Id;
  if(!/^sha256:[a-f0-9]{64}$/.test(qualifiedImageId)) throw new Error('image_identity_invalid');
  console.log(`Security scan: ${image}`);
  const tar = join(privateOutput, `${name}.tar`);
  const saved = await docker(['image', 'save', '-o', tar, qualifiedImageId]);
  if (saved.code) throw new Error('image_export_failed');
  const common = ['run', '--rm', '--mount', `type=bind,source=${privateOutput},target=/data`, '--mount', 'type=volume,source=verde2-trivy-cache,target=/root/.cache', scanner, 'image', '--input', `/data/${name}.tar`];
  const scan = await docker([...common, '--scanners', 'vuln,secret', '--severity', 'HIGH,CRITICAL', '--exit-code', '1', '--format', 'json', '--output', `/data/${name}.raw`]);
  failures += scan.code === 0 ? 0 : 1;
  // Scanner matches/snippets may themselves contain a secret. Keep the finding, redact its value.
  const reportPath=join(privateOutput,`${name}.raw`);
  let report;
  try {
    report=JSON.parse(await readFile(reportPath,'utf8'));
    // Allowlist findings: even additional future scanner fields cannot publish
    // source snippets or matched secrets. Detailed vulnerability descriptions
    // are unnecessary for the mandatory gate evidence.
    const sanitized=sanitizeScan(report);
    await writeFile(join(output,`${name}-scan.json`),JSON.stringify(sanitized,null,2),{flag:'wx',mode:0o600});
  } catch {failures++;}
  const sbom = await docker([...common, '--format', 'cyclonedx', '--output', `/data/${name}.sbom.raw`]);
  if (sbom.code) failures++;
  else try {const parsed=JSON.parse(await readFile(join(privateOutput,`${name}.sbom.raw`),'utf8'));if(parsed.bomFormat!=='CycloneDX') throw new Error('sbom_invalid');await writeFile(join(output,`${name}-sbom.json`),JSON.stringify(parsed,null,2),{flag:'wx',mode:0o600});} catch {failures++;}
  results.push({image,qualifiedImageId,scanExitCode:scan.code,sbomExitCode:sbom.code,imageId:report?.Metadata?.ImageID,vulnerabilities:(report?.Results||[]).flatMap(result=>(result.Vulnerabilities||[]).map(v=>({id:v.VulnerabilityID,package:v.PkgName,version:v.InstalledVersion,fixed:v.FixedVersion||null,severity:v.Severity}))),secretFindings:(report?.Results||[]).reduce((sum,r)=>sum+(r.Secrets||[]).length,0)});
  await rm(tar,{force:true});
  for(const file of [`${name}.raw`,`${name}.sbom.raw`]) await rm(join(privateOutput,file),{force:true});
  console.log(`Security scan result: ${image} ${scan.code === 0 ? 'PASS' : 'FAIL'}`);
}
await writeFile(join(output, 'evidence.json'), JSON.stringify({ images, results,failures, status: failures ? 'FAIL' : 'PASS', observedAt: new Date().toISOString() }, null, 2));
console.log('Sanitized scan evidence: '+output.replace(root,''));
process.exitCode = failures ? 1 : 0;
