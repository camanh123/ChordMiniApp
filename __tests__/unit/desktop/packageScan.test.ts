/**
 * @jest-environment node
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';

const repoRoot = path.resolve(__dirname, '../../..');
const scanner = path.join(repoRoot, 'scripts/scan-desktop-package.mjs');

function writeTree(root: string, files: Record<string, string | Buffer>) {
  for (const [name, contents] of Object.entries(files)) {
    const full = path.join(root, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'chordmini-scan-'));
}

function runScan(root: string) {
  const reportPath = path.join(os.tmpdir(), `chordmini-scan-report-${process.pid}-${Date.now()}.json`);
  const result = spawnSync(process.execPath, [scanner, root, reportPath], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const report = fs.existsSync(reportPath)
    ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) as {
      root: string;
      scanScope: string;
      nsisPayloadInspected: boolean;
      archiveCoverage: string[];
      claim: string;
      findingCount: number;
      findings: Array<{ path: string; reason: string }>;
      dependencyInventory: {
        ffmpegStatic: {
          listedDependency: boolean;
          resolvedDependency: boolean;
          resolvedVersion: string | null;
          resolvedLicense: string | null;
          packagedInScannedTree: boolean;
          executedDependency: boolean;
          applicationSourceImportFound: boolean;
        };
        lamejs: {
          listedDependency: boolean;
          resolvedLicense: string | null;
          packagedInScannedTree: boolean;
          executedDependency: boolean;
          referencedByNextConfig: boolean;
        };
      };
    }
    : null;
  fs.rmSync(reportPath, { force: true });
  return { status: result.status, report, stderr: result.stderr };
}

function reasons(report: NonNullable<ReturnType<typeof runScan>['report']>, suffix: string) {
  return report.findings.filter((finding) => finding.path === suffix || finding.path.endsWith(`/${suffix}`)).map((finding) => finding.reason);
}

function storeZip(files: Array<{ name: string; data: Buffer; method?: number }>) {
  const parts: Buffer[] = [];
  for (const file of files) {
    const method = file.method ?? 0;
    const stored = method === 8 ? zlib.deflateRawSync(file.data) : file.data;
    const name = Buffer.from(file.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(zlib.crc32(file.data), 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, stored);
  }
  return Buffer.concat(parts);
}

async function createAsar(files: Record<string, string | Buffer>, dest: string) {
  const source = tempRoot();
  writeTree(source, files);
  const asar = require('@electron/asar') as { createPackage: (source: string, dest: string) => Promise<void> };
  await asar.createPackage(source, dest);
  fs.rmSync(source, { recursive: true, force: true });
}

const harmless = {
  'locales/vi.json': '{"open":"Mở âm thanh"}\n',
  'public/help/notes.pkl': 'not a model pickle',
  'docs/madmom-overview.txt': 'Madmom weights are not stored in this note.',
  'docs/SongFormer-overview.txt': 'SongFormer remains outside the installer.',
  'tools/ffmpeg.txt': 'ffmpeg-static is a listed dependency, not this text file.',
  'Beat-Transformer/README.md': 'model card text',
  'assets/chord-chart.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
};

describe('desktop package scan', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('passes a clean fixture and does not treat lookalike names as model assets', async () => {
    const root = tempRoot();
    roots.push(root);
    writeTree(root, {
      ...harmless,
      'ChordMini.exe': Buffer.from('MZElectron application'),
    });
    await createAsar({ 'locales/en.json': '{"ok":true}\n' }, path.join(root, 'resources/app.asar'));

    const { status, report } = runScan(root);
    expect(status).toBe(0);
    expect(report?.findingCount).toBe(0);
    expect(report?.scanScope).toBe('directory-tree');
    expect(report?.nsisPayloadInspected).toBe(false);
    expect(report?.claim).toMatch(/does not establish that an NSIS payload/);
    expect(report?.archiveCoverage).toContain('resources/app.asar');
    expect(report?.root.includes('/home/') || report?.root.includes('\\Users\\')).toBe(false);
  });

  it('keeps the previous exclusion reasons', () => {
    const root = tempRoot();
    roots.push(root);
    writeTree(root, {
      '.env': 'FIREBASE_SERVICE_ACCOUNT_KEY=secret',
      'runtime/secrets.env': 'FIREBASE_SERVICE_ACCOUNT_KEY=secret',
      'python_backend/app.py': 'print("flask")\n',
      'weights.pt': 'checkpoint',
      'keys/firebase-adminsdk.json': '{}\n',
      'config/admin.json': '{"type":"service_account"}\n',
    });

    const { status, report } = runScan(root);
    expect(status).toBe(1);
    expect(reasons(report!, '.env')).toContain('excluded-asset');
    expect(reasons(report!, 'runtime/secrets.env')).toContain('secret-content');
    expect(reasons(report!, 'python_backend/app.py')).toContain('excluded-asset');
    expect(reasons(report!, 'weights.pt')).toEqual(['credential-or-model']);
    expect(reasons(report!, 'firebase-adminsdk.json')).toContain('credential-or-model');
    expect(reasons(report!, 'config/admin.json')).toContain('secret-content');
    expect(fs.readFileSync(path.join(root, 'weights.pt'), 'utf8')).toBe('checkpoint');
  });

  it('rejects Madmom, Chord-CNN-LSTM, Beat-Transformer, and SongFormer checkpoints', () => {
    const root = tempRoot();
    roots.push(root);
    writeTree(root, {
      ...harmless,
      'madmom/models/beats/2015/beats_blstm_1.pkl': 'weight',
      'Chord-CNN-LSTM/cache_data/joint_chord_net_ismir.sdict': 'weight',
      'Chord-CNN-LSTM/data/cross_weight0.pkl': 'weight',
      'Beat-Transformer/checkpoint/fold_4_trf_param.pt': 'weight',
      'SongFormer/src/SongFormer/ckpts/MuQ/model.safetensors': 'weight',
      'SongFormer/src/SongFormer/ckpts/MusicFM/pretrained_msd.pt': 'weight',
      'vendor/model.h5': 'weight',
    });

    const { status, report } = runScan(root);
    expect(status).toBe(1);
    expect(reasons(report!, 'beats_blstm_1.pkl')).toContain('madmom-model');
    expect(reasons(report!, 'joint_chord_net_ismir.sdict')).toContain('chord-checkpoint');
    expect(reasons(report!, 'cross_weight0.pkl')).toContain('chord-checkpoint');
    expect(reasons(report!, 'fold_4_trf_param.pt')).toEqual(expect.arrayContaining([
      'credential-or-model',
      'beat-transformer-checkpoint',
    ]));
    expect(reasons(report!, 'model.safetensors')).toContain('songformer-checkpoint');
    expect(reasons(report!, 'pretrained_msd.pt')).toContain('songformer-checkpoint');
    expect(reasons(report!, 'vendor/model.h5')).toContain('model-asset');
    expect(report!.findings.some((finding) => finding.path.includes('notes.pkl'))).toBe(false);
    expect(report!.findings.some((finding) => finding.path.includes('madmom-overview.txt'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'madmom/models/beats/2015/beats_blstm_1.pkl'))).toBe(true);
  });

  it('rejects an ffmpeg-static binary distribution and leaves text notes alone', () => {
    const root = tempRoot();
    roots.push(root);
    writeTree(root, {
      ...harmless,
      'node_modules/ffmpeg-static/ffmpeg.exe': Buffer.from([0x4d, 0x5a, 0, 0]),
      'resources/ffmpeg.exe': Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
    });

    const { status, report } = runScan(root);
    expect(status).toBe(1);
    expect(reasons(report!, 'node_modules/ffmpeg-static/ffmpeg.exe')).toContain('ffmpeg-static-binary');
    expect(reasons(report!, 'resources/ffmpeg.exe')).toContain('ffmpeg-static-binary');
    expect(report!.findings.some((finding) => finding.path.endsWith('tools/ffmpeg.txt'))).toBe(false);
    expect(report!.dependencyInventory.ffmpegStatic.packagedInScannedTree).toBe(true);
    expect(report!.dependencyInventory.ffmpegStatic.executedDependency).toBe(false);
  });

  it('rejects secrets and model names inside asar and zip archives', async () => {
    const root = tempRoot();
    roots.push(root);
    writeTree(root, harmless);
    await createAsar({
      'madmom/models/beats_blstm_2.pkl': 'weight',
      'config/leaked.json': '{"type":"service_account"}\n',
    }, path.join(root, 'resources/app.asar'));
    writeTree(root, {
      'payloads/chords.zip': storeZip([
        { name: 'Chord-CNN-LSTM/cache_data/joint_chord_net_ismir.sdict', data: Buffer.from('weight') },
      ]),
      'payloads/secret.zip': storeZip([
        { name: 'keys/account.json', data: Buffer.from('{"type":"service_account"}\n'), method: 8 },
      ]),
    });

    const { status, report } = runScan(root);
    expect(status).toBe(1);
    expect(report!.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'resources/app.asar!/madmom/models/beats_blstm_2.pkl',
        reason: 'madmom-model',
      }),
      expect.objectContaining({
        path: 'resources/app.asar!/config/leaked.json',
        reason: 'secret-content',
      }),
      expect.objectContaining({
        path: 'payloads/chords.zip!/Chord-CNN-LSTM/cache_data/joint_chord_net_ismir.sdict',
        reason: 'chord-checkpoint',
      }),
      expect.objectContaining({
        path: 'payloads/secret.zip!/keys/account.json',
        reason: 'secret-content',
      }),
    ]));
    expect(report!.archiveCoverage).toEqual(expect.arrayContaining([
      'resources/app.asar',
      'payloads/chords.zip',
      'payloads/secret.zip',
    ]));
  });

  it('fails closed on an unreadable archive and an unopened NSIS installer', () => {
    const root = tempRoot();
    roots.push(root);
    writeTree(root, {
      'resources/app.asar': 'not an asar',
      'ChordMini-Setup-0.6.5-x64.exe': Buffer.from('MZ....NullsoftInst....'),
    });

    const { status, report } = runScan(root);
    expect(status).toBe(1);
    expect(reasons(report!, 'resources/app.asar')).toContain('unreadable-archive');
    expect(reasons(report!, 'ChordMini-Setup-0.6.5-x64.exe')).toContain('uninspected-nsis-payload');
    expect(report!.nsisPayloadInspected).toBe(false);
  });

  it('records ffmpeg-static and lamejs without calling either dependency packaged or executed', () => {
    const root = tempRoot();
    roots.push(root);
    writeTree(root, harmless);

    const { status, report } = runScan(root);
    expect(status).toBe(0);
    expect(report!.dependencyInventory.ffmpegStatic).toMatchObject({
      listedDependency: true,
      resolvedDependency: true,
      resolvedVersion: '5.3.0',
      resolvedLicense: 'GPL-3.0-or-later',
      listedInScannedManifest: false,
      packagedInScannedTree: false,
      executedDependency: false,
      applicationSourceImportFound: false,
    });
    expect(report!.dependencyInventory.lamejs).toMatchObject({
      listedDependency: true,
      resolvedLicense: 'LGPL-3.0',
      packagedInScannedTree: false,
      executedDependency: false,
      referencedByNextConfig: true,
    });
    expect(report!.findings).toEqual([]);
  });
});
