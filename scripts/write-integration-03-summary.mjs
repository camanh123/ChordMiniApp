/**
 * Write a non-sensitive INTEGRATION-03 summary.
 * Usage: node scripts/write-integration-03-summary.mjs <artifact-dir> <source-sha>
 * Omits install paths, environment values, and absolute machine paths.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const CHECK_NAMES = [
  'install',
  'packagedDependencies',
  'windowRender',
  'staticAssets',
  'musicUi',
  'serverStartup',
  'security',
  'audioInput',
  'localPlayback',
  'analysisService',
  'settingsPersistence',
  'localePersistence',
  'localGame',
  'singleInstance',
  'processCleanup',
  'uninstall',
  'applicationLaunch',
  'playwrightConnection',
];

export function buildIntegration03Summary(artifactDir, sourceSha) {
  const acceptance = readJson(path.join(artifactDir, 'packaged-report.json'));
  const metadata = readJson(path.join(artifactDir, 'build-metadata.json'));
  const inspection = readJson(path.join(artifactDir, 'nsis-inspection.json'));
  const staged = readJson(path.join(artifactDir, 'staged-scan.json'));
  const unpacked = readJson(path.join(artifactDir, 'unpacked-scan.json'));
  const nsisScan = readJson(path.join(artifactDir, 'nsis-payload-scan.json'));
  const checks = {};
  for (const name of CHECK_NAMES) {
    const value = acceptance?.checks?.[name];
    checks[name] = value && value.pass === true ? 'PASS' : (value ? 'FAIL' : 'NOT_RUN');
  }
  return {
    sourceSha: sourceSha || metadata?.commit || null,
    installerName: metadata?.filename || null,
    installerBytes: Number.isFinite(metadata?.bytes) ? metadata.bytes : null,
    installerSha256: metadata?.sha256 || null,
    signed: metadata?.signed === true,
    autoUpdate: metadata?.autoUpdate === true,
    pythonBundled: metadata?.pythonBundled === true,
    acceptanceStatus: acceptance?.status || 'MISSING',
    checks,
    stagingScanFindingCount: countFindings(staged),
    unpackedScanFindingCount: countFindings(unpacked),
    unpackedArchiveCoverage: archiveList(unpacked),
    nsisListedBy7Zip: inspection?.listed === true,
    nsisExtractedBy7Zip: inspection?.extracted === true,
    nsisAppAsarFound: inspection?.appAsarFound === true,
    nsisPayloadScanFindingCount: countFindings(nsisScan),
    nsisPayloadArchiveCoverage: archiveList(nsisScan),
    scannerNsisFlag: nsisScan?.nsisPayloadInspected === true,
  };
}

function countFindings(report) {
  return Number.isInteger(report?.findingCount) ? report.findingCount : null;
}

function archiveList(report) {
  return Array.isArray(report?.archiveCoverage) ? report.archiveCoverage.slice(0, 20) : [];
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function main() {
  const artifactDir = path.resolve(process.argv[2] || '');
  const sourceSha = process.argv[3] || '';
  if (!artifactDir || !fs.existsSync(artifactDir)) {
    console.error('Usage: node scripts/write-integration-03-summary.mjs <artifact-dir> <source-sha>');
    process.exit(2);
  }
  const summary = buildIntegration03Summary(artifactDir, sourceSha);
  const destination = path.join(artifactDir, 'acceptance-summary.json');
  fs.writeFileSync(destination, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`Wrote ${destination}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
