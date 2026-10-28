/**
 * @jest-environment node
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { DELETE, GET as readRecord } from '@/app/api/desktop/analysis-history/[id]/route';
import { POST as openRecord } from '@/app/api/desktop/analysis-history/[id]/opened/route';
import { GET as listRecords, POST as createRecord } from '@/app/api/desktop/analysis-history/route';
import { DESKTOP_COOKIE_NAME } from '@/desktop/desktopSecurity';

const COOKIE = 'desktop-cookie-value';
const HOST = '127.0.0.1:4312';
const ORIGIN = `http://${HOST}`;
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const UUID_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;

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
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

describe('desktop analysis history API', () => {
  let root = '';
  const roots: string[] = [];
  const previous = {
    mode: process.env.CHORDMINI_DESKTOP_MODE,
    cookie: process.env.CHORDMINI_DESKTOP_COOKIE,
    dir: process.env.CHORDMINI_ANALYSIS_HISTORY_DIR,
    limit: process.env.CHORDMINI_ANALYSIS_HISTORY_MAX_BODY_BYTES,
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'chordmini-history-api-'));
    roots.push(root);
    process.env.CHORDMINI_DESKTOP_MODE = '1';
    process.env.CHORDMINI_DESKTOP_COOKIE = COOKIE;
    process.env.CHORDMINI_ANALYSIS_HISTORY_DIR = root;
    delete process.env.CHORDMINI_ANALYSIS_HISTORY_MAX_BODY_BYTES;
  });

  afterEach(() => {
    process.env.CHORDMINI_DESKTOP_MODE = previous.mode;
    process.env.CHORDMINI_DESKTOP_COOKIE = previous.cookie;
    process.env.CHORDMINI_ANALYSIS_HISTORY_DIR = previous.dir;
    process.env.CHORDMINI_ANALYSIS_HISTORY_MAX_BODY_BYTES = previous.limit;
  });

  afterAll(() => {
    for (const directory of roots) fs.rmSync(directory, { recursive: true, force: true });
  });

  it('lists, reads, writes, opens, and deletes for an authorized desktop caller', async () => {
    const empty = await listRecords(request('GET', '/api/desktop/analysis-history'));
    expect(empty.status).toBe(200);
    expect(await bodyOf(empty)).toMatchObject({ ok: true, records: [], nextCursor: null });

    const created = await createRecord(request('POST', '/api/desktop/analysis-history', draft()));
    expect(created.status).toBe(201);
    const createdBody = await bodyOf(created);
    const id = createdBody.id as string;
    expect(createdBody.created).toBe(true);
    expect(JSON.stringify(createdBody)).not.toContain(root);
    expect(JSON.stringify(createdBody)).not.toContain(COOKIE);

    const loaded = await readRecord(request('GET', `/api/desktop/analysis-history/${id}`), { params: { id } });
    expect(loaded.status).toBe(200);
    const loadedBody = await bodyOf(loaded);
    expect((loadedBody.record as { id: string }).id).toBe(id);
    expect((loadedBody.record as { chords: unknown[] }).chords).toHaveLength(1);

    const opened = await openRecord(
      request('POST', `/api/desktop/analysis-history/${id}/opened`, { openedAt: '2026-10-26T16:00:00.000Z' }),
      { params: { id } },
    );
    expect(opened.status).toBe(200);
    const openedBody = await bodyOf(opened);
    expect(openedBody.lastOpenedAt).toBe('2026-10-26T16:00:00.000Z');
    expect(openedBody.resultSha256).toBe((loadedBody.record as { resultSha256: string }).resultSha256);

    const listed = await listRecords(request('GET', '/api/desktop/analysis-history?limit=1'));
    const listedBody = await bodyOf(listed);
    const records = listedBody.records as Array<Record<string, unknown>>;
    expect(records).toHaveLength(1);
    expect(records[0].chords).toBeUndefined();
    expect(records[0].beats).toBeUndefined();

    const removed = await DELETE(request('DELETE', `/api/desktop/analysis-history/${id}`, {
      recordId: id,
      confirmDelete: true,
    }), { params: { id } });
    expect(removed.status).toBe(200);
    expect((await readRecord(request('GET', `/api/desktop/analysis-history/${id}`), { params: { id } })).status).toBe(404);
  });

  it('returns 404 outside desktop mode and does not create storage', async () => {
    delete process.env.CHORDMINI_DESKTOP_MODE;
    const missing = path.join(root, 'not-created');
    process.env.CHORDMINI_ANALYSIS_HISTORY_DIR = missing;
    const response = await createRecord(request('POST', '/api/desktop/analysis-history', draft()));
    expect(response.status).toBe(404);
    expect(await bodyOf(response)).toEqual({ ok: false });
    expect(fs.existsSync(missing)).toBe(false);
  });

  it('rejects a missing or invalid desktop cookie', async () => {
    const missing = await createRecord(request('POST', '/api/desktop/analysis-history', draft(), { cookie: '' }));
    expect(missing.status).toBe(403);
    expect(await bodyOf(missing)).toEqual({ ok: false, code: 'FORBIDDEN' });

    const invalid = await listRecords(request('GET', '/api/desktop/analysis-history', undefined, {
      cookie: `${DESKTOP_COOKIE_NAME}=other-cookie`,
    }));
    expect(invalid.status).toBe(403);
    expect(fs.readdirSync(root).filter((name) => UUID_FILE.test(name))).toHaveLength(0);
  });

  it('rejects cross-origin writes and deletes', async () => {
    const created = await createRecord(request('POST', '/api/desktop/analysis-history', draft()));
    const id = (await bodyOf(created)).id as string;
    const cross = {
      origin: 'http://127.0.0.1:9999',
      'sec-fetch-site': 'cross-site',
    };
    const write = await createRecord(request('POST', '/api/desktop/analysis-history', draft({
      source: { kind: 'local-audio', displayName: 'other.mp3', sizeBytes: 10, contentSha256: HASH_B },
    }), cross));
    expect(write.status).toBe(403);
    const remove = await DELETE(request('DELETE', `/api/desktop/analysis-history/${id}`, {
      recordId: id,
      confirmDelete: true,
    }, cross), { params: { id } });
    expect(remove.status).toBe(403);
    expect((await readRecord(request('GET', `/api/desktop/analysis-history/${id}`), { params: { id } })).status).toBe(200);
  });

  it('rejects an oversized body before saving it', async () => {
    process.env.CHORDMINI_ANALYSIS_HISTORY_MAX_BODY_BYTES = '128';
    const response = await createRecord(request('POST', '/api/desktop/analysis-history', {
      ...draft(),
      padding: 'x'.repeat(200),
    }));
    expect(response.status).toBe(413);
    expect(await bodyOf(response)).toEqual({ ok: false, code: 'PAYLOAD_TOO_LARGE' });
    expect(fs.readdirSync(root).filter((name) => UUID_FILE.test(name))).toHaveLength(0);
  });

  it('rejects unknown fields and audio payloads', async () => {
    const response = await createRecord(request('POST', '/api/desktop/analysis-history', {
      ...draft(),
      apiKey: 'cred-do-not-store-9f3a',
      audioBytes: 'data:audio/mpeg;base64,AAAA',
    }));
    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toMatchObject({ ok: false, code: 'RECORD_INVALID' });
    const text = fs.readdirSync(root).filter((name) => name.endsWith('.json'))
      .map((name) => fs.readFileSync(path.join(root, name), 'utf8'))
      .join('\n');
    expect(text).not.toContain('cred-do-not-store-9f3a');
    expect(text).not.toContain('data:audio');
  });

  it('rejects an invalid id and a traversal id', async () => {
    expect((await readRecord(request('GET', '/api/desktop/analysis-history/not-a-uuid'), {
      params: { id: 'not-a-uuid' },
    })).status).toBe(400);
    const traversal = await DELETE(request('DELETE', '/api/desktop/analysis-history/..%2Foutside', {
      recordId: '../outside',
      confirmDelete: true,
    }), { params: { id: '../outside' } });
    expect(traversal.status).toBe(400);
    const traversalBody = await bodyOf(traversal);
    expect(traversalBody).toMatchObject({ ok: false });
    expect(JSON.stringify(traversalBody)).not.toContain(root);
  });

  it('rejects a symlinked storage directory without writing through it', async () => {
    const real = path.join(root, 'real');
    const link = path.join(root, 'link');
    fs.mkdirSync(real);
    fs.symlinkSync(real, link);
    process.env.CHORDMINI_ANALYSIS_HISTORY_DIR = link;
    const response = await createRecord(request('POST', '/api/desktop/analysis-history', draft()));
    expect(response.status).toBe(503);
    const body = await bodyOf(response);
    expect(body).toEqual({ ok: false, code: 'STORAGE_ROOT_UNSAFE' });
    expect(fs.readdirSync(real)).toEqual([]);
    expect(JSON.stringify(body)).not.toContain(real);
  });

  it('keeps concurrent creates consistent and returns the existing id for a duplicate', async () => {
    const [first, second] = await Promise.all([
      createRecord(request('POST', '/api/desktop/analysis-history', draft())),
      createRecord(request('POST', '/api/desktop/analysis-history', draft({
        source: { kind: 'local-audio', displayName: 'other.mp3', sizeBytes: 20, contentSha256: HASH_B },
      }))),
    ]);
    const firstBody = await bodyOf(first);
    const secondBody = await bodyOf(second);
    expect(firstBody.id).not.toBe(secondBody.id);

    const duplicate = await createRecord(request('POST', '/api/desktop/analysis-history', draft()));
    const duplicateBody = await bodyOf(duplicate);
    expect(duplicate.status).toBe(200);
    expect(duplicateBody.created).toBe(false);
    expect(duplicateBody.id).toBe(firstBody.id);
    expect(fs.readdirSync(root).filter((name) => UUID_FILE.test(name))).toHaveLength(2);
  });

  it('rebuilds a corrupted index without dropping records', async () => {
    const created = await createRecord(request('POST', '/api/desktop/analysis-history', draft()));
    const id = (await bodyOf(created)).id as string;
    fs.writeFileSync(path.join(root, 'index.json'), '{');
    const listed = await listRecords(request('GET', '/api/desktop/analysis-history'));
    const listedBody = await bodyOf(listed);
    expect((listedBody.records as Array<{ id: string }>).map((record) => record.id)).toEqual([id]);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8')).records[0].id).toBe(id);
  });

  it('returns a controlled storage error and keeps the saved record when the directory is not writable', async () => {
    const created = await createRecord(request('POST', '/api/desktop/analysis-history', draft()));
    const id = (await bodyOf(created)).id as string;
    const before = fs.readFileSync(path.join(root, `${id}.json`));
    fs.chmodSync(root, 0o555);
    try {
      const response = await createRecord(request('POST', '/api/desktop/analysis-history', draft({
        source: { kind: 'local-audio', displayName: 'other.mp3', sizeBytes: 20, contentSha256: HASH_B },
      })));
      expect(response.status).toBe(503);
      const body = await bodyOf(response);
      expect(body).toEqual({ ok: false, code: 'STORAGE_UNAVAILABLE' });
      expect(JSON.stringify(body)).not.toContain(root);
    } finally {
      fs.chmodSync(root, 0o755);
    }
    expect(fs.readFileSync(path.join(root, `${id}.json`)).equals(before)).toBe(true);
  });

  it('creates a missing history directory under the approved path', async () => {
    const userData = path.join(root, 'user-data');
    const history = path.join(userData, 'analysis-history');
    fs.mkdirSync(userData);
    process.env.CHORDMINI_ANALYSIS_HISTORY_DIR = history;
    expect(fs.existsSync(history)).toBe(false);
    const response = await createRecord(request('POST', '/api/desktop/analysis-history', draft()));
    expect(response.status).toBe(201);
    expect(fs.statSync(history).isDirectory()).toBe(true);
    expect(fs.readdirSync(history).some((name) => UUID_FILE.test(name))).toBe(true);
  });
});
