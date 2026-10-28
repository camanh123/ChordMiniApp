/**
 * @jest-environment node
 */
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { POST } from '@/app/api/desktop/analysis-history/route';
import { createAnalysisSessionController, runGuardedAnalysis } from '@/components/analysis/localAnalysisSession';
import {
  rememberModelConfidence,
} from '@/services/audio/analysisHistoryFacts';
import { createIncrementalSha256, hashBlobSha256 } from '@/services/audio/incrementalSha256';
import {
  buildLocalHistoryDraft,
  keyFactFromDetection,
  saveCompletedLocalAnalysis,
} from '@/services/audio/localAnalysisHistory';
import type { HistoryKeyFact, HistorySaveRequest } from '@/services/audio/localAnalysisHistory';
import type { AnalysisResult, ChordDetectionResult } from '@/types/audioAnalysis';
import { catalog } from '@/i18n/catalog';

const COOKIE = 'desktop-history-cookie-02c';

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function chord(confidence?: number): ChordDetectionResult {
  const value: ChordDetectionResult = {
    chord: 'C:maj',
    start: 0,
    end: 1.25,
    time: 0,
    confidence: confidence ?? 0.8,
  };
  if (confidence !== undefined) rememberModelConfidence(value, confidence);
  return value;
}

function result(patch?: Partial<AnalysisResult>): AnalysisResult {
  return {
    chords: [chord()],
    beats: [
      { time: 0, strength: 0.8, beatNum: 1 },
      { time: 0.5, strength: 0.8, beatNum: 2 },
    ],
    synchronizedChords: [{ chord: 'C:maj', beatIndex: 0, beatNum: 1 }],
    beatModel: 'beat-transformer',
    chordModel: 'chord-cnn-lstm',
    audioDuration: 1.5,
    desktopHistory: {
      requestedBeat: 'beat-transformer',
      beatReported: 'beat-transformer',
      chordModel: 'chord-cnn-lstm',
      modelBpm: null,
      meter: null,
      downbeats: [0],
    },
    beatDetectionResult: { bpm: 120, time_signature: 4 },
    ...patch,
  };
}

function audioFile(bytes: Uint8Array, name = 'song.mp3'): File {
  return new File([bytes], name, { type: 'audio/mpeg' });
}

function requestFor(
  file: File,
  analysis: AnalysisResult,
  overrides?: Partial<HistorySaveRequest>,
): HistorySaveRequest {
  let current = true;
  let mounted = true;
  let active: File | null = file;
  return {
    token: 1,
    file,
    isCurrent: () => current,
    isMounted: () => mounted,
    activeFile: () => active,
    result: analysis,
    keyObservation: Promise.resolve(null),
    runtime: 'electron',
    analyzedAt: '2026-10-26T15:00:00.000Z',
    ...overrides,
    ...(overrides?.isCurrent ? {} : {}),
  };
}

describe('local analysis history persistence', () => {
  const original = {
    mode: process.env.CHORDMINI_DESKTOP_MODE,
    cookie: process.env.CHORDMINI_DESKTOP_COOKIE,
    dir: process.env.CHORDMINI_ANALYSIS_HISTORY_DIR,
    limit: process.env.CHORDMINI_ANALYSIS_HISTORY_MAX_BODY_BYTES,
  };
  let root = '';

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'chordmini-history-02c-'));
    process.env.CHORDMINI_DESKTOP_MODE = '1';
    process.env.CHORDMINI_DESKTOP_COOKIE = COOKIE;
    process.env.CHORDMINI_ANALYSIS_HISTORY_DIR = root;
    delete process.env.CHORDMINI_ANALYSIS_HISTORY_MAX_BODY_BYTES;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    if (original.mode === undefined) delete process.env.CHORDMINI_DESKTOP_MODE;
    else process.env.CHORDMINI_DESKTOP_MODE = original.mode;
    if (original.cookie === undefined) delete process.env.CHORDMINI_DESKTOP_COOKIE;
    else process.env.CHORDMINI_DESKTOP_COOKIE = original.cookie;
    if (original.dir === undefined) delete process.env.CHORDMINI_ANALYSIS_HISTORY_DIR;
    else process.env.CHORDMINI_ANALYSIS_HISTORY_DIR = original.dir;
    if (original.limit === undefined) delete process.env.CHORDMINI_ANALYSIS_HISTORY_MAX_BODY_BYTES;
    else process.env.CHORDMINI_ANALYSIS_HISTORY_MAX_BODY_BYTES = original.limit;
  });

  function desktopFetch(calls: string[]): HistorySaveRequest['fetchImpl'] {
    return async (url, init) => {
      calls.push(String(url));
      const request = new Request('http://127.0.0.1:4312/api/desktop/analysis-history', {
        method: 'POST',
        headers: {
          host: '127.0.0.1:4312',
          origin: 'http://127.0.0.1:4312',
          cookie: `chordmini_desktop=${COOKIE}`,
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
        },
        body: init?.body,
      });
      return POST(request);
    };
  }

  it('hashes a file incrementally and matches the byte digest', async () => {
    const bytes = new Uint8Array(70_000);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
    const hashed = await hashBlobSha256(new Blob([bytes]));
    expect(hashed.incremental).toBe(true);
    expect(hashed.digest).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(hashed.maxChunkBytes).toBeLessThanOrEqual(bytes.length);
    const direct = createIncrementalSha256();
    direct.update(bytes.subarray(0, 1000));
    direct.update(bytes.subarray(1000));
    expect(direct.digest()).toBe(hashed.digest);
  });

  it('persists one real local analysis and does not invent bpm, meter, confidence, or key', async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4, 5]);
    const file = audioFile(bytes, 'C:\\Users\\secret\\song.mp3');
    Object.defineProperty(file, 'name', { value: 'C:\\Users\\secret\\song.mp3' });
    const calls: string[] = [];
    const analysis = result();
    const outcome = await saveCompletedLocalAnalysis({
      ...requestFor(file, analysis),
      fetchImpl: desktopFetch(calls),
    });
    expect(outcome).toMatchObject({ state: 'saved', created: true, visible: true });
    expect(calls).toEqual(['/api/desktop/analysis-history']);
    const savedName = fs.readdirSync(root).find((name) => name.endsWith('.json') && name !== 'index.json');
    expect(savedName).toBeTruthy();
    const stored = JSON.parse(fs.readFileSync(path.join(root, savedName as string), 'utf8'));
    expect(stored.source.displayName).toBe('song.mp3');
    expect(stored.source.contentSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(stored.bpm).toBeNull();
    expect(stored.meter).toBeNull();
    expect(stored.key).toBeNull();
    expect(stored.chords[0].confidence).toBeUndefined();
    expect(stored.beats).toEqual([{ time: 0 }, { time: 0.5 }]);
    expect(JSON.stringify(stored)).not.toContain('secret');
    expect(JSON.stringify(stored)).not.toContain('Users');
    expect(JSON.stringify(stored)).not.toMatch(/data:audio|apiKey|\\u0000/);
    expect(stored.models).toEqual({
      beat: 'beat-transformer',
      chord: 'chord-cnn-lstm',
      beatReported: 'beat-transformer',
    });
    expect(analysis.beatDetectionResult?.bpm).toBe(120);
    expect(analysis.beatDetectionResult?.time_signature).toBe(4);
  });

  it('stores model confidence, selected meter, and a key-service result when they were actually returned', async () => {
    const file = audioFile(Uint8Array.from([9, 9, 9]));
    const withConfidence = chord(0.91);
    const analysis = result({
      chords: [withConfidence],
      desktopHistory: {
        requestedBeat: 'madmom',
        beatReported: 'madmom',
        chordModel: 'chord-cnn-lstm',
        modelBpm: 96.5,
        meter: { beatsPerBar: 3, provenance: 'madmom-candidate-selection', downbeats: [0] },
        downbeats: [0],
      },
    });
    const key: HistoryKeyFact = { value: 'C major', provenance: 'key-service' };
    const calls: string[] = [];
    const outcome = await saveCompletedLocalAnalysis({
      ...requestFor(file, analysis),
      keyObservation: Promise.resolve(key),
      fetchImpl: desktopFetch(calls),
    });
    expect(outcome.state).toBe('saved');
    const savedName = fs.readdirSync(root).find((name) => name.endsWith('.json') && name !== 'index.json');
    const stored = JSON.parse(fs.readFileSync(path.join(root, savedName as string), 'utf8'));
    expect(stored.chords[0].confidence).toEqual({ value: 0.91, provenance: 'model' });
    expect(stored.bpm).toEqual({ value: 96.5, provenance: 'model' });
    expect(stored.meter).toEqual({ beatsPerBar: 3, denominator: 4, provenance: 'madmom-candidate-selection' });
    expect(stored.key).toEqual({ value: 'C major', provenance: 'key-service' });
  });

  it('returns the existing id for the same file and result, and a new id when the model changes', async () => {
    const bytes = Uint8Array.from([4, 5, 6]);
    const file = audioFile(bytes);
    const calls: string[] = [];
    const fetchImpl = desktopFetch(calls);
    const first = await saveCompletedLocalAnalysis({
      ...requestFor(file, result()),
      fetchImpl,
    });
    const second = await saveCompletedLocalAnalysis({
      ...requestFor(file, result(), { token: 2 }),
      fetchImpl,
    });
    expect(first.state).toBe('saved');
    expect(second.state).toBe('saved');
    if (first.state === 'saved' && second.state === 'saved') {
      expect(second.id).toBe(first.id);
      expect(second.created).toBe(false);
    }
    const otherModel = result({
      chordModel: 'btc-sl',
      desktopHistory: {
        requestedBeat: 'beat-transformer',
        beatReported: 'beat-transformer',
        chordModel: 'btc-sl',
        modelBpm: null,
        meter: null,
        downbeats: [0],
      },
    });
    const third = await saveCompletedLocalAnalysis({
      ...requestFor(file, otherModel, { token: 3 }),
      fetchImpl,
    });
    expect(third.state).toBe('saved');
    if (first.state === 'saved' && third.state === 'saved') {
      expect(third.id).not.toBe(first.id);
    }
    expect(calls.every((url) => url === '/api/desktop/analysis-history')).toBe(true);
  });

  it('keeps different audio with the same filename as different records', async () => {
    const calls: string[] = [];
    const fetchImpl = desktopFetch(calls);
    const left = audioFile(Uint8Array.from([1]), 'take.wav');
    const right = audioFile(Uint8Array.from([2]), 'take.wav');
    const first = await saveCompletedLocalAnalysis({ ...requestFor(left, result()), fetchImpl });
    const second = await saveCompletedLocalAnalysis({
      ...requestFor(right, result(), { token: 2 }),
      fetchImpl,
    });
    expect(first.state).toBe('saved');
    expect(second.state).toBe('saved');
    if (first.state === 'saved' && second.state === 'saved') {
      expect(second.id).not.toBe(first.id);
    }
  });

  it('does not dispatch a save for a failed, partial, stale, cleared, or unmounted analysis', async () => {
    const calls: string[] = [];
    const fetchImpl = desktopFetch(calls);
    const file = audioFile(Uint8Array.from([7]));
    const session = createAnalysisSessionController();
    const pending = deferred<AnalysisResult>();
    const saves: string[] = [];
    const token = session.start();
    const guarded = runGuardedAnalysis(
      session,
      token,
      pending.promise,
      () => { saves.push('dispatch'); },
      () => { saves.push('fail'); },
    );
    session.invalidate();
    pending.resolve(result());
    await guarded;

    const failedSession = createAnalysisSessionController();
    const failedToken = failedSession.start();
    const failedRun = runGuardedAnalysis(
      failedSession,
      failedToken,
      Promise.reject(new Error('beat detection failed')),
      () => { saves.push('dispatch-after-failure'); },
      () => { saves.push('analysis-failed'); },
    );
    await failedRun;
    expect(saves).toEqual(['analysis-failed']);

    await expect(saveCompletedLocalAnalysis({
      ...requestFor(file, result({ chords: [] })),
      fetchImpl,
      keyObservation: {
        then() {
          throw new Error('incomplete analysis must not wait for key detection');
        },
      } as unknown as Promise<HistoryKeyFact | null>,
    })).resolves.toMatchObject({ state: 'skipped', reason: 'incomplete' });

    let mounted = true;
    let active: File | null = file;
    let current = true;
    const gate = deferred<HistoryKeyFact | null>();
    const hashGate = deferred<void>();
    const slow = saveCompletedLocalAnalysis({
      ...requestFor(file, result()),
      isCurrent: () => current,
      isMounted: () => mounted,
      activeFile: () => active,
      keyObservation: gate.promise,
      fetchImpl,
      hashImpl: async (blob) => {
        await hashGate.promise;
        return hashBlobSha256(blob);
      },
    });
    current = false;
    gate.resolve(null);
    hashGate.resolve();
    await expect(slow).resolves.toMatchObject({ state: 'skipped', reason: 'stale' });

    current = true;
    const clearedGate = deferred<void>();
    const clearedKey = deferred<HistoryKeyFact | null>();
    const cleared = saveCompletedLocalAnalysis({
      ...requestFor(file, result()),
      isCurrent: () => true,
      isMounted: () => true,
      activeFile: () => active,
      keyObservation: clearedKey.promise,
      fetchImpl,
      hashImpl: async (blob) => {
        await clearedGate.promise;
        return hashBlobSha256(blob);
      },
    });
    active = null;
    clearedKey.resolve(null);
    clearedGate.resolve();
    await expect(cleared).resolves.toMatchObject({ state: 'skipped', reason: 'cleared' });

    active = file;
    const unmountGate = deferred<void>();
    const unmountKey = deferred<HistoryKeyFact | null>();
    const unmounted = saveCompletedLocalAnalysis({
      ...requestFor(file, result()),
      isCurrent: () => true,
      isMounted: () => mounted,
      activeFile: () => active,
      keyObservation: unmountKey.promise,
      fetchImpl,
      hashImpl: async (blob) => {
        await unmountGate.promise;
        return hashBlobSha256(blob);
      },
    });
    mounted = false;
    unmountKey.resolve(null);
    unmountGate.resolve();
    await expect(unmounted).resolves.toMatchObject({ state: 'skipped', reason: 'unmounted' });
    expect(calls).toEqual([]);
  });

  it('keeps the analysis visible when a late response, storage error, or network error arrives', async () => {
    const file = audioFile(Uint8Array.from([3, 3]));
    const analysis = result();
    let current = true;
    let release: (response: Response) => void = () => {};
    let markEntered: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const responsePromise = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const late = saveCompletedLocalAnalysis({
      ...requestFor(file, analysis),
      isCurrent: () => current,
      fetchImpl: async () => {
        markEntered();
        return responsePromise;
      },
    });
    await entered;
    current = false;
    release(new Response(JSON.stringify({ ok: true, id: 'already-accepted', created: true }), { status: 201 }));
    const lateOutcome = await late;
    expect(lateOutcome).toMatchObject({ state: 'saved', visible: false, id: 'already-accepted' });
    let notice: string | null = null;
    if (lateOutcome.state === 'saved' && lateOutcome.visible) notice = 'saved';
    expect(notice).toBeNull();
    expect(analysis.chords).toHaveLength(1);

    process.env.CHORDMINI_ANALYSIS_HISTORY_MAX_BODY_BYTES = '32';
    const tooLarge = await saveCompletedLocalAnalysis({
      ...requestFor(file, analysis),
      fetchImpl: desktopFetch([]),
    });
    expect(tooLarge).toMatchObject({ state: 'failed', reason: 'storage', visible: true });
    expect(analysis.beatDetectionResult?.bpm).toBe(120);

    delete process.env.CHORDMINI_ANALYSIS_HISTORY_MAX_BODY_BYTES;
    const link = path.join(root, 'link');
    fs.symlinkSync(root, link);
    process.env.CHORDMINI_ANALYSIS_HISTORY_DIR = link;
    const unavailable = await saveCompletedLocalAnalysis({
      ...requestFor(file, analysis),
      fetchImpl: desktopFetch([]),
    });
    expect(unavailable).toMatchObject({ state: 'failed', reason: 'storage', visible: true });

    const interrupted = await saveCompletedLocalAnalysis({
      ...requestFor(file, analysis),
      fetchImpl: async () => {
        throw new Error('socket hang up at /tmp/private/history');
      },
    });
    expect(interrupted).toMatchObject({ state: 'failed', reason: 'network', visible: true });
    expect(JSON.stringify(interrupted)).not.toContain('/tmp/private');
  });

  it('does not call the desktop history API from the website or an installed PWA', async () => {
    const file = audioFile(Uint8Array.from([8]));
    const fetchImpl = jest.fn();
    await expect(saveCompletedLocalAnalysis({
      ...requestFor(file, result(), { runtime: 'web', fetchImpl }),
    })).resolves.toMatchObject({ state: 'skipped', reason: 'not-desktop' });
    await expect(saveCompletedLocalAnalysis({
      ...requestFor(file, result(), { runtime: 'pwa', fetchImpl }),
    })).resolves.toMatchObject({ state: 'skipped', reason: 'not-desktop' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('retries the history request without describing the fixture as inference', async () => {
    const calls: string[] = [];
    let failed = true;
    const fetchImpl: HistorySaveRequest['fetchImpl'] = async (url, init) => {
      calls.push(String(url));
      if (failed) {
        failed = false;
        return new Response(JSON.stringify({ ok: false, code: 'STORAGE_UNAVAILABLE' }), { status: 503 });
      }
      return desktopFetch([])(url, init);
    };
    const file = audioFile(Uint8Array.from([6, 1]));
    const base = requestFor(file, result());
    const first = await saveCompletedLocalAnalysis({ ...base, fetchImpl });
    expect(first).toMatchObject({ state: 'failed', reason: 'storage' });
    const retry = await saveCompletedLocalAnalysis({ ...base, fetchImpl });
    expect(retry).toMatchObject({ state: 'saved', created: true });
    expect(calls).toEqual(['/api/desktop/analysis-history', '/api/desktop/analysis-history']);
  });

  it('rejects a UI heuristic key and keeps the Vietnamese failure copy', () => {
    expect(keyFactFromDetection({
      primaryKey: 'G major',
      modulation: null,
      fromHeuristicFallback: true,
    })).toBeNull();
    expect(keyFactFromDetection({ primaryKey: 'Unknown', modulation: null })).toBeNull();
    expect(catalog['analyze.historyFailed']['vi-VN']).toBe('Đã phân tích thành công nhưng chưa lưu được lịch sử.');
    const draft = buildLocalHistoryDraft({
      file: audioFile(Uint8Array.from([1]), 'song.mp3'),
      contentSha256: 'ab'.repeat(32),
      result: result(),
      analyzedAt: '2026-10-26T15:00:00.000Z',
      key: null,
    });
    expect(draft?.bpm).toBeNull();
    expect(draft?.meter).toBeNull();
    expect(draft?.key).toBeNull();
    expect(JSON.stringify(draft)).not.toContain('0.8');
  });
});
