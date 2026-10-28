/**
 * Evidence for the unpacked Windows test build.
 * Fails if an installer, publish metadata, or python_backend is present.
 * Missing feature strings are recorded and do not fail the build.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('desktop-dist');
const unpacked = path.join(root, 'win-unpacked');
const exePath = path.join(unpacked, 'ChordMini.exe');
const reportDir = path.resolve('windows-unpacked-artifacts');

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

if (!fs.existsSync(unpacked)) {
  throw new Error('desktop-dist/win-unpacked is missing.');
}
walkNames(root);
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
console.log(`EXE_SHA256=${hash}`);
console.log(`EXE_BYTES=${exe.length}`);
for (const line of markerLines) console.log(`MARKER ${line}`);
