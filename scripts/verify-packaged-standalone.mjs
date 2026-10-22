/**
 * Prove a staged or unpacked Next standalone tree can load its production
 * dependencies without the repository node_modules.
 *
 * Usage:
 *   node scripts/verify-packaged-standalone.mjs <standalone-dir> <report.json> [--boot]
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const standaloneDir = path.resolve(process.argv[2] || '');
const reportPath = path.resolve(process.argv[3] || '');
const boot = process.argv.includes('--boot');

if (!standaloneDir || !reportPath) {
  console.error('Usage: node scripts/verify-packaged-standalone.mjs <standalone-dir> <report.json> [--boot]');
  process.exit(2);
}

const report = {
  standaloneDir,
  boot,
  status: 'FAIL',
  resolutions: [],
  server: null,
  error: '',
};

try {
  const compiled = path.join(repoRoot, 'electron', 'dist', 'standalonePackage.js');
  if (!fs.existsSync(compiled)) {
    throw new Error('Desktop package checker is not compiled. Run npm run desktop:compile.');
  }
  const checker = require(compiled);
  report.resolutions = checker.verifyStandaloneResolution(standaloneDir);
  if (boot) {
    report.server = await checker.bootStandaloneServer(standaloneDir);
  }
  report.status = 'PASS';
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Standalone runtime dependencies resolved inside ${standaloneDir}`);
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.error(report.error);
  process.exit(1);
}
