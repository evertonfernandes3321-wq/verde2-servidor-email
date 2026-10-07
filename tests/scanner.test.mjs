import test from 'node:test';
import assert from 'node:assert/strict';
import {sanitizeScan} from '../scripts/scan-sanitize.mjs';
test('scanner publication omits raw matches, snippets and unrecognized fields',()=>{
 const canary='SYNTHETIC_SCAN_REDACTION_CANARY';
 const source={SchemaVersion:2,FutureField:canary,Metadata:{ImageID:'sha256:synthetic',Other:canary},Results:[{Target:'/app/package.json',Vulnerabilities:[{VulnerabilityID:'SYNTHETIC-1',PkgName:'synthetic',InstalledVersion:'1',Severity:'HIGH',Description:canary}],Secrets:[{RuleID:'synthetic',Severity:'HIGH',Match:canary,Code:{Lines:[canary]},FutureField:canary}]}]};
 const sanitized=sanitizeScan(source),serialized=JSON.stringify(sanitized);
 assert.ok(!serialized.includes(canary));assert.equal(sanitized.Results[0].Secrets[0].Match,'[REDACTED]');assert.equal(sanitized.Results[0].Vulnerabilities[0].VulnerabilityID,'SYNTHETIC-1');
 assert.throws(()=>sanitizeScan({}),/scanner_report_invalid/);
});
