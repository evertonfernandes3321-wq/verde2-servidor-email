import { readdir, lstat, realpath, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, sep, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sanitizeScan } from './scan-sanitize.mjs';

const components = ['api', 'postfix', 'policy', 'opendkim', 'postgres', 'redis'];
const pick = (object, names) => Object.fromEntries(names.filter(name => object?.[name] !== undefined).map(name => [name, object[name]]));
const checks = entries => entries?.map(entry => pick(entry, ['name', 'status', 'milliseconds', 'reason']));
function loadEvidence(load) {
  if (!load) return undefined;
  return { ...pick(load, ['proof', 'clients', 'messages', 'duplicates', 'verifiedDkim', 'milliseconds', 'completionWaitLimitSeconds', 'internetDelivery']),
    quotas: Object.fromEntries(Object.entries(load.quotas || {}).filter(([, value]) => typeof value === 'number')) };
}
function publicEvidence(report) {
  if (!['PASS', 'FAIL'].includes(report.status)) throw new Error('evidence_status_invalid');
  if (Array.isArray(report.results)) return {
    ...pick(report, ['images', 'failures', 'status', 'observedAt']),
    results: report.results.map(result => ({ ...pick(result, ['image', 'qualifiedImageId', 'scanExitCode', 'sbomExitCode', 'imageId', 'secretFindings']),
      vulnerabilities: result.vulnerabilities?.map(item => pick(item, ['id', 'package', 'version', 'fixed', 'severity'])) }))
  };
  return { ...pick(report, ['id', 'scope', 'startedAt', 'finishedAt', 'status', 'head', 'branch', 'sourceDigest', 'failure', 'dependenciesNonRoot', 'postgresRestarted']),
    checks: checks(report.checks), images: pick(report.images, components),
    testImages: pick(report.testImages, ['api', 'smtp']), versions: pick(report.versions, ['node', ...components]),
    network: report.network ? pick(report.network, ['name', 'internal', 'publishedPorts']) : undefined,
    load: loadEvidence(report.load),
    recovery: report.recovery ? pick(report.recovery, ['localMilliseconds', 'dispatchEnabled', 'credentialsRevoked', 'queuedOutcomeUnknown', 'expiredContentPurged', 'pendingJournalQuarantined', 'pausedMtaStartupRejected', 'explicitAuditedRestartTest', 'uncertainSpoolHeld', 'expiredSpoolRemoved', 'restartRecipientDelta', 'offVmCopyVerified', 'productionRpoRtoQualified']) : undefined,
    reusedFrom: report.reusedFrom ? { ...pick(report.reusedFrom, ['id', 'sourceDigest']), loadProof: loadEvidence(report.reusedFrom.loadProof), builds: checks(report.reusedFrom.builds) } : undefined
  };
}

// Never recurse into candidate sources, certificates, fixtures or .private.
// An ordinary output directory also avoids upload-artifact's hidden-file default.
export async function exportCiEvidence(input, output) {
  const base = await realpath(input);
  if ((await lstat(input)).isSymbolicLink()) throw new Error('evidence_input_symlink');
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await mkdir(output, { mode: 0o700 }); // Refuse stale exports instead of merging them.
  let count = 0;
  async function directory(path) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('evidence_directory_invalid');
    if (!(await realpath(path)).startsWith(base + sep)) throw new Error('evidence_path_invalid');
  }
  async function publish(folder, name, relativeFolder, kind) {
    const file = join(folder, name);
    let info;
    try { info = await lstat(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('evidence_file_invalid');
    if (!(await realpath(file)).startsWith(base + sep)) throw new Error('evidence_path_invalid');
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    let data = parsed;
    if (kind === 'scan') data = sanitizeScan(parsed);
    else if (kind === 'sbom') {
      if (parsed.bomFormat !== 'CycloneDX' || !Array.isArray(parsed.components)) throw new Error('evidence_sbom_invalid');
      data = { bomFormat: parsed.bomFormat, specVersion: parsed.specVersion, version: parsed.version,
        components: parsed.components.map(item => ({ type: item.type, name: item.name,
          version: item.version, purl: item.purl, hashes: item.hashes?.map(hash => ({ alg: hash.alg, content: hash.content })) })) };
    } else if (kind === 'manifest') {
      if (!Array.isArray(parsed) || parsed.some(item => typeof item.path !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256))) throw new Error('evidence_manifest_invalid');
      data = parsed.map(item => ({ path: item.path, sha256: item.sha256 }));
    } else data = publicEvidence(parsed);
    const target = join(output, relativeFolder);
    await mkdir(target, { recursive: true, mode: 0o700 });
    await writeFile(join(target, name), JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 });
    count++;
  }
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (/^verde2-qualify-[0-9]+-[0-9]+$/.test(entry.name)) {
      const folder = join(base, entry.name);
      await directory(folder);
      await publish(folder, 'evidence.json', entry.name, 'evidence');
      await publish(folder, 'source-manifest.json', entry.name, 'manifest');
    } else if (entry.name === 'scans') {
      const scans = join(base, entry.name);
      await directory(scans);
      for (const run of await readdir(scans, { withFileTypes: true })) {
        if (!/^[0-9]+$/.test(run.name)) continue;
        const folder = join(scans, run.name);
        await directory(folder);
        await publish(folder, 'evidence.json', join('scans', run.name), 'evidence');
        for (const component of components) {
          for (const kind of ['scan', 'sbom']) await publish(folder, `verde2-${component}-local-${kind}.json`, join('scans', run.name), kind);
        }
      }
    }
  }
  if (!count) throw new Error('evidence_export_empty');
  return count;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const count = await exportCiEvidence(resolve('.qualification'), resolve('artifacts/ci-evidence'));
    console.log(`Sanitized evidence exported: ${count} files`);
  } catch {
    console.error('sanitized_evidence_export_failed');
    process.exitCode = 1;
  }
}
