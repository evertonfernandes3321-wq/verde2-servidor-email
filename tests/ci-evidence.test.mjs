import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportCiEvidence } from '../scripts/export-ci-evidence.mjs';
async function removeOwnedFixture(root) {
  assert.ok(root.startsWith(join(tmpdir(), 'verde2-ci-')));
  await rm(root, { recursive: true, force: true });
}

test('CI exports failed evidence while excluding private/source files and scanner snippets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'verde2-ci-'));
  try {
    const input = join(root, 'input'), output = join(root, 'new-artifacts', 'output');
    const qualification = join(input, 'verde2-qualify-1-1'), scan = join(input, 'scans', '1');
    await mkdir(join(qualification, 'source', 'nested'), { recursive: true });
    await mkdir(join(scan, '.private'), { recursive: true });
    await writeFile(join(qualification, 'evidence.json'), JSON.stringify({ status: 'FAIL', checks: [{name:'synthetic',status:'FAIL',debug:'PRIVATE_DEBUG'}], future: 'PRIVATE_FUTURE' }));
    await writeFile(join(qualification, 'source-manifest.json'), JSON.stringify([{ path: 'api/src/index.js', sha256: 'a'.repeat(64) }]));
    await writeFile(join(qualification, 'source', 'nested', 'evidence.json'), 'PRIVATE_SOURCE');
    await writeFile(join(qualification, 'fixture.env'), 'PRIVATE_FIXTURE');
    await writeFile(join(scan, '.private', 'evidence.json'), 'PRIVATE_SCAN');
    await writeFile(join(scan, 'verde2-api-local-scan.json'), JSON.stringify({ Results: [{ Secrets: [{ Match: 'PRIVATE_MATCH', Extra: 'PRIVATE_EXTRA' }] }], Future: 'PRIVATE_FIELD' }));
    await writeFile(join(scan, 'verde2-api-local-sbom.json'), JSON.stringify({ bomFormat: 'CycloneDX', components: [{ name: 'synthetic', version: '1', properties: [{ value: 'PRIVATE_PROPERTY' }] }], metadata: { secret: 'PRIVATE_METADATA' } }));
    assert.equal(await exportCiEvidence(input, output), 4);
    assert.deepEqual(await readdir(join(output, 'verde2-qualify-1-1')), ['evidence.json', 'source-manifest.json']);
    const publishedScan = await readFile(join(output, 'scans', '1', 'verde2-api-local-scan.json'), 'utf8');
    const publishedSbom = await readFile(join(output, 'scans', '1', 'verde2-api-local-sbom.json'), 'utf8');
    assert.equal(publishedScan.includes('PRIVATE_'), false);
    assert.equal(publishedSbom.includes('PRIVATE_'), false);
    assert.equal((await readFile(join(output, 'verde2-qualify-1-1', 'evidence.json'), 'utf8')).includes('PRIVATE_'), false);
    assert.equal(publishedScan.includes('[REDACTED]'), true);
    assert.equal(JSON.parse(await readFile(join(output, 'verde2-qualify-1-1', 'evidence.json'))).status, 'FAIL');
    await assert.rejects(exportCiEvidence(input, output));
  } finally { await removeOwnedFixture(root); }
});

test('CI refuses evidence symlinks and empty exports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'verde2-ci-'));
  try {
    const input = join(root, 'input'), folder = join(input, 'verde2-qualify-1-1');
    await mkdir(folder, { recursive: true });
    await assert.rejects(exportCiEvidence(input, join(root, 'empty')), /evidence_export_empty/);
    const external = join(root, 'external.json');
    await writeFile(external, JSON.stringify({ status: 'PASS' }));
    // Windows junctions are also supported without symlink privileges.
    const linkInput = join(root, 'link-input');
    await mkdir(linkInput);
    await symlink(folder, join(linkInput, 'verde2-qualify-1-1'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(exportCiEvidence(linkInput, join(root, 'linked')), /evidence_directory_invalid/);
  } finally { await removeOwnedFixture(root); }
});
