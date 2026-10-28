/**
 * @jest-environment node
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  AnalysisHistoryError,
  deleteAnalysisRecord,
  hashAnalysisResult,
  listAnalysisRecords,
  readAnalysisRecord,
  recoverInterruptedWrites,
  saveAnalysisRecord,
  touchAnalysisRecord,
  type HistoryStoreOptions,
} from '@/desktop/analysisHistory';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const UUID_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;

function desktopEnv(root: string): NodeJS.ProcessEnv {
  return {
    CHORDMINI_DESKTOP_MODE: '1',
    CHORDMINI_ANALYSIS_HISTORY_DIR: root,
  };
}

function optionsFor(root: string, extra?: Partial<HistoryStoreOptions>): HistoryStoreOptions {
  return { env: desktopEnv(root), ...extra };
}

function draft(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 1,
    source: {
      kind: 'local-audio',
      displayName: 'song.mp3',
      sizeBytes: 1280,
      contentSha256: HASH_A,
    },
    analyzedAt: '2026-10-26T14:03:05.123Z',
    models: { beat: 'madmom', chord: 'chord-cnn-lstm', beatReported: 'madmom' },
    chords: [{ chord: 'C', start: 0.25, end: 1.5 }],
    beats: [{ time: 0.25 }, { time: 1.25 }],
    status: 'complete',
    provenance: { pipeline: 'local-upload-v1' },
    ...overrides,
  };
}

function recordFiles(root: string): string[] {
  return fs.readdirSync(root).filter((name) => UUID_FILE.test(name));
}

function treeText(directory: string): string {
  const parts: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink() || !entry.isFile()) continue;
    parts.push(fs.readFileSync(full, 'utf8'));
  }
  return parts.join('\n');
}

describe('local analysis history storage', () => {
  let root = '';
  const roots: string[] = [];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'chordmini-history-'));
    roots.push(root);
  });

  afterAll(() => {
    for (const directory of roots) fs.rmSync(directory, { recursive: true, force: true });
  });

  it('round-trips a valid record and preserves timestamp precision', async () => {
    const options = optionsFor(root);
    const saved = await saveAnalysisRecord(draft(), options);
    const loaded = await readAnalysisRecord(saved.record.id, options);

    expect(saved.created).toBe(true);
    expect(loaded).toEqual(saved.record);
    expect(loaded.schemaVersion).toBe(1);
    expect(loaded.analyzedAt).toBe('2026-10-26T14:03:05.123Z');
    expect(loaded.source.kind).toBe('local-audio');
    expect(loaded.status).toBe('complete');
    expect(loaded.resultSha256).toBe(hashAnalysisResult(loaded));
    expect(loaded.resultSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stores missing optional measurements as null', async () => {
    const saved = await saveAnalysisRecord(draft(), optionsFor(root));
    const text = fs.readFileSync(path.join(root, `${saved.record.id}.json`), 'utf8');

    expect(saved.record.bpm).toBeNull();
    expect(saved.record.key).toBeNull();
    expect(saved.record.meter).toBeNull();
    expect(saved.record.downbeats).toBeNull();
    expect(saved.record.synchronizedChords).toBeNull();
    expect(saved.record.audioDurationSeconds).toBeNull();
    expect(saved.record.chords[0].confidence).toBeUndefined();
    expect(text).not.toContain('"confidence"');
    expect(text).not.toContain('120');
    expect(text).not.toContain('0.8');
    expect(text).not.toContain('4/4');
  });

  it('rejects fabricated defaults when provenance is absent and keeps real measurements', async () => {
    const options = optionsFor(root);
    await expect(saveAnalysisRecord(draft({ bpm: 120 }), options)).rejects.toBeInstanceOf(AnalysisHistoryError);
    await expect(saveAnalysisRecord(draft({ bpm: { value: 120 } }), options)).rejects.toMatchObject({ code: 'RECORD_INVALID' });
    await expect(saveAnalysisRecord(draft({
      chords: [{ chord: 'C', start: 0.25, end: 1.5, confidence: 0.8 }],
    }), options)).rejects.toMatchObject({ code: 'RECORD_INVALID' });
    await expect(saveAnalysisRecord(draft({
      meter: { beatsPerBar: 4, denominator: 4 },
    }), options)).rejects.toMatchObject({ code: 'RECORD_INVALID' });
    await expect(saveAnalysisRecord(draft({ meter: '4/4' }), options)).rejects.toMatchObject({ code: 'RECORD_INVALID' });
    expect(recordFiles(root)).toHaveLength(0);

    const saved = await saveAnalysisRecord(draft({
      bpm: { value: 120, provenance: 'model' },
      key: { value: 'C major', provenance: 'key-service' },
      meter: { beatsPerBar: 4, denominator: 4, provenance: 'madmom-candidate-selection' },
      chords: [{
        chord: 'C',
        start: 0.25,
        end: 1.5,
        confidence: { value: 0.8, provenance: 'model' },
      }],
    }), options);
    expect(saved.record.bpm).toEqual({ value: 120, provenance: 'model' });
    expect(saved.record.key).toEqual({ value: 'C major', provenance: 'key-service' });
    expect(saved.record.meter?.beatsPerBar).toBe(4);
    expect(saved.record.chords[0].confidence).toEqual({ value: 0.8, provenance: 'model' });
  });

  it('rejects invalid timelines and timestamps', async () => {
    const options = optionsFor(root);
    await expect(saveAnalysisRecord(draft({
      beats: [{ time: 1.25 }, { time: 0.25 }],
    }), options)).rejects.toMatchObject({ code: 'RECORD_INVALID' });
    await expect(saveAnalysisRecord(draft({
      chords: [{ chord: 'C', start: 1.5, end: 0.25 }],
    }), options)).rejects.toMatchObject({ code: 'RECORD_INVALID' });
    await expect(saveAnalysisRecord(draft({
      beats: [{ time: Number.NaN }],
    }), options)).rejects.toMatchObject({ code: 'RECORD_INVALID' });
    await expect(saveAnalysisRecord(draft({
      analyzedAt: '2026-10-26T14:03:05',
    }), options)).rejects.toMatchObject({ code: 'RECORD_INVALID' });
    await expect(saveAnalysisRecord(draft({
      analyzedAt: '2026-02-31T00:00:00.000Z',
    }), options)).rejects.toMatchObject({ code: 'RECORD_INVALID' });
    expect(recordFiles(root)).toHaveLength(0);
  });

  it('does not create or replace a record for the same analysis result', async () => {
    const options = optionsFor(root);
    const first = await saveAnalysisRecord(draft(), options);
    const file = path.join(root, `${first.record.id}.json`);
    const before = fs.readFileSync(file);
    const second = await saveAnalysisRecord(draft({
      analyzedAt: '2026-10-26T15:00:00.000Z',
      source: {
        kind: 'local-audio',
        displayName: 'renamed.mp3',
        sizeBytes: 1280,
        contentSha256: HASH_A,
      },
    }), options);

    expect(second.created).toBe(false);
    expect(second.record.id).toBe(first.record.id);
    expect(second.record.analyzedAt).toBe(first.record.analyzedAt);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(recordFiles(root)).toHaveLength(1);

    const opened = await touchAnalysisRecord(first.record.id, '2026-10-26T16:00:00.000Z', options);
    expect(opened.resultSha256).toBe(first.record.resultSha256);
    expect(opened.analyzedAt).toBe(first.record.analyzedAt);
    expect(opened.lastOpenedAt).toBe('2026-10-26T16:00:00.000Z');
    expect(hashAnalysisResult(opened)).toBe(first.record.resultSha256);
  });

  it('keeps identical filenames with different audio content as separate records', async () => {
    const options = optionsFor(root);
    const first = await saveAnalysisRecord(draft(), options);
    const second = await saveAnalysisRecord(draft({
      source: {
        kind: 'local-audio',
        displayName: 'song.mp3',
        sizeBytes: 4096,
        contentSha256: HASH_B,
      },
    }), options);
    expect(first.record.id).not.toBe(second.record.id);
    expect(recordFiles(root)).toHaveLength(2);
  });

  it('keeps the same audio when the model or the result differs', async () => {
    const options = optionsFor(root);
    const original = await saveAnalysisRecord(draft(), options);
    const otherModel = await saveAnalysisRecord(draft({
      models: { beat: 'beat-transformer', chord: 'chord-cnn-lstm', beatReported: null },
    }), options);
    const otherResult = await saveAnalysisRecord(draft({
      chords: [{ chord: 'Am', start: 0.25, end: 1.5 }],
    }), options);
    expect(new Set([original.record.id, otherModel.record.id, otherResult.record.id]).size).toBe(3);
  });

  it('serializes concurrent writes without dropping or duplicating records', async () => {
    const options = optionsFor(root);
    const [first, second] = await Promise.all([
      saveAnalysisRecord(draft(), options),
      saveAnalysisRecord(draft({
        source: {
          kind: 'local-audio',
          displayName: 'other.mp3',
          sizeBytes: 2048,
          contentSha256: HASH_B,
        },
      }), options),
    ]);
    expect(first.record.id).not.toBe(second.record.id);
    expect(recordFiles(root)).toHaveLength(2);

    const shared = draft({
      analyzedAt: '2026-10-26T18:00:00.000Z',
      chords: [{ chord: 'G', start: 0.25, end: 1.5 }],
    });
    const [again, duplicate] = await Promise.all([
      saveAnalysisRecord(shared, options),
      saveAnalysisRecord(shared, options),
    ]);
    expect(again.record.id).toBe(duplicate.record.id);
    expect([again.created, duplicate.created].filter(Boolean)).toHaveLength(1);
    expect(recordFiles(root)).toHaveLength(3);
  });

  it('leaves existing records unchanged when an atomic rename fails', async () => {
    const options = optionsFor(root);
    const existing = await saveAnalysisRecord(draft(), options);
    const before = fs.readFileSync(path.join(root, `${existing.record.id}.json`));
    await expect(saveAnalysisRecord(draft({
      source: {
        kind: 'local-audio',
        displayName: 'other.mp3',
        sizeBytes: 10,
        contentSha256: HASH_B,
      },
    }), {
      ...options,
      fault: {
        beforeRename() {
          const error = new Error('rename failed') as NodeJS.ErrnoException;
          error.code = 'EIO';
          throw error;
        },
      },
    })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });

    expect(fs.readFileSync(path.join(root, `${existing.record.id}.json`)).equals(before)).toBe(true);
    expect(fs.readdirSync(root).some((name) => name.includes('.tmp-'))).toBe(false);
    expect(recordFiles(root)).toEqual([`${existing.record.id}.json`]);
  });

  it('ignores a crash between the temporary write and rename', async () => {
    const options = optionsFor(root);
    const saved = await saveAnalysisRecord(draft(), options);
    const abandoned = path.join(root, '.abandoned.tmp-9-aa');
    const fresh = path.join(root, '.fresh.tmp-9-bb');
    fs.writeFileSync(abandoned, '{"partial"');
    fs.writeFileSync(fresh, 'pending');
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(abandoned, old, old);

    await recoverInterruptedWrites(options);
    const listed = await listAnalysisRecords(options);

    expect(fs.existsSync(abandoned)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(listed.records.map((record) => record.id)).toEqual([saved.record.id]);
    expect((await readAnalysisRecord(saved.record.id, options)).chords).toEqual(saved.record.chords);

    const lock = path.join(root, '.write.lock');
    fs.writeFileSync(lock, 'stale');
    fs.utimesSync(lock, old, old);
    const afterStaleLock = await saveAnalysisRecord(draft({
      source: { kind: 'local-audio', displayName: 'after-lock.mp3', sizeBytes: 12, contentSha256: HASH_B },
    }), options);
    expect(afterStaleLock.created).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('isolates a corrupted JSON record and keeps healthy records', async () => {
    const options = optionsFor(root);
    const healthy = await saveAnalysisRecord(draft(), options);
    const corruptId = randomUUID();
    fs.writeFileSync(path.join(root, `${corruptId}.json`), '{');

    await expect(readAnalysisRecord(corruptId, options)).rejects.toMatchObject({ code: 'RECORD_CORRUPT' });
    expect(fs.existsSync(path.join(root, `${corruptId}.json`))).toBe(false);
    expect(fs.readdirSync(path.join(root, 'quarantine')).some((name) => name.startsWith(corruptId))).toBe(true);
    const listed = await listAnalysisRecords(options);
    expect(listed.records.map((record) => record.id)).toEqual([healthy.record.id]);
    expect((await readAnalysisRecord(healthy.record.id, options)).id).toBe(healthy.record.id);

    const tampered = await saveAnalysisRecord(draft({
      source: { kind: 'local-audio', displayName: 'tampered.mp3', sizeBytes: 10, contentSha256: HASH_B },
    }), options);
    const tamperedFile = path.join(root, `${tampered.record.id}.json`);
    const parsed = JSON.parse(fs.readFileSync(tamperedFile, 'utf8')) as { chords: Array<{ chord: string }> };
    parsed.chords[0].chord = 'ZZ';
    fs.writeFileSync(tamperedFile, JSON.stringify(parsed));
    await expect(readAnalysisRecord(tampered.record.id, options)).rejects.toMatchObject({ code: 'RECORD_CORRUPT' });
    expect((await readAnalysisRecord(healthy.record.id, options)).id).toBe(healthy.record.id);
  });

  it('rebuilds history when the derived index is missing or corrupt', async () => {
    const options = optionsFor(root);
    const saved = await saveAnalysisRecord(draft(), options);
    const index = path.join(root, 'index.json');
    fs.rmSync(index);
    expect((await listAnalysisRecords(options)).records.map((record) => record.id)).toEqual([saved.record.id]);

    fs.writeFileSync(index, '{');
    const listed = await listAnalysisRecords(options);
    expect(listed.records.map((record) => record.id)).toEqual([saved.record.id]);
    expect(JSON.parse(fs.readFileSync(index, 'utf8')).records[0].id).toBe(saved.record.id);
  });

  it('rejects symlink escapes and path traversal', async () => {
    const real = path.join(root, 'real');
    const link = path.join(root, 'link');
    const outside = path.join(root, 'outside.json');
    fs.mkdirSync(real);
    fs.symlinkSync(real, link);
    fs.writeFileSync(outside, '{"apiKey":"keep-outside"}');
    await expect(saveAnalysisRecord(draft(), optionsFor(link))).rejects.toMatchObject({ code: 'STORAGE_ROOT_UNSAFE' });
    expect(fs.readdirSync(real)).toEqual([]);

    await expect(saveAnalysisRecord(draft(), optionsFor(`${root}/nested/../escaped`))).rejects.toMatchObject({
      code: 'STORAGE_ROOT_UNSAFE',
    });
    expect(fs.existsSync(path.join(root, 'escaped'))).toBe(false);
    await expect(saveAnalysisRecord(draft(), {
      env: { CHORDMINI_DESKTOP_MODE: '1', CHORDMINI_ANALYSIS_HISTORY_DIR: 'relative/history' },
    })).rejects.toMatchObject({ code: 'STORAGE_ROOT_UNSAFE' });

    const options = optionsFor(real);
    const saved = await saveAnalysisRecord(draft(), options);
    fs.rmSync(path.join(real, `${saved.record.id}.json`));
    fs.symlinkSync(outside, path.join(real, `${saved.record.id}.json`));
    await expect(deleteAnalysisRecord({
      recordId: saved.record.id,
      confirmDelete: true,
    }, options)).rejects.toMatchObject({ code: 'PATH_UNSAFE' });
    expect(fs.readFileSync(outside, 'utf8')).toContain('keep-outside');
    expect(fs.lstatSync(path.join(real, `${saved.record.id}.json`)).isSymbolicLink()).toBe(true);

    const quarantineLink = path.join(real, 'quarantine');
    const outsideDir = path.join(root, 'outside-dir');
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(path.join(outsideDir, 'marker.txt'), 'keep');
    fs.symlinkSync(outsideDir, quarantineLink);
    const corruptId = randomUUID();
    fs.writeFileSync(path.join(real, `${corruptId}.json`), '{');
    const listed = await listAnalysisRecords(options);
    expect(listed.isolated.some((entry) => entry.id === corruptId && entry.reason === 'quarantine-unsafe')).toBe(true);
    expect(fs.readdirSync(outsideDir)).toEqual(['marker.txt']);
    expect(fs.readFileSync(outside, 'utf8')).toContain('keep-outside');

    await expect(deleteAnalysisRecord({
      recordId: '../outside.json',
      confirmDelete: true,
    }, options)).rejects.toMatchObject({ code: 'PATH_UNSAFE' });
  });

  it('reports disk full and permission denial without discarding history', async () => {
    const options = optionsFor(root);
    const existing = await saveAnalysisRecord(draft(), options);
    const other = draft({
      source: {
        kind: 'local-audio',
        displayName: 'other.mp3',
        sizeBytes: 20,
        contentSha256: HASH_B,
      },
    });
    await expect(saveAnalysisRecord(other, {
      ...options,
      fault: {
        beforeRename() {
          const error = new Error('no space') as NodeJS.ErrnoException;
          error.code = 'ENOSPC';
          throw error;
        },
      },
    })).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      message: expect.stringMatching(/disk is full/),
    });
    await expect(saveAnalysisRecord(other, {
      ...options,
      fault: {
        beforeRename() {
          const error = new Error('denied') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        },
      },
    })).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      message: expect.stringMatching(/not writable/),
    });
    expect(recordFiles(root)).toEqual([`${existing.record.id}.json`]);

    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      const locked = fs.mkdtempSync(path.join(os.tmpdir(), 'chordmini-history-locked-'));
      roots.push(locked);
      fs.chmodSync(locked, 0o555);
      try {
        await expect(saveAnalysisRecord(draft(), optionsFor(locked))).rejects.toMatchObject({
          code: 'STORAGE_UNAVAILABLE',
        });
      } finally {
        fs.chmodSync(locked, 0o755);
      }
    }
  });

  it('returns a capacity error and does not delete existing history', async () => {
    const first = await saveAnalysisRecord(draft(), optionsFor(root));
    const secondDraft = draft({
      source: {
        kind: 'local-audio',
        displayName: 'other.mp3',
        sizeBytes: 20,
        contentSha256: HASH_B,
      },
    });
    await expect(saveAnalysisRecord(secondDraft, optionsFor(root, { maxRecords: 1 }))).rejects.toMatchObject({
      code: 'CAPACITY_EXCEEDED',
      message: expect.stringMatching(/No records were deleted/),
    });
    const size = fs.statSync(path.join(root, `${first.record.id}.json`)).size;
    await expect(saveAnalysisRecord(secondDraft, optionsFor(root, { maxTotalBytes: size }))).rejects.toMatchObject({
      code: 'CAPACITY_EXCEEDED',
    });
    await expect(saveAnalysisRecord(secondDraft, optionsFor(root, { maxRecordBytes: 32 }))).rejects.toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
    });
    const duplicate = await saveAnalysisRecord(draft(), optionsFor(root, { maxRecords: 1 }));
    expect(duplicate.created).toBe(false);
    expect(duplicate.record.id).toBe(first.record.id);
    expect(recordFiles(root)).toEqual([`${first.record.id}.json`]);
  });

  it('lists records by analysis time and keeps that order after a reread', async () => {
    const options = optionsFor(root);
    const oldest = await saveAnalysisRecord(draft({ analyzedAt: '2026-01-01T00:00:00.000Z' }), options);
    const newest = await saveAnalysisRecord(draft({
      analyzedAt: '2026-06-01T00:00:00.000Z',
      source: { kind: 'local-audio', displayName: 'new.mp3', sizeBytes: 10, contentSha256: HASH_B },
    }), options);
    const middle = await saveAnalysisRecord(draft({
      analyzedAt: '2026-03-01T00:00:00.000Z',
      chords: [{ chord: 'Am', start: 0.25, end: 1.5 }],
    }), options);
    const listed = await listAnalysisRecords(options);
    expect(listed.records.map((record) => record.id)).toEqual([
      newest.record.id,
      middle.record.id,
      oldest.record.id,
    ]);
    expect((await listAnalysisRecords(options)).records.map((record) => record.analyzedAt)).toEqual([
      '2026-06-01T00:00:00.000Z',
      '2026-03-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    ]);
  });

  it('deletes only the confirmed record', async () => {
    const options = optionsFor(root);
    const keep = await saveAnalysisRecord(draft(), options);
    const remove = await saveAnalysisRecord(draft({
      source: { kind: 'local-audio', displayName: 'gone.mp3', sizeBytes: 10, contentSha256: HASH_B },
    }), options);
    await expect(deleteAnalysisRecord({
      recordId: remove.record.id,
      confirmDelete: false,
    } as unknown as { recordId: string; confirmDelete: true }, options)).rejects.toMatchObject({
      code: 'DELETE_NOT_CONFIRMED',
    });
    expect(recordFiles(root)).toHaveLength(2);

    await deleteAnalysisRecord({ recordId: remove.record.id, confirmDelete: true }, options);
    expect(recordFiles(root)).toEqual([`${keep.record.id}.json`]);
    await expect(readAnalysisRecord(remove.record.id, options)).rejects.toMatchObject({ code: 'RECORD_NOT_FOUND' });
    expect((await readAnalysisRecord(keep.record.id, options)).id).toBe(keep.record.id);
  });

  it('isolates an unsupported schema version without deleting other records', async () => {
    const options = optionsFor(root);
    const healthy = await saveAnalysisRecord(draft(), options);
    await expect(saveAnalysisRecord(draft({ schemaVersion: 2 }), options)).rejects.toMatchObject({
      code: 'SCHEMA_UNSUPPORTED',
    });
    const futureId = randomUUID();
    fs.writeFileSync(path.join(root, `${futureId}.json`), JSON.stringify({ schemaVersion: 2, id: futureId }));
    await expect(readAnalysisRecord(futureId, options)).rejects.toMatchObject({ code: 'SCHEMA_UNSUPPORTED' });
    expect(fs.existsSync(path.join(root, `${futureId}.json`))).toBe(false);
    expect((await readAnalysisRecord(healthy.record.id, options)).id).toBe(healthy.record.id);
    expect(recordFiles(root)).toEqual([`${healthy.record.id}.json`]);
  });

  it('does not persist audio bytes, credentials, cookies, or absolute paths', async () => {
    const options = optionsFor(root);
    const secret = 'cred-do-not-store-9f3a';
    await expect(saveAnalysisRecord({
      ...draft(),
      apiKey: secret,
      audioBytes: Buffer.alloc(16).toString('base64'),
      cookie: 'session=abc',
      nonce: 'backend-nonce',
    }, options)).rejects.toMatchObject({ code: 'RECORD_INVALID' });
    await expect(saveAnalysisRecord(draft({
      source: {
        kind: 'local-audio',
        displayName: 'C:\\Users\\person\\song.mp3',
        sizeBytes: 1280,
        contentSha256: HASH_A,
      },
    }), options)).rejects.toMatchObject({ code: 'RECORD_INVALID' });
    expect(treeText(root)).not.toContain(secret);

    const saved = await saveAnalysisRecord(draft(), options);
    const text = fs.readFileSync(path.join(root, `${saved.record.id}.json`), 'utf8');
    expect(text).toContain('song.mp3');
    expect(text).not.toMatch(/apiKey|cookie|nonce|Bearer |data:audio|audioBytes/i);
    expect(text).not.toContain(secret);
    expect(saved.record.source).toEqual({
      kind: 'local-audio',
      displayName: 'song.mp3',
      sizeBytes: 1280,
      contentSha256: HASH_A,
    });

    const host = globalThis as { window?: unknown };
    host.window = {};
    try {
      await expect(saveAnalysisRecord(draft(), options)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    } finally {
      delete host.window;
    }
    await expect(saveAnalysisRecord(draft(), {
      env: { CHORDMINI_DESKTOP_MODE: '0', CHORDMINI_ANALYSIS_HISTORY_DIR: path.join(root, 'disabled') },
    })).rejects.toMatchObject({ code: 'STORAGE_ROOT_UNSAFE' });
    expect(fs.existsSync(path.join(root, 'disabled'))).toBe(false);

    const source = ['schema.ts', 'store.ts', 'index.ts']
      .map((name) => fs.readFileSync(path.join(process.cwd(), 'src/desktop/analysisHistory', name), 'utf8'))
      .join('\n');
    expect(source).not.toMatch(/firestore|firebase|fetch\(/i);
  });

  it('does not steal a live writer lock when its timestamp is older than 30 seconds', async () => {
    const options = optionsFor(root);
    const lock = path.join(root, '.write.lock');
    const old = new Date(Date.now() - 31_000);
    fs.writeFileSync(lock, JSON.stringify({
      pid: process.pid,
      token: 'owned-token',
      heartbeat: Date.now() - 60_000,
    }));
    fs.utimesSync(lock, old, old);

    await expect(saveAnalysisRecord(draft(), { ...options, lockWaitMs: 200 })).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      message: expect.stringMatching(/left unchanged/),
    });
    expect(JSON.parse(fs.readFileSync(lock, 'utf8')).token).toBe('owned-token');
    expect(recordFiles(root)).toHaveLength(0);

    fs.rmSync(lock);
    let contender: Promise<unknown> | null = null;
    const first = await saveAnalysisRecord(draft(), {
      ...options,
      onLocked: async () => {
        const before = fs.readFileSync(lock, 'utf8');
        fs.utimesSync(lock, old, old);
        contender = saveAnalysisRecord(draft({
          source: { kind: 'local-audio', displayName: 'second.mp3', sizeBytes: 20, contentSha256: HASH_B },
        }), { ...options, contendForLock: true });
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(fs.readFileSync(lock, 'utf8')).toBe(before);
      },
    });
    const second = await contender as { created: boolean; record: { id: string } };
    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(second.record.id).not.toBe(first.record.id);
    expect(recordFiles(root)).toHaveLength(2);
  });

  it('reclaims a lock whose owner is gone and whose timestamps are older than 30 seconds', async () => {
    const options = optionsFor(root);
    const lock = path.join(root, '.write.lock');
    const old = new Date(Date.now() - 31_000);
    fs.writeFileSync(lock, JSON.stringify({
      pid: 2147483646,
      token: 'dead-token',
      heartbeat: Date.now() - 60_000,
    }));
    fs.utimesSync(lock, old, old);
    const saved = await saveAnalysisRecord(draft(), options);
    expect(saved.created).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);

    const outside = path.join(root, 'outside-lock');
    fs.writeFileSync(outside, 'keep');
    fs.symlinkSync(outside, lock);
    fs.lutimesSync(lock, old, old);
    const next = await saveAnalysisRecord(draft({
      source: { kind: 'local-audio', displayName: 'after-link.mp3', sizeBytes: 22, contentSha256: HASH_B },
    }), options);
    expect(next.created).toBe(true);
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep');
    expect(recordFiles(root)).toHaveLength(2);
  });
});
