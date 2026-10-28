/**
 * @jest-environment node
 *
 * Desktop history library against the authorized history API.
 * Saved fixtures are stored records, not a new inference run.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { DELETE, GET as readRecord } from '@/app/api/desktop/analysis-history/[id]/route';
import { GET as listRecords, POST as createRecord } from '@/app/api/desktop/analysis-history/route';
import { DESKTOP_COOKIE_NAME } from '@/desktop/desktopSecurity';
import {
  cardFromSummary,
  deleteHistoryRecord,
  fetchHistoryRecord,
  filterHistoryByFilename,
  HISTORY_CARD_PAGE_SIZE,
  isInferenceRequest,
  loadDesktopHistory,
  pageHistoryCards,
  relinkHistoryAudio,
  restoreHistoryRecord,
  selectHomeHistorySource,
} from '@/services/audio/desktopHistoryLibrary';

const COOKIE = 'desktop-cookie-value';
const HOST = '127.0.0.1:4312';
const ORIGIN = `http://${HOST}`;

function digestFor(index: number): string {
  return createHash('sha256').update(`local-audio-${index}`).digest('hex');
}

function stamp(index: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
}

function draft(index: number): Record<string, unknown> {
  const rich = index === 199;
  const labels = rich
    ? ['C', 'C', 'G', 'Am', 'F', 'Dm', 'Em', 'B', 'E', 'A']
    : ['Am'];
  return {
    schemaVersion: 1,
    source: {
      kind: 'local-audio',
      displayName: `song-${String(index).padStart(3, '0')}.mp3`,
      sizeBytes: 1000 + index,
      contentSha256: digestFor(index),
    },
    analyzedAt: stamp(index),
    audioDurationSeconds: rich ? 186.2 : null,
    models: { beat: 'madmom', chord: 'chord-cnn-lstm', beatReported: 'madmom' },
    chords: labels.map((label, chordIndex) => ({
      chord: label,
      start: chordIndex + 0.125,
      end: chordIndex + 0.875,
      ...(rich && chordIndex === 0 ? { confidence: { value: 0.64, provenance: 'model' } } : {}),
    })),
    beats: [{ time: 0.125 }, { time: 1.125 }],
    downbeats: rich ? { times: [0.125], provenance: 'model' } : null,
    synchronizedChords: rich ? [{ chord: 'C', beatIndex: 0, beatNum: 1 }] : null,
    meter: rich ? { beatsPerBar: 3, denominator: 4, provenance: 'madmom-candidate-selection' } : null,
    bpm: rich ? { value: 96, provenance: 'model' } : null,
    key: rich ? { value: 'D minor', provenance: 'key-service' } : null,
    status: 'complete',
    provenance: { pipeline: 'local-upload-v1' },
  };
}

function authorizedFetch(calls: string[]): typeof fetch {
  return async (input, init) => {
    const raw = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    calls.push(`${init?.method ?? 'GET'} ${raw}`);
    if (isInferenceRequest(raw)) {
      throw new Error(`history replay called inference: ${raw}`);
    }
    const url = new URL(raw, ORIGIN);
    const headers = new Headers(init?.headers);
    headers.set('host', HOST);
    headers.set('origin', ORIGIN);
    headers.set('cookie', `${DESKTOP_COOKIE_NAME}=${COOKIE}`);
    headers.set('sec-fetch-site', 'same-origin');
    const request = new NextRequest(`${ORIGIN}${url.pathname}${url.search}`, {
      method: init?.method ?? 'GET',
      headers,
      body: init?.body,
    });
    if (url.pathname === '/api/desktop/analysis-history') {
      return request.method === 'POST' ? createRecord(request) : listRecords(request);
    }
    const id = url.pathname.split('/').pop() ?? '';
    if (request.method === 'DELETE') return DELETE(request, { params: { id } });
    return readRecord(request, { params: { id } });
  };
}

describe('desktop history library', () => {
  jest.setTimeout(180000);
  let root = '';
  const roots: string[] = [];
  const previous = {
    mode: process.env.CHORDMINI_DESKTOP_MODE,
    cookie: process.env.CHORDMINI_DESKTOP_COOKIE,
    dir: process.env.CHORDMINI_ANALYSIS_HISTORY_DIR,
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'chordmini-history-ui-'));
    roots.push(root);
    process.env.CHORDMINI_DESKTOP_MODE = '1';
    process.env.CHORDMINI_DESKTOP_COOKIE = COOKIE;
    process.env.CHORDMINI_ANALYSIS_HISTORY_DIR = root;
  });

  afterEach(() => {
    process.env.CHORDMINI_DESKTOP_MODE = previous.mode;
    process.env.CHORDMINI_DESKTOP_COOKIE = previous.cookie;
    process.env.CHORDMINI_ANALYSIS_HISTORY_DIR = previous.dir;
  });

  afterAll(() => {
    for (const directory of roots) fs.rmSync(directory, { recursive: true, force: true });
  });

  it('chooses local history only for Electron', () => {
    expect(selectHomeHistorySource('electron')).toBe('local');
    expect(selectHomeHistorySource('web')).toBe('firestore');
    expect(selectHomeHistorySource('pwa')).toBe('firestore');
    expect(isInferenceRequest('/api/detect-beats')).toBe(true);
    expect(isInferenceRequest('/api/recognize-chords')).toBe(true);
    expect(isInferenceRequest('/api/detect-key')).toBe(true);
    expect(isInferenceRequest('/api/desktop/analysis-history')).toBe(false);
  });

  it('keeps fabricated BPM, key, and meter off a stored summary', () => {
    const card = cardFromSummary({
      schemaVersion: 1,
      id: '11111111-1111-4111-8111-111111111111',
      source: { displayName: 'plain.mp3' },
      analyzedAt: '2026-10-26T14:03:05.123Z',
      models: { beat: 'madmom', chord: 'chord-cnn-lstm' },
      bpm: 120,
      key: 'C major',
      meter: { beatsPerBar: 4, denominator: 4 },
      chordPreview: ['Am', ''],
    });
    expect(card).toMatchObject({
      filename: 'plain.mp3',
      bpm: null,
      keyName: null,
      meterLabel: null,
      chordPreview: ['Am'],
    });
  });

  it('pages 200 stored records newest first and restores them without inference', async () => {
    const calls: string[] = [];
    const fetchImpl = authorizedFetch(calls);
    for (let index = 0; index < 200; index += 1) {
      const created = await createRecord(new NextRequest(`${ORIGIN}/api/desktop/analysis-history`, {
        method: 'POST',
        headers: {
          host: HOST,
          origin: ORIGIN,
          cookie: `${DESKTOP_COOKIE_NAME}=${COOKIE}`,
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
        },
        body: JSON.stringify(draft(index)),
      }));
      expect(created.status).toBe(201);
    }

    const loaded = await loadDesktopHistory(fetchImpl);
    expect(loaded.state).toBe('ready');
    if (loaded.state !== 'ready') return;
    expect(loaded.records).toHaveLength(200);
    expect(loaded.records[0].filename).toBe('song-199.mp3');
    expect(loaded.records[199].filename).toBe('song-000.mp3');
    expect(loaded.records[0].chordPreview).toEqual(['C', 'G', 'Am', 'F', 'Dm', 'Em', 'B', 'E']);
    expect(loaded.records[0].bpm).toBe(96);
    expect(loaded.records[0].keyName).toBe('D minor');
    expect(loaded.records[0].meterLabel).toBe('3/4');
    expect(loaded.records[0].durationSeconds).toBe(186.2);
    expect(loaded.records[1].bpm).toBeNull();
    expect(loaded.records[1].keyName).toBeNull();
    expect(loaded.records[1].meterLabel).toBeNull();
    expect(calls.every((call) => call.startsWith('GET /api/desktop/analysis-history?'))).toBe(true);
    expect(calls).toHaveLength(4);

    const firstPage = pageHistoryCards(loaded.records, 0, HISTORY_CARD_PAGE_SIZE);
    const lastPage = pageHistoryCards(loaded.records, 16, HISTORY_CARD_PAGE_SIZE);
    expect(firstPage.pageCount).toBe(17);
    expect(firstPage.page).toHaveLength(12);
    expect(firstPage.page[0].filename).toBe('song-199.mp3');
    expect(lastPage.page).toHaveLength(8);
    expect(lastPage.page[lastPage.page.length - 1].filename).toBe('song-000.mp3');
    expect(filterHistoryByFilename(loaded.records, 'SONG-042.mp3').map((card) => card.filename)).toEqual(['song-042.mp3']);

    const reopened = await loadDesktopHistory(fetchImpl);
    expect(reopened.state).toBe('ready');
    if (reopened.state !== 'ready') return;
    expect(reopened.records.map((card) => card.id)).toEqual(loaded.records.map((card) => card.id));

    const newest = await fetchHistoryRecord(loaded.records[0].id, fetchImpl);
    expect(newest.state).toBe('ready');
    if (newest.state !== 'ready') return;
    expect(newest.record.chords[0]).toEqual({ chord: 'C', start: 0.125, end: 0.875, confidence: 0.64 });
    expect(newest.record.chords[1].start).toBe(1.125);
    expect(newest.record.beats.map((beat) => beat.time)).toEqual([0.125, 1.125]);
    expect(newest.record.downbeats).toEqual([0.125]);
    expect(newest.record.synchronizedChords).toEqual([{ chord: 'C', beatIndex: 0, beatNum: 1 }]);
    expect(newest.record.bpm).toBe(96);
    expect(newest.record.keyName).toBe('D minor');
    expect(newest.record.meterLabel).toBe('3/4');

    const plain = await fetchHistoryRecord(loaded.records[1].id, fetchImpl);
    expect(plain.state).toBe('ready');
    if (plain.state !== 'ready') return;
    expect(plain.record.bpm).toBeNull();
    expect(plain.record.keyName).toBeNull();
    expect(plain.record.meterLabel).toBeNull();
    expect(plain.record.durationSeconds).toBeNull();
    expect(plain.record.chords[0].confidence).toBeNull();
    expect(plain.record.chords[0].start).toBe(0.125);
    expect(calls.some((call) => isInferenceRequest(call))).toBe(false);

    const removedId = loaded.records[199].id;
    const keptId = loaded.records[198].id;
    const before = fs.readdirSync(root);
    expect(await deleteHistoryRecord(removedId, fetchImpl)).toBe('deleted');
    const afterDelete = await loadDesktopHistory(fetchImpl);
    expect(afterDelete.state).toBe('ready');
    if (afterDelete.state !== 'ready') return;
    expect(afterDelete.records).toHaveLength(199);
    expect(afterDelete.records.some((card) => card.id === removedId)).toBe(false);
    expect(afterDelete.records.some((card) => card.id === keptId)).toBe(true);
    expect(fs.existsSync(path.join(root, `${removedId}.json`))).toBe(false);
    expect(fs.existsSync(path.join(root, `${keptId}.json`))).toBe(true);
    expect(before.filter((name) => name.endsWith('.mp3') || name.endsWith('.wav'))).toEqual([]);
  });

  it('reports corrupt and unsupported records without dropping the saved library', async () => {
    const calls: string[] = [];
    const fetchImpl = authorizedFetch(calls);
    const created = await createRecord(new NextRequest(`${ORIGIN}/api/desktop/analysis-history`, {
      method: 'POST',
      headers: {
        host: HOST,
        origin: ORIGIN,
        cookie: `${DESKTOP_COOKIE_NAME}=${COOKIE}`,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
      body: JSON.stringify(draft(1)),
    }));
    const id = ((await created.json()) as { id: string }).id;
    const corruptId = '22222222-2222-4222-8222-222222222222';
    const unsupportedId = '33333333-3333-4333-8333-333333333333';
    fs.writeFileSync(path.join(root, `${unsupportedId}.json`), JSON.stringify({ schemaVersion: 2 }));
    expect((await fetchHistoryRecord(unsupportedId, fetchImpl)).state).toBe('unsupported');
    fs.writeFileSync(path.join(root, `${corruptId}.json`), '{');
    expect((await fetchHistoryRecord(corruptId, fetchImpl)).state).toBe('corrupt');
    expect((await fetchHistoryRecord('not-a-uuid', fetchImpl)).state).toBe('missing');
    const library = await loadDesktopHistory(fetchImpl);
    expect(library.state).toBe('ready');
    if (library.state !== 'ready') return;
    expect(library.records.map((card) => card.id)).toEqual([id]);
    expect(calls.some((call) => call.includes('not-a-uuid'))).toBe(false);
  });

  it('keeps an unavailable storage root from looking like an empty library write', async () => {
    const real = path.join(root, 'real');
    const link = path.join(root, 'link');
    fs.mkdirSync(real);
    fs.symlinkSync(real, link);
    process.env.CHORDMINI_ANALYSIS_HISTORY_DIR = link;
    const loaded = await loadDesktopHistory(authorizedFetch([]));
    expect(loaded).toEqual({ state: 'unavailable', records: [] });
    expect(fs.readdirSync(real)).toEqual([]);
  });

  it('relinks only a byte-for-byte match and does not rewrite the saved record', async () => {
    const created = await createRecord(new NextRequest(`${ORIGIN}/api/desktop/analysis-history`, {
      method: 'POST',
      headers: {
        host: HOST,
        origin: ORIGIN,
        cookie: `${DESKTOP_COOKIE_NAME}=${COOKIE}`,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
      body: JSON.stringify(draft(4)),
    }));
    const id = ((await created.json()) as { id: string }).id;
    const storedPath = path.join(root, `${id}.json`);
    const before = fs.readFileSync(storedPath);
    const bytes = Buffer.from('matched-audio-bytes');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const matched = new File([bytes], 'song-004.mp3', { type: 'audio/mpeg' });
    const wrong = new File([Buffer.from('different-audio')], 'other.mp3', { type: 'audio/mpeg' });
    (global.fetch as jest.Mock).mockClear();

    expect(await relinkHistoryAudio(matched, digest)).toEqual({ ok: true, digest });
    expect(await relinkHistoryAudio(wrong, digest)).toEqual({ ok: false, reason: 'mismatch' });
    expect(fs.readFileSync(storedPath).equals(before)).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('restores exact timestamps and drops optional fields that lack provenance', () => {
    const restored = restoreHistoryRecord({
      schemaVersion: 1,
      id: '11111111-1111-4111-8111-111111111111',
      source: {
        displayName: 'plain.mp3',
        contentSha256: 'a'.repeat(64),
      },
      analyzedAt: '2026-10-26T14:03:05.123Z',
      models: { beat: 'madmom', chord: 'chord-cnn-lstm' },
      chords: [{ chord: 'Am', start: 0.25, end: 1.5, confidence: 0.8 }],
      beats: [{ time: 0.25 }, { time: 1.25 }],
      bpm: { value: 120, provenance: 'ui-default' },
      key: { value: 'C major', provenance: 'heuristic' },
      meter: { beatsPerBar: 4, denominator: 4, provenance: 'display-default' },
      synchronizedChords: [{ chord: 'Am', beatIndex: 9 }],
    });
    expect(restored.state).toBe('ready');
    if (restored.state !== 'ready') return;
    expect(restored.record.chords[0]).toEqual({ chord: 'Am', start: 0.25, end: 1.5, confidence: null });
    expect(restored.record.beats).toEqual([{ time: 0.25 }, { time: 1.25 }]);
    expect(restored.record.bpm).toBeNull();
    expect(restored.record.keyName).toBeNull();
    expect(restored.record.meterLabel).toBeNull();
    expect(restored.record.synchronizedChords).toBeNull();
    expect(restoreHistoryRecord({ schemaVersion: 2 }).state).toBe('unsupported');
  });
});
