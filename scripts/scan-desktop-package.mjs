/**
 * Fail when a desktop staging directory or unpacked installer contains secrets,
 * Python models, or environment files. Usage:
 * node scripts/scan-desktop-package.mjs <directory> <report.json>
 */
import fs from 'fs';
import path from 'path';

const root = path.resolve(process.argv[2] || '');
const reportPath = path.resolve(process.argv[3] || '');
if (!root || !reportPath || !fs.existsSync(root)) {
  console.error('Usage: node scripts/scan-desktop-package.mjs <directory> <report.json>');
  process.exit(2);
}

const CONTENT_EXTENSIONS = new Set(['.json', '.txt', '.yml', '.yaml', '.env', '.pem', '.key']);
const SECRET_CONTENT = /BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY|"type"\s*:\s*"service_account"|FIREBASE_SERVICE_ACCOUNT_KEY\s*=/;
const findings = [];

function consider(filePath, directoryEntry) {
  const relative = path.relative(root, filePath);
  const base = path.basename(filePath);
  const segments = relative.split(path.sep);
  if (base === '.env' || base.startsWith('.env.') || segments.includes('python_backend')) {
    findings.push({ path: relative, reason: 'excluded-asset' });
  }
  if (/serviceAccount|firebase-adminsdk/i.test(base) || ['.pem', '.key', '.pt', '.onnx', '.safetensors', '.ckpt'].includes(path.extname(base).toLowerCase())) {
    findings.push({ path: relative, reason: 'credential-or-model' });
  }
  if (!directoryEntry.isFile() || segments.includes('node_modules')) {
    return;
  }
  const extension = path.extname(base).toLowerCase();
  if (!CONTENT_EXTENSIONS.has(extension) || directoryEntry.size > 1_000_000) {
    return;
  }
  const text = fs.readFileSync(filePath, 'utf8');
  if (SECRET_CONTENT.test(text)) {
    findings.push({ path: relative, reason: 'secret-content' });
  }
}

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      consider(fullPath, entry);
      walk(fullPath);
      continue;
    }
    if (entry.isFile()) {
      consider(fullPath, entry);
    }
  }
}

walk(root);
const report = {
  root,
  scannedAt: new Date().toISOString(),
  findingCount: findings.length,
  findings: findings.slice(0, 50),
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
if (findings.length > 0) {
  console.error(`Desktop package scan found ${findings.length} blocked path(s).`);
  process.exit(1);
}
console.log(`Desktop package scan found no secrets or model checkpoints in ${root}`);
