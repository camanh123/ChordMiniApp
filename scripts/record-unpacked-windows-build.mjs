/**
 * Evidence for the unpacked Windows test build.
 * Fails if an installer, publish metadata, or python_backend is present.
 * Fails if the Next production runtime is missing from this unpacked tree.
 * Missing feature strings are recorded and do not fail the build.
 *
 * CHORDMINI_UNPACKED_DIR points at a win-unpacked root (or an extracted
 * upload of that root). The default is desktop-dist/win-unpacked, which is
 * the directory electron-builder wrote, not the staging directory.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const unpacked = process.env.CHORDMINI_UNPACKED_DIR
  ? path.resolve(process.env.CHORDMINI_UNPACKED_DIR)
  : path.join(path.resolve('desktop-dist'), 'win-unpacked');
const scanRoot = process.env.CHORDMINI_UNPACKED_DIR ? unpacked : path.resolve('desktop-dist');
const exePath = path.join(unpacked, 'ChordMini.exe');
const reportDir = process.env.CHORDMINI_UNPACKED_REPORT_DIR
  ? path.resolve(process.env.CHORDMINI_UNPACKED_REPORT_DIR)
  : path.resolve('windows-unpacked-artifacts');

const standaloneRuntime = [
  { kind: 'file', relativePath: 'resources/standalone/server.js' },
  { kind: 'nonempty-file', relativePath: 'resources/standalone/.next/BUILD_ID' },
  { kind: 'file', relativePath: 'resources/standalone/.next/routes-manifest.json' },
  { kind: 'file', relativePath: 'resources/standalone/.next/prerender-manifest.json' },
  { kind: 'nonempty-dir', relativePath: 'resources/standalone/.next/server' },
  { kind: 'nonempty-dir', relativePath: 'resources/standalone/.next/static' },
  { kind: 'file', relativePath: 'resources/standalone/public/chordMiniLogo.webp' },
];

const markers = {
  'four-source-youtube': 'source.youtube',
  'four-source-soundcloud': 'source.soundcloud',
  'four-source-local-audio': 'source.localAudio',
  'four-source-microphone': 'source.microphone',
  'soundcloud-player': 'w.soundcloud.com/player/',
  'microphone-recording': 'Microphone recording is unavailable.',
  'local-history': 'Analysis history storage runs only in the desktop server context.',
  'lyrics-sync': 'OFFSET_OUT_OF_RANGE',
  'analysis-diagnostics': 'analysis-diagnostics',
  'one-click-startup': 'ChordMini is starting the local analysis service.',
  'session-safety-04a': 'createYouTubeAnalysisSession',
  'cache-readiness-04b': '/api/desktop/backend-status',
  'frontend-04d': 'Audio duration is not eligible for analysis.',
  'python-runtime-not-bundled': 'ChordMini does not bundle a Python runtime.',
};

const forbidden = [];
function walkNames(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'python_backend') {
        throw new Error(`python_backend was packaged: ${full}`);
      }
      walkNames(full);
      continue;
    }
    if (!entry.isFile()) continue;
    if (
      entry.name.startsWith('ChordMini-Setup-')
      || entry.name.endsWith('.nsis')
      || entry.name === 'latest.yml'
    ) {
      forbidden.push(full);
    }
  }
}

function assertStandaloneRuntime(unpackedRoot) {
  const failures = [];
  for (const entry of standaloneRuntime) {
    const full = path.join(unpackedRoot, entry.relativePath);
    let stat = null;
    try {
      stat = fs.statSync(full);
    } catch {
      stat = null;
    }
    if (entry.kind === 'file' || entry.kind === 'nonempty-file') {
      if (!stat || !stat.isFile()) {
        failures.push(`${entry.relativePath} is missing`);
        continue;
      }
      if (entry.kind === 'nonempty-file' && stat.size === 0) {
        failures.push(`${entry.relativePath} is empty`);
      }
      continue;
    }
    if (!stat || !stat.isDirectory() || fs.readdirSync(full).length === 0) {
      failures.push(`${entry.relativePath} is missing or empty`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Packaged Next.js production runtime is incomplete: ${failures.join('; ')}`);
  }
}

if (!fs.existsSync(unpacked)) {
  throw new Error(`${unpacked} is missing.`);
}
walkNames(scanRoot);
assertStandaloneRuntime(unpacked);
if (forbidden.length > 0) {
  throw new Error(`Installer or publish output is not allowed: ${forbidden.join(', ')}`);
}
if (!fs.existsSync(exePath)) {
  throw new Error('ChordMini.exe is missing from win-unpacked.');
}

const pending = new Map(Object.entries(markers));
const found = new Set();
function scan(dir) {
  if (pending.size === 0) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (pending.size === 0) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scan(full);
      continue;
    }
    if (!entry.isFile()) continue;
    const text = fs.readFileSync(full).toString('latin1');
    for (const [name, needle] of pending) {
      if (text.includes(needle)) found.add(name);
    }
    for (const name of found) pending.delete(name);
  }
}
scan(unpacked);

const exe = fs.readFileSync(exePath);
const hash = createHash('sha256').update(exe).digest('hex');
fs.mkdirSync(reportDir, { recursive: true });
fs.writeFileSync(
  path.join(reportDir, 'SHA256SUMS.txt'),
  `ChordMini.exe ${hash} ${exe.length}\n`,
);
const markerLines = Object.keys(markers).map((name) => `${name}\t${found.has(name)}`);
fs.writeFileSync(path.join(reportDir, 'feature-markers.tsv'), `${markerLines.join('\n')}\n`);
const rootFiles = fs.readdirSync(unpacked).filter((name) => fs.statSync(path.join(unpacked, name)).isFile());
fs.writeFileSync(path.join(reportDir, 'unpacked-root-files.txt'), `${rootFiles.join('\n')}\n`);
fs.writeFileSync(
  path.join(reportDir, 'standalone-runtime.txt'),
  `${standaloneRuntime.map((entry) => `${entry.kind}\t${entry.relativePath}\tpresent`).join('\n')}\n`,
);
console.log(`EXE_SHA256=${hash}`);
console.log(`UNPACKED_DIR=${unpacked}`);
for (const entry of standaloneRuntime) console.log(`RUNTIME ${entry.relativePath}`);
console.log(`EXE_BYTES=${exe.length}`);
for (const line of markerLines) console.log(`MARKER ${line}`);
