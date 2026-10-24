/**
 * Fail closed when a desktop staging directory or unpacked tree contains
 * secrets, restricted model assets, or an ffmpeg-static binary distribution.
 *
 * Usage:
 *   node scripts/scan-desktop-package.mjs <directory> <report.json>
 *
 * Matching policy:
 * - Existing rules stay in force. `.env` files and any `python_backend`
 *   directory are `excluded-asset`. Names matching serviceAccount or
 *   firebase-adminsdk, and extensions `.pem`, `.key`, `.pt`, `.onnx`,
 *   `.safetensors`, and `.ckpt`, are `credential-or-model`. JSON, text, and
 *   YAML files up to 1 MB outside `node_modules` are scanned for a private
 *   key or a Firebase service-account document (`secret-content`).
 * - Extensions alone are not the whole policy. Recognizable paths and
 *   basenames identify Madmom beat pickles, Chord-CNN-LSTM `.sdict` and
 *   `cross_weight` pickles, Beat-Transformer `trf_param` checkpoints, and
 *   SongFormer / MuQ / MusicFM checkpoint files.
 * - `.h5` and `.hdf5` are unapproved model containers in this payload.
 *   Harmless text, JSON, SVG, and a pickle outside those model paths are
 *   not rejected. A document named `madmom-overview.txt` is not a Madmom
 *   directory. Symbolic links are not followed.
 * - `ffmpeg-static` is rejected when its package directory is present, or
 *   when a file named `ffmpeg` or `ffmpeg.exe` has ELF, PE, or Mach-O
 *   bytes. A text note that mentions ffmpeg-static is not a binary.
 * - `lamejs` is inventoried and is not a reject rule. LGPL obligations do
 *   not disappear because this scanner does not execute it.
 * - `.asar` payloads and stored or deflated `.zip` members are scanned in
 *   memory, including one level of nesting. An unreadable archive fails
 *   the scan. An NSIS installer (`NullsoftInst`) is reported and rejected
 *   because this scanner does not list its payload. A directory scan never
 *   sets `nsisPayloadInspected`.
 * - Prohibited files are reported and left in place.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const CONTENT_EXTENSIONS = new Set(['.json', '.txt', '.yml', '.yaml', '.env', '.pem', '.key']);
const LEGACY_MODEL_EXTENSIONS = new Set(['.pem', '.key', '.pt', '.onnx', '.safetensors', '.ckpt']);
const MODEL_CONTAINER_EXTENSIONS = new Set(['.h5', '.hdf5', '.sdict']);
const DATA_EXTENSIONS = new Set(['.pkl', '.npy', '.npz', '.mat']);
const SECRET_CONTENT = /BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY|"type"\s*:\s*"service_account"|FIREBASE_SERVICE_ACCOUNT_KEY\s*=/;
const MAX_CONTENT_BYTES = 1_000_000;
const MAX_ARCHIVE_ENTRIES = 250_000;
const MAX_WALK_ENTRIES = 250_000;
const MAX_ARCHIVE_DEPTH = 4;
const MAX_HEADER_BYTES = 32_000_000;

const MADMOM_NAMES = /^beats_blstm_\d+\.pkl$/i;
const CHORD_PICKLES = /^cross_(?:subpart_)?weight\d+\.pkl$/i;
const CHORD_SDICT = /^joint_chord_net.*\.sdict$/i;

export function scanDesktopPackage(root, options = {}) {
  const absoluteRoot = path.resolve(root);
  const findings = [];
  const archivesOpened = [];
  const seen = new Set();
  let walked = 0;
  let nsisCandidates = 0;

  function add(relativePath, reason) {
    const sanitized = sanitizeRelative(relativePath);
    const key = `${reason}\0${sanitized}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ path: sanitized, reason });
  }

  function scanEntry(relativePath, entry) {
    const base = path.posix.basename(relativePath);
    const segments = relativePath.split('/').filter(Boolean);
    const extension = path.posix.extname(base).toLowerCase();
    const lowerSegments = new Set(segments.map((segment) => segment.toLowerCase()));

    if (base === '.env' || base.startsWith('.env.') || segments.includes('python_backend')) {
      add(relativePath, 'excluded-asset');
    }
    if (/serviceAccount|firebase-adminsdk/i.test(base) || LEGACY_MODEL_EXTENSIONS.has(extension)) {
      add(relativePath, 'credential-or-model');
    }
    if (MODEL_CONTAINER_EXTENSIONS.has(extension)) {
      add(relativePath, extension === '.sdict' ? 'chord-checkpoint' : 'model-asset');
    }
    if (isMadmomModel(relativePath, base, extension, lowerSegments)) {
      add(relativePath, 'madmom-model');
    }
    if (isChordCheckpoint(base, extension, lowerSegments)) {
      add(relativePath, 'chord-checkpoint');
    }
    if (isBeatTransformerCheckpoint(base, extension, lowerSegments)) {
      add(relativePath, 'beat-transformer-checkpoint');
    }
    if (isSongFormerCheckpoint(base, extension, lowerSegments)) {
      add(relativePath, 'songformer-checkpoint');
    }
    if (isFfmpegStatic(relativePath, base, entry)) {
      add(relativePath, 'ffmpeg-static-binary');
    }
    if (entry.kind === 'file' && isNsisPayload(base, entry)) {
      nsisCandidates += 1;
      add(relativePath, 'uninspected-nsis-payload');
    }
  }

  function considerFile(relativePath, absolutePath) {
    const size = fs.statSync(absolutePath).size;
    scanEntry(relativePath, {
      kind: 'file',
      size,
      absolutePath,
    });
    const segments = relativePath.split('/');
    if (segments.includes('node_modules')) return;
    const extension = path.posix.extname(relativePath).toLowerCase();
    if (!CONTENT_EXTENSIONS.has(extension) || size > MAX_CONTENT_BYTES) return;
    const text = fs.readFileSync(absolutePath, 'utf8');
    if (SECRET_CONTENT.test(text)) add(relativePath, 'secret-content');
  }

  function walk(directory, prefix) {
    for (const directoryEntry of fs.readdirSync(directory, { withFileTypes: true })) {
      walked += 1;
      if (walked > MAX_WALK_ENTRIES) {
        add(prefix || '.', 'scan-limit');
        return;
      }
      if (directoryEntry.isSymbolicLink()) continue;
      const absolutePath = path.join(directory, directoryEntry.name);
      const relativePath = prefix ? `${prefix}/${directoryEntry.name}` : directoryEntry.name;
      if (directoryEntry.isDirectory()) {
        scanEntry(relativePath, { kind: 'directory' });
        walk(absolutePath, relativePath);
        continue;
      }
      if (!directoryEntry.isFile()) continue;
      considerFile(relativePath, absolutePath);
      const lowerName = directoryEntry.name.toLowerCase();
      if (lowerName.endsWith('.asar')) {
        scanAsar(absolutePath, relativePath, 1);
      } else if (lowerName.endsWith('.zip')) {
        const size = fs.statSync(absolutePath).size;
        if (size > 64_000_000) add(relativePath, 'unreadable-archive');
        else scanZip(fs.readFileSync(absolutePath), relativePath, 1);
      }
    }
  }

  function scanAsar(absolutePath, archivePath, depth) {
    if (depth > MAX_ARCHIVE_DEPTH) {
      add(archivePath, 'unreadable-archive');
      return;
    }
    let header;
    let headerSize;
    try {
      const opened = readAsarHeader(absolutePath);
      header = opened.header;
      headerSize = opened.headerSize;
      archivesOpened.push(sanitizeRelative(archivePath));
    } catch {
      add(archivePath, 'unreadable-archive');
      return;
    }
    const files = [];
    collectAsarFiles(header.files || {}, '', files);
    if (files.length > MAX_ARCHIVE_ENTRIES) {
      add(archivePath, 'scan-limit');
      return;
    }
    for (const file of files) {
      const virtualPath = `${archivePath}!/${file.name}`;
      scanEntry(virtualPath, {
        kind: 'file',
        size: file.size,
        bytes: () => readAsarFile(absolutePath, headerSize, file),
      });
      const extension = path.posix.extname(file.name).toLowerCase();
      if (
        file.name.split('/').includes('node_modules')
        || !CONTENT_EXTENSIONS.has(extension)
        || file.size > MAX_CONTENT_BYTES
      ) {
        continue;
      }
      try {
        const text = readAsarFile(absolutePath, headerSize, file).toString('utf8');
        if (SECRET_CONTENT.test(text)) add(virtualPath, 'secret-content');
      } catch {
        add(virtualPath, 'unreadable-archive');
      }
      if (extension === '.zip' && depth < MAX_ARCHIVE_DEPTH) {
        try {
          scanZip(readAsarFile(absolutePath, headerSize, file), virtualPath, depth + 1);
        } catch {
          add(virtualPath, 'unreadable-archive');
        }
      }
    }
  }

  function scanZip(buffer, archivePath, depth) {
    if (depth > MAX_ARCHIVE_DEPTH) {
      add(archivePath, 'unreadable-archive');
      return;
    }
    let entries;
    try {
      entries = listZipEntries(buffer);
      archivesOpened.push(sanitizeRelative(archivePath));
    } catch {
      add(archivePath, 'unreadable-archive');
      return;
    }
    if (entries.length > MAX_ARCHIVE_ENTRIES) {
      add(archivePath, 'scan-limit');
      return;
    }
    for (const entry of entries) {
      const virtualPath = `${archivePath}!/${entry.name}`;
      scanEntry(virtualPath, { kind: 'file', size: entry.bytes.length, bytes: () => entry.bytes });
      const extension = path.posix.extname(entry.name).toLowerCase();
      if (!entry.name.split('/').includes('node_modules') && CONTENT_EXTENSIONS.has(extension) && entry.bytes.length <= MAX_CONTENT_BYTES) {
        if (SECRET_CONTENT.test(entry.bytes.toString('utf8'))) add(virtualPath, 'secret-content');
      }
      if (extension === '.asar' && depth < MAX_ARCHIVE_DEPTH) {
        const nested = path.join(os.tmpdir(), `chordmini-scan-${process.pid}-${depth}.asar`);
        try {
          fs.writeFileSync(nested, entry.bytes);
          scanAsar(nested, virtualPath, depth + 1);
        } catch {
          add(virtualPath, 'unreadable-archive');
        } finally {
          fs.rmSync(nested, { force: true });
        }
      }
    }
  }

  if (fs.existsSync(absoluteRoot) && fs.statSync(absoluteRoot).isDirectory()) {
    walk(absoluteRoot, '');
  }

  const report = {
    root: sanitizeRootLabel(absoluteRoot, options.cwd || process.cwd()),
    scannedAt: new Date().toISOString(),
    scanScope: 'directory-tree',
    nsisPayloadInspected: false,
    archiveCoverage: archivesOpened,
    claim: 'This report does not establish that an NSIS payload is free of prohibited assets.',
    findingCount: findings.length,
    findings: findings.slice(0, 50),
    dependencyInventory: collectRepoDependencyEvidence(options.repoRoot || process.cwd(), absoluteRoot),
    licenseNoticeStatus: {
      applicationLicense: 'MIT',
      thirdPartyNoticeAdded: false,
      statement: 'A missing import does not cancel GPL-3.0-or-later or LGPL-3.0 obligations if the corresponding bytes are distributed.',
    },
  };
  if (nsisCandidates > 0) {
    report.nsisPayloadInspected = false;
  }
  return report;
}

export function collectRepoDependencyEvidence(repoRoot, scannedRoot) {
  const ffmpegListed = readListedDependency(repoRoot, 'ffmpeg-static');
  const lameListed = readListedDependency(repoRoot, 'lamejs');
  const ffmpegResolved = readResolvedPackage(repoRoot, 'ffmpeg-static');
  const lameResolved = readResolvedPackage(repoRoot, 'lamejs');
  const packaged = scannedRoot && fs.existsSync(scannedRoot) && fs.statSync(scannedRoot).isDirectory()
    ? packagedDependencyFlags(scannedRoot)
    : { ffmpegStatic: false, lamejs: false };
  return {
    ffmpegStatic: {
      listedDependency: ffmpegListed,
      listedInScannedManifest: readListedDependency(scannedRoot, 'ffmpeg-static'),
      resolvedDependency: Boolean(ffmpegResolved),
      resolvedVersion: ffmpegResolved?.version || null,
      resolvedLicense: ffmpegResolved?.license || null,
      packagedInScannedTree: packaged.ffmpegStatic,
      executedDependency: false,
      applicationSourceImportFound: sourceMentions(repoRoot, 'ffmpeg-static'),
      obligationNote: 'GPL-3.0-or-later applies if this binary is distributed. Absence from application source does not remove that obligation.',
    },
    lamejs: {
      listedDependency: lameListed,
      listedInScannedManifest: readListedDependency(scannedRoot, 'lamejs'),
      resolvedDependency: Boolean(lameResolved),
      resolvedVersion: lameResolved?.version || null,
      resolvedLicense: lameResolved?.license || null,
      packagedInScannedTree: packaged.lamejs,
      executedDependency: false,
      referencedByNextConfig: sourceFileMentions(repoRoot, 'next.config.js', 'lamejs'),
      obligationNote: 'LGPL-3.0 applies if the client bundle ships lamejs. This scanner does not add a license notice or replace the dependency.',
    },
  };
}

function isMadmomModel(relativePath, base, extension, lowerSegments) {
  if (MADMOM_NAMES.test(base)) return true;
  if (!lowerSegments.has('madmom')) return false;
  return DATA_EXTENSIONS.has(extension) || MODEL_CONTAINER_EXTENSIONS.has(extension) || lowerSegments.has('models');
}

function isChordCheckpoint(base, extension, lowerSegments) {
  if (extension === '.sdict' || CHORD_SDICT.test(base) || CHORD_PICKLES.test(base)) return true;
  if (!lowerSegments.has('chord-cnn-lstm')) return false;
  return extension === '.pkl' || extension === '.sdict' || LEGACY_MODEL_EXTENSIONS.has(extension);
}

function isBeatTransformerCheckpoint(base, extension, lowerSegments) {
  if (/trf_param/i.test(base) && (LEGACY_MODEL_EXTENSIONS.has(extension) || extension === '.pt')) return true;
  if (!lowerSegments.has('beat-transformer')) return false;
  return LEGACY_MODEL_EXTENSIONS.has(extension) || lowerSegments.has('checkpoint');
}

function isSongFormerCheckpoint(base, extension, lowerSegments) {
  const modelExtension = LEGACY_MODEL_EXTENSIONS.has(extension) || MODEL_CONTAINER_EXTENSIONS.has(extension);
  const knownName = /^(?:songformer\.safetensors|pretrained_msd\.pt|model\.safetensors)$/i.test(base);
  if (knownName && (lowerSegments.has('songformer') || lowerSegments.has('muq') || lowerSegments.has('musicfm') || lowerSegments.has('ckpts'))) {
    return true;
  }
  if ((lowerSegments.has('muq') || lowerSegments.has('musicfm')) && (modelExtension || lowerSegments.has('ckpts'))) {
    return true;
  }
  if (lowerSegments.has('songformer') && lowerSegments.has('ckpts') && (modelExtension || knownName)) return true;
  return false;
}

function isFfmpegStatic(relativePath, base, entry) {
  const segments = relativePath.split('/').map((segment) => segment.toLowerCase());
  if (segments.includes('ffmpeg-static')) return true;
  if (!/^(ffmpeg|ffmpeg\.exe)$/i.test(base) || entry.kind !== 'file') return false;
  const bytes = entry.bytes ? entry.bytes() : readPrefix(entry.absolutePath, 4);
  return isNativeExecutable(bytes);
}

function isNsisPayload(base, entry) {
  if (!base.toLowerCase().endsWith('.exe') || entry.kind !== 'file') return false;
  const bytes = entry.bytes ? entry.bytes().subarray(0, 4096) : readPrefix(entry.absolutePath, 4096);
  return bytes.includes(Buffer.from('NullsoftInst'));
}

function isNativeExecutable(bytes) {
  if (!bytes || bytes.length < 4) return false;
  if (bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) return true;
  if (bytes[0] === 0x4d && bytes[1] === 0x5a) return true;
  if (bytes.readUInt32BE(0) === 0xfeedface || bytes.readUInt32BE(0) === 0xfeedfacf || bytes.readUInt32BE(0) === 0xcafebabe) return true;
  return false;
}

function readPrefix(filePath, size) {
  if (!filePath) return Buffer.alloc(0);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(size);
    const read = fs.readSync(fd, buffer, 0, size, 0);
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

function readAsarHeader(archivePath) {
  const fd = fs.openSync(archivePath, 'r');
  try {
    const sizeBuf = Buffer.alloc(8);
    if (fs.readSync(fd, sizeBuf, 0, 8, 0) !== 8) throw new Error('short asar');
    const headerSize = readPickleUInt32(sizeBuf);
    if (!Number.isInteger(headerSize) || headerSize <= 0 || headerSize > MAX_HEADER_BYTES) throw new Error('asar header size');
    const headerBuf = Buffer.alloc(headerSize);
    if (fs.readSync(fd, headerBuf, 0, headerSize, 8) !== headerSize) throw new Error('short asar header');
    const header = JSON.parse(readPickleString(headerBuf));
    if (!header || typeof header.files !== 'object') throw new Error('asar files');
    return { header, headerSize };
  } finally {
    fs.closeSync(fd);
  }
}

function readPickleUInt32(buffer) {
  const payloadSize = buffer.readUInt32LE(0);
  const headerSize = buffer.length - payloadSize;
  if (headerSize !== 4 || payloadSize < 4) throw new Error('pickle');
  return buffer.readUInt32LE(headerSize);
}

function readPickleString(buffer) {
  const payloadSize = buffer.readUInt32LE(0);
  const headerSize = buffer.length - payloadSize;
  if (headerSize < 4 || headerSize % 4 !== 0) throw new Error('pickle string');
  const payload = buffer.subarray(headerSize, headerSize + payloadSize);
  const length = payload.readInt32LE(0);
  if (length < 0 || 4 + length > payload.length) throw new Error('pickle length');
  return payload.subarray(4, 4 + length).toString('utf8');
}

function collectAsarFiles(files, prefix, out) {
  for (const [name, info] of Object.entries(files)) {
    const next = prefix ? `${prefix}/${name}` : name;
    if (info.files) collectAsarFiles(info.files, next, out);
    else if (!info.link) out.push({ name: next, size: Number(info.size) || 0, offset: info.offset, unpacked: Boolean(info.unpacked) });
  }
}

function readAsarFile(archivePath, headerSize, file) {
  if (file.unpacked) {
    return fs.readFileSync(path.join(`${archivePath}.unpacked`, file.name));
  }
  if (file.size <= 0) return Buffer.alloc(0);
  const fd = fs.openSync(archivePath, 'r');
  try {
    const buffer = Buffer.alloc(file.size);
    const offset = 8 + headerSize + Number(file.offset);
    if (fs.readSync(fd, buffer, 0, file.size, offset) !== file.size) throw new Error('short asar file');
    return buffer;
  } finally {
    fs.closeSync(fd);
  }
}

function listZipEntries(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 30 <= buffer.length) {
    const signature = buffer.readUInt32LE(offset);
    if (signature === 0x02014b50 || signature === 0x06054b50) break;
    if (signature !== 0x04034b50) throw new Error('zip signature');
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    if (dataStart + compressedSize > buffer.length) throw new Error('zip truncated');
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8');
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    let bytes = compressed;
    if (method === 8) bytes = zlib.inflateRawSync(compressed, { maxOutputLength: MAX_CONTENT_BYTES });
    else if (method !== 0) throw new Error('zip method');
    if (name && !name.endsWith('/')) entries.push({ name, bytes });
    offset = dataStart + compressedSize;
    if (entries.length > MAX_ARCHIVE_ENTRIES) break;
  }
  return entries;
}

function sanitizeRelative(value) {
  return String(value)
    .split(/[/\\]+/)
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
}

function sanitizeRootLabel(absoluteRoot, cwd) {
  const relative = path.relative(cwd, absoluteRoot);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join('/');
  }
  return path.basename(absoluteRoot);
}

function readListedDependency(repoRoot, name) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    return Boolean(manifest.dependencies?.[name] || manifest.devDependencies?.[name]);
  } catch {
    return false;
  }
}

function readResolvedPackage(repoRoot, name) {
  try {
    const installed = JSON.parse(fs.readFileSync(path.join(repoRoot, 'node_modules', name, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
    const locked = lock.packages?.[`node_modules/${name}`];
    if (!locked) return null;
    return { version: installed.version || locked.version || null, license: installed.license || null };
  } catch {
    return null;
  }
}

function packagedDependencyFlags(scannedRoot) {
  let ffmpegStatic = false;
  let lamejs = false;
  const stack = [scannedRoot];
  let seen = 0;
  while (stack.length > 0) {
    const directory = stack.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      seen += 1;
      if (seen > MAX_WALK_ENTRIES) return { ffmpegStatic, lamejs };
      const lower = entry.name.toLowerCase();
      if (lower === 'ffmpeg-static') ffmpegStatic = true;
      if (lower === 'lamejs') lamejs = true;
      if (entry.isDirectory()) stack.push(path.join(directory, entry.name));
    }
  }
  return { ffmpegStatic, lamejs };
}

function sourceMentions(repoRoot, needle) {
  return ['src', 'electron', 'scripts'].some((directory) => treeMentions(path.join(repoRoot, directory), needle, 'scan-desktop-package.mjs'))
    || sourceFileMentions(repoRoot, 'next.config.js', needle);
}

function sourceFileMentions(repoRoot, relativeFile, needle) {
  try {
    return fs.readFileSync(path.join(repoRoot, relativeFile), 'utf8').includes(needle);
  } catch {
    return false;
  }
}

function treeMentions(directory, needle, skipBase) {
  if (!fs.existsSync(directory)) return false;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      if (treeMentions(fullPath, needle, skipBase)) return true;
      continue;
    }
    if (entry.name === skipBase) continue;
    if (!/\.(js|mjs|cjs|ts|tsx|jsx)$/.test(entry.name)) continue;
    if (fs.readFileSync(fullPath, 'utf8').includes(needle)) return true;
  }
  return false;
}

function main() {
  const root = path.resolve(process.argv[2] || '');
  const reportPath = path.resolve(process.argv[3] || '');
  if (!root || !reportPath || !fs.existsSync(root)) {
    console.error('Usage: node scripts/scan-desktop-package.mjs <directory> <report.json>');
    process.exit(2);
  }
  const report = scanDesktopPackage(root, { cwd: process.cwd(), repoRoot: process.cwd() });
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (report.findingCount > 0) {
    console.error(`Desktop package scan found ${report.findingCount} blocked path(s).`);
    process.exit(1);
  }
  console.log(`Desktop package scan found no secrets or model checkpoints in ${report.root}`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
