export function sanitizeScan(report) {
  if (!report || !Array.isArray(report.Results)) throw new Error("scanner_report_invalid");
  return {SchemaVersion:report.SchemaVersion,Metadata:{ImageID:report.Metadata?.ImageID},Results:(report.Results||[]).map(result=>({
      Target:result.Target,Class:result.Class,Type:result.Type,
      Vulnerabilities:(result.Vulnerabilities||[]).map(v=>({VulnerabilityID:v.VulnerabilityID,PkgName:v.PkgName,InstalledVersion:v.InstalledVersion,FixedVersion:v.FixedVersion,Severity:v.Severity})),
      Secrets:(result.Secrets||[]).map(s=>({RuleID:s.RuleID,Category:s.Category,Severity:s.Severity,StartLine:s.StartLine,EndLine:s.EndLine,Match:'[REDACTED]'}))
    }))};
}
