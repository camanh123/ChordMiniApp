/**
 * @jest-environment node
 *
 * Synthetic lyric sidecars. These fixtures are not a device transcription.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  AnalysisHistoryError,
  deleteAnalysisRecord,
  deleteLyricSidecar,
  hashAnalysisResult,
  listAnalysisRecords,
  readAnalysisRecord,
  readLyricSidecar,
  recoverInterruptedWrites,
  saveAnalysisRecord,
  saveLyricSidecar,
  validateLyricSidecarDraft,
  type HistoryStoreOptions,
  type LyricSidecarDraft,
} from '@/desktop/analysisHistory';

const HASH_B = 'b'.repeat(64);

function desktopEnv(root: string): NodeJS.ProcessEnv {
  return {
    CHORDMINI_DESKTOP_MODE: '1',
    CHORDMINI_ANALYSIS_HISTORY_DIR: root,
  };
}

function optionsFor(root: string, extra?: Partial<HistoryStoreOptions>): HistoryStoreOptions {
  return { env: desktopEnv(root), ...extra };
}

function analysisDraft(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 1,
    source: {
      kind: 'local-audio',
      displayName: 'song.mp3',
      sizeBytes: 1280,
      contentSha256: 'a'.repeat(64),
    },
    analyzedAt: '2026-10-26T14:03:05.123Z',
    audioDurationSeconds: 20,
    models: { beat: 'madmom', chord: 'chord-cnn-lstm', beatReported: 'madmom' },
    chords: [{ chord: 'C', start: 0.25, end: 1.5 }],
    beats: [{ time: 0.25 }, { time: 1.25 }],
    status: 'complete',
    provenance: { pipeline: 'local-upload-v1' },
    ...overrides,
  };
}

function lyricDraft(parentResultSha256: string, overrides?: Partial<LyricSidecarDraft>): LyricSidecarDraft {
  return {
    parentResultSha256,
    source: 'lrclib',
    trackTitle: 'Fixture Song',
    artist: 'Fixture Artist',
    catalogDurationSeconds: 20,
    audioDurationSeconds: 20,
    granularity: 'line',
    sourceOffsetSeconds: 0,
    offsetSeconds: 0,
    confirmedEdition: true,
    recognizesAudio: false,
    userModified: false,
    rows: [
      { time: 0, text: '', words: null },
      { time: 5, text: 'Line one', words: null },
      { time: 9, text: 'Line two', words: null },
    ],
    ...overrides,
  };
}

describe('lyric sidecar storage', () => {
  let root = '';
  const roots: string[] = [];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'chordmini-lyrics-'));
    roots.push(root);
  });

  afterAll(() => {
    for (const directory of roots) fs.rmSync(directory, { recursive: true, force: true });
  });

  it('keeps a schemaVersion 1 record unchanged when lyrics are saved', async () => {
    const options = optionsFor(root);
    const saved = await saveAnalysisRecord(analysisDraft(), options);
    const parentPath = path.join(root, `${saved.record.id}.json`);
    const before = fs.readFileSync(parentPath);
    const beforeHash = saved.record.resultSha256;

    const sidecar = await saveLyricSidecar(saved.record.id, lyricDraft(beforeHash), options);
    const after = JSON.parse(fs.readFileSync(parentPath, 'utf8')) as { schemaVersion: number; lyrics?: unknown; resultSha256: string };

    expect(fs.readFileSync(parentPath).equals(before)).toBe(true);
    expect(after.schemaVersion).toBe(1);
    expect(after.lyrics).toBeUndefined();
    expect(after.resultSha256).toBe(beforeHash);
    expect(after.resultSha256).toBe(hashAnalysisResult(saved.record));
    expect(sidecar.lyrics.parentId).toBe(saved.record.id);
    expect(sidecar.lyrics.parentResultSha256).toBe(beforeHash);
    expect(sidecar.lyrics.schemaVersion).toBe(1);
    expect(sidecar.created).toBe(true);
    expect((await listAnalysisRecords(options)).records).toHaveLength(1);
  });

  it('saves and reloads LRCLIB and imported LRC without inference fields', async () => {
    const options = optionsFor(root);
    const saved = await saveAnalysisRecord(analysisDraft(), options);
    const lrclib = await saveLyricSidecar(saved.record.id, lyricDraft(saved.record.resultSha256), options);
    const loaded = await readLyricSidecar(saved.record.id, options);
    expect(loaded).toEqual(lrclib.lyrics);
    expect(loaded?.source).toBe('lrclib');
    expect(loaded?.recognizesAudio).toBe(false);
    expect(JSON.stringify(loaded)).not.toMatch(/detect-beats|recognize-chords|detect-key|faster-whisper|whisper/i);

    const imported = lyricDraft(saved.record.resultSha256, {
      source: 'local-lrc',
      granularity: 'word',
      rows: [{
        time: 1,
        text: 'Hello there',
        words: [
          { text: 'Hello', startTime: 1, endTime: 1.4 },
          { text: 'there', startTime: 1.4, endTime: 2 },
        ],
      }],
    });
    const replaced = await saveLyricSidecar(saved.record.id, imported, options);
    expect(replaced.created).toBe(false);
    expect(await readLyricSidecar(saved.record.id, options)).toMatchObject({
      source: 'local-lrc',
      granularity: 'word',
      rows: imported.rows,
    });
    expect(fs.readFileSync(path.join(root, `${saved.record.id}.json`)).includes('"lyrics"')).toBe(false);
  });

  it('treats a missing sidecar as valid and rejects plain lyrics', async () => {
    const options = optionsFor(root);
    const saved = await saveAnalysisRecord(analysisDraft(), options);
    expect(await readLyricSidecar(saved.record.id, options)).toBeNull();
    expect(await readAnalysisRecord(saved.record.id, options)).toEqual(saved.record);

    expect(() => validateLyricSidecarDraft({
      ...lyricDraft(saved.record.resultSha256),
      rows: [{ text: 'plain line without a timestamp' }],
    })).toThrow(AnalysisHistoryError);
    try {
      validateLyricSidecarDraft({
        ...lyricDraft(saved.record.resultSha256),
        rows: [{ text: 'plain line without a timestamp' }],
      });
    } catch (error) {
      expect(error).toMatchObject({ code: 'RECORD_INVALID' });
    }
    await expect(saveLyricSidecar(saved.record.id, {
      ...lyricDraft(saved.record.resultSha256),
      rows: [{ time: 1, text: '', words: null }],
    }, options)).rejects.toMatchObject({ code: 'RECORD_INVALID' });
    expect(await readLyricSidecar(saved.record.id, options)).toBeNull();
  });

  it('fails closed when the parent hash does not match and does not quarantine that sidecar', async () => {
    const options = optionsFor(root);
    const saved = await saveAnalysisRecord(analysisDraft(), options);
    const sidecarPath = path.join(root, `${saved.record.id}.lyrics.json`);
    await saveLyricSidecar(saved.record.id, lyricDraft(saved.record.resultSha256), options);
    const stored = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) as { parentResultSha256: string };
    stored.parentResultSha256 = HASH_B;
    fs.writeFileSync(sidecarPath, `${JSON.stringify(stored)}\n`);

    await expect(readLyricSidecar(saved.record.id, options)).rejects.toMatchObject({ code: 'LYRIC_PARENT_MISMATCH' });
    expect(fs.existsSync(sidecarPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(sidecarPath, 'utf8')).rows[1].text).toBe('Line one');
    await expect(saveLyricSidecar(saved.record.id, lyricDraft(HASH_B), options)).rejects.toMatchObject({
      code: 'LYRIC_PARENT_MISMATCH',
    });
    expect(fs.readFileSync(path.join(root, `${saved.record.id}.json`)).includes(HASH_B)).toBe(false);
  });

  it('drops a sidecar association when its parent is deleted and leaves the other record alone', async () => {
    const options = optionsFor(root);
    const first = await saveAnalysisRecord(analysisDraft(), options);
    const second = await saveAnalysisRecord(analysisDraft({
      source: {
        kind: 'local-audio',
        displayName: 'other.mp3',
        sizeBytes: 1400,
        contentSha256: 'c'.repeat(64),
      },
    }), options);
    await saveLyricSidecar(first.record.id, lyricDraft(first.record.resultSha256), options);
    await saveLyricSidecar(second.record.id, lyricDraft(second.record.resultSha256, {
      trackTitle: 'Other Song',
      rows: [{ time: 2, text: 'Other line', words: null }],
    }), options);
    const secondParent = fs.readFileSync(path.join(root, `${second.record.id}.json`));
    const secondSidecar = fs.readFileSync(path.join(root, `${second.record.id}.lyrics.json`));

    await deleteAnalysisRecord({ recordId: first.record.id, confirmDelete: true }, options);

    expect(fs.existsSync(path.join(root, `${first.record.id}.json`))).toBe(false);
    expect(fs.existsSync(path.join(root, `${first.record.id}.lyrics.json`))).toBe(false);
    await expect(readLyricSidecar(first.record.id, options)).rejects.toMatchObject({ code: 'RECORD_NOT_FOUND' });
    expect(fs.readFileSync(path.join(root, `${second.record.id}.json`)).equals(secondParent)).toBe(true);
    expect(fs.readFileSync(path.join(root, `${second.record.id}.lyrics.json`)).equals(secondSidecar)).toBe(true);
    expect((await readLyricSidecar(second.record.id, options))?.trackTitle).toBe('Other Song');
  });

  it('quarantines an orphan sidecar after the parent file disappears', async () => {
    const options = optionsFor(root);
    const saved = await saveAnalysisRecord(analysisDraft(), options);
    await saveLyricSidecar(saved.record.id, lyricDraft(saved.record.resultSha256), options);
    fs.rmSync(path.join(root, `${saved.record.id}.json`));

    await expect(readLyricSidecar(saved.record.id, options)).rejects.toMatchObject({ code: 'RECORD_NOT_FOUND' });
    expect(fs.existsSync(path.join(root, `${saved.record.id}.lyrics.json`))).toBe(false);
    expect(fs.readdirSync(path.join(root, 'quarantine')).some((name) => name.includes('.lyrics.json'))).toBe(true);
  });

  it('rejects a sidecar above the size limit without writing it', async () => {
    const saved = await saveAnalysisRecord(analysisDraft(), optionsFor(root));
    const parentBefore = fs.readFileSync(path.join(root, `${saved.record.id}.json`));
    await expect(saveLyricSidecar(saved.record.id, lyricDraft(saved.record.resultSha256), optionsFor(root, {
      maxRecordBytes: 64,
    }))).rejects.toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
    });
    expect(fs.existsSync(path.join(root, `${saved.record.id}.lyrics.json`))).toBe(false);
    expect(fs.readFileSync(path.join(root, `${saved.record.id}.json`)).equals(parentBefore)).toBe(true);
  });

  it('rejects an offset that leaves the lyric lines and keeps the source timestamps', async () => {
    const options = optionsFor(root);
    const saved = await saveAnalysisRecord(analysisDraft(), options);
    await expect(saveLyricSidecar(saved.record.id, lyricDraft(saved.record.resultSha256, {
      offsetSeconds: 16,
      userModified: true,
    }), options)).rejects.toMatchObject({ code: 'RECORD_INVALID' });
    await expect(saveLyricSidecar(saved.record.id, lyricDraft(saved.record.resultSha256, {
      offsetSeconds: -6,
      userModified: true,
    }), options)).rejects.toMatchObject({ code: 'RECORD_INVALID' });
    const shifted = await saveLyricSidecar(saved.record.id, lyricDraft(saved.record.resultSha256, {
      offsetSeconds: 0.5,
      userModified: true,
    }), options);
    expect(shifted.lyrics.rows[1]).toEqual({ time: 5, text: 'Line one', words: null });
    expect(shifted.lyrics.offsetSeconds).toBe(0.5);
    expect(shifted.lyrics.sourceOffsetSeconds).toBe(0);
    expect(shifted.lyrics.userModified).toBe(true);
  });

  it('replaces a sidecar atomically and keeps the previous file when the rename crashes', async () => {
    const options = optionsFor(root);
    const saved = await saveAnalysisRecord(analysisDraft(), options);
    const parentPath = path.join(root, `${saved.record.id}.json`);
    const sidecarPath = path.join(root, `${saved.record.id}.lyrics.json`);
    await saveLyricSidecar(saved.record.id, lyricDraft(saved.record.resultSha256), options);
    const parentBefore = fs.readFileSync(parentPath);
    const sidecarBefore = fs.readFileSync(sidecarPath);

    await expect(saveLyricSidecar(saved.record.id, lyricDraft(saved.record.resultSha256, {
      offsetSeconds: 0.25,
      userModified: true,
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

    expect(fs.readFileSync(parentPath).equals(parentBefore)).toBe(true);
    expect(fs.readFileSync(sidecarPath).equals(sidecarBefore)).toBe(true);
    expect(fs.readdirSync(root).some((name) => name.includes('.tmp-'))).toBe(false);
  });

  it('serializes concurrent lyric writes without changing the parent record', async () => {
    const options = optionsFor(root);
    const saved = await saveAnalysisRecord(analysisDraft(), options);
    const parentPath = path.join(root, `${saved.record.id}.json`);
    const parentBefore = fs.readFileSync(parentPath);
    const writes = await Promise.all([
      saveLyricSidecar(saved.record.id, lyricDraft(saved.record.resultSha256, {
        offsetSeconds: 0.25,
        userModified: true,
      }), { ...options, contendForLock: true }),
      saveLyricSidecar(saved.record.id, lyricDraft(saved.record.resultSha256, {
        trackTitle: 'Second write',
      }), { ...options, contendForLock: true }),
    ]);
    const loaded = await readLyricSidecar(saved.record.id, options);
    const winners = new Set(writes.map((entry) => entry.lyrics.trackTitle + String(entry.lyrics.offsetSeconds)));
    expect(winners.has(`${loaded?.trackTitle}${loaded?.offsetSeconds}`)).toBe(true);
    expect(loaded?.parentId).toBe(saved.record.id);
    expect(loaded?.parentResultSha256).toBe(saved.record.resultSha256);
    expect(fs.readFileSync(parentPath).equals(parentBefore)).toBe(true);
    expect(() => JSON.parse(fs.readFileSync(path.join(root, `${saved.record.id}.lyrics.json`), 'utf8'))).not.toThrow();
  });

  it('quarantines a corrupt sidecar and still opens the analysis record', async () => {
    const options = optionsFor(root);
    const saved = await saveAnalysisRecord(analysisDraft(), options);
    const parentPath = path.join(root, `${saved.record.id}.json`);
    const parentBefore = fs.readFileSync(parentPath);
    fs.writeFileSync(path.join(root, `${saved.record.id}.lyrics.json`), '{"rows":');

    await expect(readLyricSidecar(saved.record.id, options)).rejects.toMatchObject({ code: 'RECORD_CORRUPT' });
    expect(fs.readFileSync(parentPath).equals(parentBefore)).toBe(true);
    expect(await readAnalysisRecord(saved.record.id, options)).toEqual(saved.record);
    expect(await readLyricSidecar(saved.record.id, options)).toBeNull();
    expect(fs.existsSync(path.join(root, `${saved.record.id}.lyrics.json`))).toBe(false);
  });

  it('does not follow a symlink or persist secrets, audio, or absolute paths', async () => {
    const options = optionsFor(root);
    const saved = await saveAnalysisRecord(analysisDraft(), options);
    const outside = path.join(root, 'outside-secret.txt');
    fs.writeFileSync(outside, 'Bearer super-secret-token data:audio/wav;base64,AAAA');
    fs.symlinkSync(outside, path.join(root, `${saved.record.id}.lyrics.json`));

    await expect(readLyricSidecar(saved.record.id, options)).rejects.toMatchObject({ code: 'PATH_UNSAFE' });
    expect(fs.readFileSync(outside, 'utf8')).toContain('Bearer');
    expect(fs.readFileSync(path.join(root, `${saved.record.id}.json`), 'utf8')).not.toContain('Bearer');
    expect(fs.existsSync(path.join(root, `${saved.record.id}.lyrics.json`))).toBe(false);

    await expect(saveLyricSidecar(saved.record.id, lyricDraft(saved.record.resultSha256, {
      artist: 'Bearer stored-token',
    }), options)).rejects.toBeInstanceOf(AnalysisHistoryError);
    await expect(saveLyricSidecar(saved.record.id, {
      ...lyricDraft(saved.record.resultSha256),
      token: 'desktop-cookie',
    }, options)).rejects.toMatchObject({ code: 'RECORD_INVALID' });
    await expect(saveLyricSidecar(saved.record.id, lyricDraft(saved.record.resultSha256, {
      trackTitle: '/home/user/song.mp3',
    }), options)).rejects.toMatchObject({ code: 'RECORD_INVALID' });
    await expect(saveLyricSidecar('../etc/passwd', lyricDraft(saved.record.resultSha256), options)).rejects.toMatchObject({
      code: 'PATH_UNSAFE',
    });

    const stored = await saveLyricSidecar(saved.record.id, lyricDraft(saved.record.resultSha256), options);
    const text = fs.readFileSync(path.join(root, `${saved.record.id}.lyrics.json`), 'utf8');
    expect(text).not.toMatch(/Bearer|data:audio|\/home\/|secret|password/i);
    expect(text).not.toMatch(/\.mp3|\.wav|\\\\/);
    expect(stored.lyrics.rows[1].time).toBe(5);
    await deleteLyricSidecar(saved.record.id, options);
    expect(fs.existsSync(path.join(root, `${saved.record.id}.lyrics.json`))).toBe(false);
    expect(fs.existsSync(path.join(root, `${saved.record.id}.json`))).toBe(true);
  });

  it('restores lyrics when deleting the sidecar succeeds and deleting the parent fails', async () => {
    const options = optionsFor(root);
    const saved = await saveAnalysisRecord(analysisDraft(), options);
    const stored = await saveLyricSidecar(saved.record.id, lyricDraft(saved.record.resultSha256), options);
    const parentPath = path.join(root, `${saved.record.id}.json`);
    const sidecarPath = path.join(root, `${saved.record.id}.lyrics.json`);
    const parentBefore = fs.readFileSync(parentPath);
    const sidecarBefore = fs.readFileSync(sidecarPath);

    await expect(deleteAnalysisRecord({ recordId: saved.record.id, confirmDelete: true }, {
      ...options,
      fault: {
        beforeParentUnlink() {
          const error = new Error('unlink failed') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        },
      },
    })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });

    expect(fs.readFileSync(parentPath).equals(parentBefore)).toBe(true);
    expect(fs.readFileSync(sidecarPath).equals(sidecarBefore)).toBe(true);
    expect(fs.readdirSync(root).some((name) => name.includes('pending-delete'))).toBe(false);
    expect(await readLyricSidecar(saved.record.id, options)).toMatchObject({
      schemaVersion: 1,
      parentId: saved.record.id,
      parentResultSha256: saved.record.resultSha256,
      rows: stored.lyrics.rows,
    });
  });

  it('keeps a readable sidecar when a parent delete fails while another save is waiting', async () => {
    const options = optionsFor(root);
    const saved = await saveAnalysisRecord(analysisDraft(), options);
    await saveLyricSidecar(saved.record.id, lyricDraft(saved.record.resultSha256), options);
    const parentPath = path.join(root, `${saved.record.id}.json`);
    const parentBefore = fs.readFileSync(parentPath);
    let waiting: Promise<unknown> | undefined;

    await expect(deleteAnalysisRecord({ recordId: saved.record.id, confirmDelete: true }, {
      ...options,
      onLocked: () => {
        waiting = saveLyricSidecar(saved.record.id, lyricDraft(saved.record.resultSha256, {
          trackTitle: 'Kept after failed delete',
        }), { ...options, contendForLock: true });
      },
      fault: {
        beforeParentUnlink() {
          const error = new Error('unlink failed') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        },
      },
    })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });

    const written = await waiting as { lyrics: { trackTitle: string; parentId: string; parentResultSha256: string; schemaVersion: number } };
    expect(written.lyrics).toMatchObject({
      schemaVersion: 1,
      parentId: saved.record.id,
      parentResultSha256: saved.record.resultSha256,
      trackTitle: 'Kept after failed delete',
    });
    expect(fs.readFileSync(parentPath).equals(parentBefore)).toBe(true);
    expect((await readLyricSidecar(saved.record.id, options))?.trackTitle).toBe('Kept after failed delete');
    expect(fs.readdirSync(root).some((name) => name.includes('pending-delete'))).toBe(false);
  });

  it('ends a concurrent save and parent delete with either both files or neither', async () => {
    const options = optionsFor(root);
    const saved = await saveAnalysisRecord(analysisDraft(), options);
    const other = await saveAnalysisRecord(analysisDraft({
      source: {
        kind: 'local-audio',
        displayName: 'other.mp3',
        sizeBytes: 1500,
        contentSha256: 'c'.repeat(64),
      },
    }), options);
    await saveLyricSidecar(saved.record.id, lyricDraft(saved.record.resultSha256), options);
    await saveLyricSidecar(other.record.id, lyricDraft(other.record.resultSha256, {
      trackTitle: 'Other Song',
    }), options);
    const parentPath = path.join(root, `${saved.record.id}.json`);
    const sidecarPath = path.join(root, `${saved.record.id}.lyrics.json`);
    const otherSidecar = fs.readFileSync(path.join(root, `${other.record.id}.lyrics.json`));
    const parentBefore = fs.readFileSync(parentPath);

    const settled = await Promise.allSettled([
      deleteAnalysisRecord({ recordId: saved.record.id, confirmDelete: true }, { ...options, contendForLock: true }),
      saveLyricSidecar(saved.record.id, lyricDraft(saved.record.resultSha256, {
        trackTitle: 'Race write',
      }), { ...options, contendForLock: true }),
    ]);

    const parentExists = fs.existsSync(parentPath);
    const sidecarExists = fs.existsSync(sidecarPath);
    if (parentExists) {
      expect(sidecarExists).toBe(true);
      expect(fs.readFileSync(parentPath).equals(parentBefore)).toBe(true);
      expect(await readLyricSidecar(saved.record.id, options)).toMatchObject({
        parentId: saved.record.id,
        parentResultSha256: saved.record.resultSha256,
        schemaVersion: 1,
      });
    } else {
      expect(sidecarExists).toBe(false);
      expect(fs.readdirSync(root).some((name) => name.includes(saved.record.id) && name.includes('pending-delete'))).toBe(false);
      expect(settled.some((entry) => entry.status === 'fulfilled')).toBe(true);
    }
    expect(fs.readFileSync(path.join(root, `${other.record.id}.lyrics.json`)).equals(otherSidecar)).toBe(true);
    expect(fs.existsSync(path.join(root, `${other.record.id}.json`))).toBe(true);
  });

  it('does not replace an existing sidecar when the parent hash or id does not match', async () => {
    const options = optionsFor(root);
    const saved = await saveAnalysisRecord(analysisDraft(), options);
    const other = await saveAnalysisRecord(analysisDraft({
      source: {
        kind: 'local-audio',
        displayName: 'other.mp3',
        sizeBytes: 1600,
        contentSha256: 'd'.repeat(64),
      },
    }), options);
    await saveLyricSidecar(saved.record.id, lyricDraft(saved.record.resultSha256), options);
    await saveLyricSidecar(other.record.id, lyricDraft(other.record.resultSha256, {
      trackTitle: 'Other Song',
    }), options);
    const sidecarPath = path.join(root, `${saved.record.id}.lyrics.json`);
    const parentPath = path.join(root, `${saved.record.id}.json`);
    const sidecarBefore = fs.readFileSync(sidecarPath);
    const parentBefore = fs.readFileSync(parentPath);
    const otherBefore = fs.readFileSync(path.join(root, `${other.record.id}.lyrics.json`));

    await expect(saveLyricSidecar(saved.record.id, lyricDraft(HASH_B), options)).rejects.toMatchObject({
      code: 'LYRIC_PARENT_MISMATCH',
    });
    expect(fs.readFileSync(sidecarPath).equals(sidecarBefore)).toBe(true);
    expect(fs.readFileSync(parentPath).equals(parentBefore)).toBe(true);
    expect(fs.readFileSync(path.join(root, `${other.record.id}.lyrics.json`)).equals(otherBefore)).toBe(true);

    const tampered = JSON.parse(sidecarBefore.toString('utf8')) as { parentId: string };
    tampered.parentId = '22222222-2222-4222-8222-222222222222';
    fs.writeFileSync(sidecarPath, `${JSON.stringify(tampered)}\n`);
    await expect(readLyricSidecar(saved.record.id, options)).rejects.toMatchObject({ code: 'LYRIC_PARENT_MISMATCH' });
    expect(fs.readFileSync(parentPath).equals(parentBefore)).toBe(true);
    expect(fs.existsSync(sidecarPath)).toBe(true);
  });

  it('leaves no sidecar when the first write crashes and restores a parked sidecar after a crash', async () => {
    const options = optionsFor(root);
    const saved = await saveAnalysisRecord(analysisDraft(), options);
    const parentPath = path.join(root, `${saved.record.id}.json`);
    const sidecarPath = path.join(root, `${saved.record.id}.lyrics.json`);
    const parentBefore = fs.readFileSync(parentPath);

    await expect(saveLyricSidecar(saved.record.id, lyricDraft(saved.record.resultSha256), {
      ...options,
      fault: {
        beforeRename() {
          const error = new Error('rename failed') as NodeJS.ErrnoException;
          error.code = 'EIO';
          throw error;
        },
      },
    })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(fs.existsSync(sidecarPath)).toBe(false);
    expect(fs.readdirSync(root).some((name) => name.includes('.tmp-'))).toBe(false);
    expect(fs.readFileSync(parentPath).equals(parentBefore)).toBe(true);

    const stored = await saveLyricSidecar(saved.record.id, lyricDraft(saved.record.resultSha256), options);
    const sidecarBytes = fs.readFileSync(sidecarPath);
    const parked = `.${saved.record.id}.lyrics.json.pending-delete-7-abc`;
    fs.renameSync(sidecarPath, path.join(root, parked));
    await recoverInterruptedWrites(options);
    expect(fs.readFileSync(sidecarPath).equals(sidecarBytes)).toBe(true);
    expect(fs.existsSync(path.join(root, parked))).toBe(false);
    expect(await readLyricSidecar(saved.record.id, options)).toMatchObject({
      schemaVersion: 1,
      parentId: stored.lyrics.parentId,
      parentResultSha256: stored.lyrics.parentResultSha256,
    });

    fs.renameSync(sidecarPath, path.join(root, parked));
    fs.rmSync(parentPath);
    await recoverInterruptedWrites(options);
    expect(fs.existsSync(path.join(root, parked))).toBe(false);
    expect(fs.existsSync(sidecarPath)).toBe(false);
    await expect(readLyricSidecar(saved.record.id, options)).rejects.toMatchObject({ code: 'RECORD_NOT_FOUND' });
  });
});
