/**
 * @jest-environment node
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { DELETE, GET, POST } from '@/app/api/desktop/analysis-history/[id]/lyrics/route';
import { POST as createRecord } from '@/app/api/desktop/analysis-history/route';
import { DESKTOP_COOKIE_NAME } from '@/desktop/desktopSecurity';

const COOKIE = 'desktop-cookie-value';
const HOST = '127.0.0.1:4312';
const ORIGIN = `http://${HOST}`;

function analysisDraft(): Record<string, unknown> {
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
  };
}

function lyricBody(parentResultSha256: string): Record<string, unknown> {
  return {
    parentResultSha256,
    source: 'local-lrc',
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
    rows: [{ time: 5, text: 'Line one', words: null }],
  };
}

function request(
  method: string,
  pathname: string,
  body?: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  const headerBag = new Headers({
    host: HOST,
    origin: ORIGIN,
    cookie: `${DESKTOP_COOKIE_NAME}=${COOKIE}`,
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
    ...headers,
  });
  return new NextRequest(`${ORIGIN}${pathname}`, {
    method,
    headers: headerBag,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('desktop lyric sidecar API', () => {
  let root = '';
  const roots: string[] = [];
  const previous = {
    mode: process.env.CHORDMINI_DESKTOP_MODE,
    cookie: process.env.CHORDMINI_DESKTOP_COOKIE,
    dir: process.env.CHORDMINI_ANALYSIS_HISTORY_DIR,
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'chordmini-lyric-api-'));
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

  it('rejects web mode, missing authorization, and cross-origin lyric writes', async () => {
    delete process.env.CHORDMINI_DESKTOP_MODE;
    const id = '11111111-1111-4111-8111-111111111111';
    const web = await GET(request('GET', `/api/desktop/analysis-history/${id}/lyrics`), { params: { id } });
    expect(web.status).toBe(404);
    expect(await web.json()).toEqual({ ok: false });
    expect(fs.readdirSync(root)).toEqual([]);

    process.env.CHORDMINI_DESKTOP_MODE = '1';
    const anonymous = await GET(request('GET', `/api/desktop/analysis-history/${id}/lyrics`, undefined, {
      cookie: '',
    }), { params: { id } });
    expect(anonymous.status).toBe(403);

    const crossOrigin = await POST(request('POST', `/api/desktop/analysis-history/${id}/lyrics`, { rows: [] }, {
      origin: 'http://127.0.0.1:9999',
    }), { params: { id } });
    expect(crossOrigin.status).toBe(403);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('saves lyrics for the created analysis and reports a parent mismatch without lyric text', async () => {
    const created = await createRecord(request('POST', '/api/desktop/analysis-history', analysisDraft()));
    const createdBody = await created.json() as { id: string; record: { resultSha256: string } };
    const id = createdBody.id;
    const parentBefore = fs.readFileSync(path.join(root, `${id}.json`));

    const missing = await GET(request('GET', `/api/desktop/analysis-history/${id}/lyrics`), { params: { id } });
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({ ok: true, lyrics: null });

    const saved = await POST(
      request('POST', `/api/desktop/analysis-history/${id}/lyrics`, lyricBody(createdBody.record.resultSha256)),
      { params: { id } },
    );
    expect(saved.status).toBe(201);
    const savedBody = await saved.json() as { ok: boolean; lyrics: { parentId: string; parentResultSha256: string; rows: Array<{ time: number }> } };
    expect(savedBody.ok).toBe(true);
    expect(savedBody.lyrics.parentId).toBe(id);
    expect(savedBody.lyrics.parentResultSha256).toBe(createdBody.record.resultSha256);
    expect(savedBody.lyrics.rows[0].time).toBe(5);
    expect(fs.readFileSync(path.join(root, `${id}.json`)).equals(parentBefore)).toBe(true);

    const mismatch = await POST(
      request('POST', `/api/desktop/analysis-history/${id}/lyrics`, lyricBody('b'.repeat(64))),
      { params: { id } },
    );
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toEqual({ ok: false, code: 'LYRIC_PARENT_MISMATCH' });

    const traversal = await GET(request('GET', '/api/desktop/analysis-history/../lyrics'), {
      params: { id: '../etc/passwd' },
    });
    expect(traversal.status).toBe(400);
    expect(await traversal.json()).toEqual({ ok: false, code: 'PATH_UNSAFE' });
  });
});
