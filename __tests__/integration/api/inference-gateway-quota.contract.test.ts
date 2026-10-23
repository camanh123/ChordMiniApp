/**
 * @jest-environment node
 *
 * MOCKED Firebase Admin SDK. These tests do not contact Firebase Auth and
 * are not a production authentication result. Real Madmom and Chord-CNN-LSTM
 * output stays in inference-upstream.real.test.ts.
 */

jest.mock('next/server', () => ({
  NextRequest: class {},
  NextResponse: class MockNextResponse {
    status: number;
    headers: Headers;
    private body: unknown;

    constructor(body?: unknown, init?: { status?: number; headers?: HeadersInit }) {
      this.status = init?.status ?? 200;
      this.headers = new Headers(init?.headers ?? {});
      this.body = body;
    }

    static json(body: unknown, init?: { status?: number; headers?: HeadersInit }) {
      return new this(body, init);
    }

    async json() {
      return this.body;
    }
  },
}));

jest.mock('@/utils/audioDurationUtils', () => ({
  getAudioDurationFromFile: jest.fn(async () => 12),
}));

jest.mock('@/utils/environmentUtils', () => ({
  createSafeTimeoutSignal: jest.fn(() => new AbortController().signal),
}));

jest.mock('@/utils/backendConfig', () => ({
  isLocalBackend: jest.fn(() => true),
}));

const mockVerifyIdToken = jest.fn();

jest.mock('@/utils/firebaseAdmin', () => ({
  getFirebaseAdminAuth: jest.fn(async () => ({
    verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args),
  })),
}));

import fs from 'fs';
import { NextResponse } from 'next/server';
import { POST as postBeats } from '@/app/api/detect-beats/route';
import { POST as postChords } from '@/app/api/recognize-chords/route';
import { inspectHostedAudio } from '@/server/gatewayAudioGuard';
import {
  DEFAULT_GLOBAL_ACTIVE,
  DEFAULT_MAX_AUDIO_SECONDS,
  DEFAULT_MAX_UPLOAD_BYTES,
  DEFAULT_UID_ACTIVE,
  DEFAULT_UID_PER_DAY,
  DEFAULT_UID_PER_MINUTE,
  gatewayAdmissionSnapshot,
  measureAdmissionOverhead,
  readGatewayAdmissionConfig,
  resetGatewayAdmissionForTests,
  setGatewayClockForTests,
  withHostedAdmission,
  type AdmissionContext,
} from '@/server/gatewayAdmission';

const FLASK_SECRET = 'quota-route-secret-0123456789abcdef0123456789';
const TOKEN_A = 'aaa.header.signature';
const TOKEN_B = 'bbb.header.signature';
const TOKEN_C = 'ccc.header.signature';
const REQUEST_ID = 'replay-1';

const fetchMock = jest.fn();

function wavBytes(options: {
  seconds: number;
  sampleRate?: number;
  factSamples?: number;
  extraBytes?: number;
} = { seconds: 1 }): Uint8Array {
  const sampleRate = options.sampleRate ?? 8000;
  const frames = Math.round(options.seconds * sampleRate);
  const data = new Uint8Array(frames);
  const fact = options.factSamples != null;
  const payload = 4 + 24 + (fact ? 12 : 0) + 8 + data.length;
  const bytes = new Uint8Array(8 + payload + (options.extraBytes ?? 0));
  const view = new DataView(bytes.buffer);
  const setText = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      bytes[offset + index] = text.charCodeAt(index);
    }
  };
  setText(0, 'RIFF');
  view.setUint32(4, payload, true);
  setText(8, 'WAVE');
  setText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  let offset = 36;
  if (fact) {
    setText(offset, 'fact');
    view.setUint32(offset + 4, 4, true);
    view.setUint32(offset + 8, options.factSamples as number, true);
    offset += 12;
  }
  setText(offset, 'data');
  view.setUint32(offset + 4, data.length, true);
  bytes.set(data, offset + 8);
  return bytes;
}

const SHORT_WAV = new File([wavBytes()], 'clip.wav', { type: 'audio/wav' });

function makeRequest(
  headers?: Record<string, string>,
  file: File = SHORT_WAV,
  extra?: (form: FormData) => void,
  signal?: AbortSignal,
) {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('detector', 'madmom');
  formData.append('uid', 'forged-uid');
  formData.append('duration', '1');
  formData.append('request_id', REQUEST_ID);
  extra?.(formData);
  return {
    formData: async () => formData,
    headers: new Headers(headers),
    signal,
    url: 'http://127.0.0.1:3000/api/detect-beats?uid=forged-query-uid&duration=1',
  } as never;
}

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? 'OK' : 'Error',
  headers: new Headers(),
  json: async () => body,
  text: async () => JSON.stringify(body),
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 3000) {
      throw new Error('timed out waiting for concurrent admission');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function hangUntilRelease() {
  let calls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  fetchMock.mockImplementation(() => {
    calls += 1;
    return gate.then(() => jsonResponse({ success: true, beats: [1], bpm: 120, model_used: 'madmom' }));
  });
  return { calls: () => calls, release };
}

describe('MOCKED Firebase gateway admission on inference routes', () => {
  const original = {
    auth: process.env.CHORDMINI_INFERENCE_AUTH,
    secret: process.env.CHORDMINI_INFERENCE_SECRET,
    staging: process.env.CHORDMINI_HOSTED_STAGING_AUTH,
    allow: process.env.CHORDMINI_STAGING_ALLOWED_UIDS,
    admin: process.env.FIREBASE_SERVICE_ACCOUNT_KEY,
    desktop: process.env.CHORDMINI_DESKTOP_MODE,
    python: process.env.PYTHON_API_URL,
    admission: process.env.CHORDMINI_GATEWAY_ADMISSION,
    instances: process.env.CHORDMINI_GATEWAY_INSTANCES,
    redis: process.env.REDIS_URL,
    web: process.env.WEB_CONCURRENCY,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CHORDMINI_HOSTED_STAGING_AUTH = 'required';
    process.env.CHORDMINI_STAGING_ALLOWED_UIDS = 'uid-a,uid-b,uid-c';
    process.env.CHORDMINI_INFERENCE_AUTH = 'required';
    process.env.CHORDMINI_INFERENCE_SECRET = FLASK_SECRET;
    process.env.FIREBASE_SERVICE_ACCOUNT_KEY = JSON.stringify({
      project_id: 'staging-test',
      private_key: 'test-only-not-a-credential',
      client_email: 'staging-test@example.invalid',
    });
    process.env.PYTHON_API_URL = 'http://127.0.0.1:5001';
    process.env.CHORDMINI_GATEWAY_ADMISSION = 'process';
    process.env.CHORDMINI_GATEWAY_INSTANCES = '1';
    delete process.env.CHORDMINI_DESKTOP_MODE;
    delete process.env.CHORDMINI_GATEWAY_UID_PER_MINUTE;
    delete process.env.CHORDMINI_GATEWAY_UID_PER_DAY;
    delete process.env.CHORDMINI_GATEWAY_UID_ACTIVE;
    delete process.env.CHORDMINI_GATEWAY_GLOBAL_ACTIVE;
    delete process.env.CHORDMINI_GATEWAY_MAX_UPLOAD_BYTES;
    delete process.env.CHORDMINI_GATEWAY_MAX_AUDIO_SECONDS;
    delete process.env.CHORDMINI_GATEWAY_INFERENCE_BOUND_MS;
    delete process.env.REDIS_URL;
    delete process.env.WEB_CONCURRENCY;
    delete process.env.CHORDMINI_HOSTED_GATEWAY_URL;
    resetGatewayAdmissionForTests();
    mockVerifyIdToken.mockImplementation(async (token: unknown) => {
      const value = String(token);
      if (value === TOKEN_B) return { uid: 'uid-b' };
      if (value === TOKEN_C) return { uid: 'uid-c' };
      return { uid: 'uid-a' };
    });
    fetchMock.mockResolvedValue(jsonResponse({ success: true, beats: [0.5], bpm: 120, model_used: 'madmom' }));
    global.fetch = fetchMock as never;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    resetGatewayAdmissionForTests();
    jest.restoreAllMocks();
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('CHORDMINI_INFERENCE_AUTH', original.auth);
    restore('CHORDMINI_INFERENCE_SECRET', original.secret);
    restore('CHORDMINI_HOSTED_STAGING_AUTH', original.staging);
    restore('CHORDMINI_STAGING_ALLOWED_UIDS', original.allow);
    restore('FIREBASE_SERVICE_ACCOUNT_KEY', original.admin);
    restore('CHORDMINI_DESKTOP_MODE', original.desktop);
    restore('PYTHON_API_URL', original.python);
    restore('CHORDMINI_GATEWAY_ADMISSION', original.admission);
    restore('CHORDMINI_GATEWAY_INSTANCES', original.instances);
    restore('REDIS_URL', original.redis);
    restore('WEB_CONCURRENCY', original.web);
  });

  async function submit(
    route: 'beats' | 'chords',
    token = TOKEN_A,
    file: File = SHORT_WAV,
    signal?: AbortSignal,
    headers?: Record<string, string>,
  ) {
    const request = makeRequest({
      authorization: `Bearer ${token}`,
      cookie: 'uid=uid-b; session=secret-cookie',
      ...headers,
    }, file, undefined, signal);
    return route === 'beats' ? postBeats(request) : postChords(request);
  }

  it('A rejects missing Firebase identity before admission', async () => {
    const response = await postBeats(makeRequest());
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: 'USER_AUTH_REQUIRED' });
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(gatewayAdmissionSnapshot('uid-a')).toEqual({ globalActive: 0, uidActive: 0 });
  });

  it('B rejects a non-allowlisted uid before admission', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({ uid: 'intruder' });
    const response = await submit('beats');
    const body = await response.json();
    expect(response.status).toBe(403);
    expect(body.code).toBe('USER_NOT_ALLOWLISTED');
    expect(JSON.stringify(body)).not.toContain('intruder');
    expect(JSON.stringify(body)).not.toContain(FLASK_SECRET);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(gatewayAdmissionSnapshot().globalActive).toBe(0);
  });

  it('C and G enforce one shared minute quota across beat and chord routes', async () => {
    let now = 5_000_000;
    setGatewayClockForTests(() => now);
    expect((await submit('beats')).status).toBe(200);
    now += 10_000;
    expect((await submit('chords')).status).toBe(200);
    const denied = await submit('beats');
    const body = await denied.json();
    expect(denied.status).toBe(429);
    expect(body.code).toBe('UID_MINUTE_QUOTA');
    expect(denied.headers.get('retry-after')).toBe('50');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(body)).not.toContain(FLASK_SECRET);
    expect(JSON.stringify(body)).not.toContain('uid-a');

    now += 49_000;
    const still = await submit('chords');
    expect(still.status).toBe(429);
    expect(still.headers.get('retry-after')).toBe('1');
    now += 1_000;
    expect((await submit('chords')).status).toBe(200);
  });

  it('D enforces the shared daily quota and does not reset it per route', async () => {
    let now = 1_700_000_000_000;
    setGatewayClockForTests(() => now);
    for (let index = 0; index < DEFAULT_UID_PER_DAY; index += 1) {
      if (index > 0 && index % DEFAULT_UID_PER_MINUTE === 0) {
        now += 60_000;
      }
      const response = await submit(index % 2 === 0 ? 'beats' : 'chords');
      expect(response.status).toBe(200);
    }
    now += 60_000;
    const denied = await submit('chords');
    const body = await denied.json();
    expect(denied.status).toBe(429);
    expect(body.code).toBe('UID_DAILY_QUOTA');
    const retry = Number(denied.headers.get('retry-after'));
    expect(retry).toBeGreaterThan(80_000);
    expect(retry).toBeLessThanOrEqual(86_400);
    const otherRoute = await submit('beats');
    await expect(otherRoute.json()).resolves.toMatchObject({ code: 'UID_DAILY_QUOTA' });
    expect(fetchMock).toHaveBeenCalledTimes(DEFAULT_UID_PER_DAY);
  });

  it('E stops two simultaneous analyses for one uid, including across routes', async () => {
    const hung = hangUntilRelease();
    const beats = submit('beats');
    const chords = submit('chords');
    const firstDenied = await Promise.race([
      beats.then((response) => ({ response, other: chords })),
      chords.then((response) => ({ response, other: beats })),
    ]);
    expect(firstDenied.response.status).toBe(429);
    await expect(firstDenied.response.json()).resolves.toMatchObject({ code: 'UID_INFERENCE_ACTIVE' });
    expect(firstDenied.response.headers.get('retry-after')).toBeNull();
    expect(hung.calls()).toBe(1);
    expect(gatewayAdmissionSnapshot('uid-a').uidActive).toBe(1);
    hung.release();
    const admitted = await firstDenied.other;
    expect(admitted.status).toBe(200);
    expect(gatewayAdmissionSnapshot('uid-a')).toEqual({ globalActive: 0, uidActive: 0 });
  });

  it('E admits at most one active job when the callbacks start together', async () => {
    let started = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = async (_signal: AbortSignal, admission: AdmissionContext) => {
      await admission.trackUpstream(async () => {
        started += 1;
        await gate;
      });
      return NextResponse.json({ success: true });
    };
    const env = {
      CHORDMINI_GATEWAY_ADMISSION: 'process',
      CHORDMINI_GATEWAY_INSTANCES: '1',
    };
    const first = withHostedAdmission('uid-a', env, undefined, run);
    const second = withHostedAdmission('uid-a', env, undefined, run);
    const denied = await Promise.race([first, second]);
    expect(denied.status).toBe(429);
    expect(started).toBe(1);
    expect(gatewayAdmissionSnapshot('uid-a').uidActive).toBe(1);
    release();
    const statuses = (await Promise.all([first, second])).map((response) => response.status).sort();
    expect(statuses).toEqual([200, 429]);
    expect(gatewayAdmissionSnapshot().globalActive).toBe(0);
  });

  it('F lets two uids fill the global limit and rejects a third', async () => {
    const hung = hangUntilRelease();
    const first = submit('beats', TOKEN_A);
    const second = submit('chords', TOKEN_B);
    await waitFor(() => hung.calls() === 2);
    const third = await submit('beats', TOKEN_C);
    expect(third.status).toBe(429);
    await expect(third.json()).resolves.toMatchObject({ code: 'GLOBAL_INFERENCE_ACTIVE' });
    expect(third.headers.get('retry-after')).toBeNull();
    expect(gatewayAdmissionSnapshot().globalActive).toBe(DEFAULT_GLOBAL_ACTIVE);
    expect(hung.calls()).toBe(2);
    hung.release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(gatewayAdmissionSnapshot().globalActive).toBe(0);
  });

  it('H rejects an oversized declaration and an oversized file before Flask', async () => {
    const declared = await postBeats(makeRequest({
      'content-length': String(DEFAULT_MAX_UPLOAD_BYTES + 16 * 1024 + 1),
      authorization: `Bearer ${TOKEN_A}`,
    }));
    expect(declared.status).toBe(413);
    await expect(declared.json()).resolves.toMatchObject({ code: 'UPLOAD_TOO_LARGE' });
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    process.env.CHORDMINI_GATEWAY_MAX_UPLOAD_BYTES = '1000';
    const tooBig = await submit('chords');
    expect(tooBig.status).toBe(413);
    await expect(tooBig.json()).resolves.toMatchObject({ code: 'UPLOAD_TOO_LARGE' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(gatewayAdmissionSnapshot('uid-a').uidActive).toBe(0);
  });

  it('I and J reject excessive duration, a lying fact chunk, trailing bytes, and malformed audio', async () => {
    const longFile = new File([wavBytes({ seconds: DEFAULT_MAX_AUDIO_SECONDS + 1 })], 'long.wav', { type: 'audio/wav' });
    const longResponse = await submit('beats', TOKEN_A, longFile);
    expect(longResponse.status).toBe(400);
    await expect(longResponse.json()).resolves.toMatchObject({ code: 'AUDIO_DURATION_EXCEEDED' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(gatewayAdmissionSnapshot('uid-a').uidActive).toBe(0);

    const exact = new File([wavBytes({ seconds: DEFAULT_MAX_AUDIO_SECONDS })], 'exact.wav', { type: 'audio/wav' });
    expect((await submit('chords', TOKEN_A, exact)).status).toBe(200);

    const fact = new File([wavBytes({ seconds: 1, factSamples: 1 })], 'fact.wav', { type: 'audio/wav' });
    const trailing = new File([wavBytes({ seconds: 1, extraBytes: 32 })], 'trail.wav', { type: 'audio/wav' });
    const garbage = new File([Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])], 'notes.wav', { type: 'audio/wav' });
    for (const file of [fact, trailing, garbage]) {
      resetGatewayAdmissionForTests();
      const response = await submit('beats', TOKEN_A, file);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ code: 'AUDIO_MALFORMED' });
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(gatewayAdmissionSnapshot().globalActive).toBe(0);

    const fixture = '/tmp/chordmini-bt02-fixture.wav';
    if (fs.existsSync(fixture)) {
      const real = new File([fs.readFileSync(fixture)], 'fixture.wav', { type: 'audio/wav' });
      const inspected = await inspectHostedAudio(real, process.env);
      expect(inspected.ok).toBe(true);
    }
  });

  it('K keeps an aborted in-flight analysis admitted until the original deadline', async () => {
    process.env.CHORDMINI_GATEWAY_INFERENCE_BOUND_MS = '400';
    const controller = new AbortController();
    let upstream: AbortSignal | undefined;
    fetchMock.mockImplementation((_url: string, init: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      upstream = init.signal;
      init.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    }));
    const pending = submit('beats', TOKEN_A, SHORT_WAV, controller.signal);
    await waitFor(() => upstream != null);
    controller.abort();
    const cancelled = await pending;
    expect(cancelled.status).toBe(503);
    await expect(cancelled.json()).resolves.toMatchObject({ code: 'INFERENCE_REQUEST_CANCELLED' });
    expect(upstream?.aborted).toBe(true);
    expect(gatewayAdmissionSnapshot('uid-a').uidActive).toBe(1);
    const blocked = await submit('chords');
    expect(blocked.status).toBe(429);
    await expect(blocked.json()).resolves.toMatchObject({ code: 'UID_INFERENCE_ACTIVE' });
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(gatewayAdmissionSnapshot('uid-a')).toEqual({ globalActive: 0, uidActive: 0 });
    fetchMock.mockResolvedValue(jsonResponse({ success: true, beats: [1], bpm: 120, model_used: 'madmom' }));
    expect((await submit('beats')).status).toBe(200);
  });

  it('K releases an abort that arrives before upstream work starts', async () => {
    const controller = new AbortController();
    controller.abort();
    const cancelled = await submit('beats', TOKEN_A, SHORT_WAV, controller.signal);
    expect(cancelled.status).toBe(503);
    await expect(cancelled.json()).resolves.toMatchObject({ code: 'INFERENCE_REQUEST_CANCELLED' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(gatewayAdmissionSnapshot().globalActive).toBe(0);
    expect((await submit('chords')).status).toBe(200);
  });

  it('L and M release admission after an upstream HTTP failure and after success', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'backend failed' }, 500));
    const failed = await submit('beats');
    expect(failed.status).toBe(500);
    expect(gatewayAdmissionSnapshot().globalActive).toBe(0);
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, beats: [1], bpm: 120, model_used: 'madmom' }));
    expect((await submit('chords')).status).toBe(200);
    expect(gatewayAdmissionSnapshot('uid-a')).toEqual({ globalActive: 0, uidActive: 0 });
  });

  it('L holds the slot when the upstream connection fails without a response', async () => {
    process.env.CHORDMINI_GATEWAY_INFERENCE_BOUND_MS = '400';
    fetchMock.mockRejectedValue(new TypeError('connect ECONNREFUSED 10.9.8.7'));
    const lost = await submit('beats');
    const body = await lost.json();
    expect(lost.status).toBe(502);
    expect(body.code).toBe('INFERENCE_UPSTREAM_UNCONFIRMED');
    expect(JSON.stringify(body)).not.toContain('10.9.8.7');
    expect(JSON.stringify(body)).not.toContain(FLASK_SECRET);
    expect(gatewayAdmissionSnapshot('uid-a').uidActive).toBe(1);
    const blocked = await submit('chords');
    expect(blocked.status).toBe(429);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(gatewayAdmissionSnapshot().globalActive).toBe(0);
  });

  it('N fails closed when quota configuration is missing or multi-instance', async () => {
    delete process.env.CHORDMINI_GATEWAY_ADMISSION;
    const missing = await submit('beats');
    expect(missing.status).toBe(503);
    await expect(missing.json()).resolves.toMatchObject({ code: 'QUOTA_NOT_CONFIGURED' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(gatewayAdmissionSnapshot().globalActive).toBe(0);

    process.env.CHORDMINI_GATEWAY_ADMISSION = 'process';
    process.env.CHORDMINI_GATEWAY_INSTANCES = '2';
    expect((await submit('chords')).status).toBe(503);
    process.env.CHORDMINI_GATEWAY_INSTANCES = '1';
    process.env.REDIS_URL = 'redis://127.0.0.1:6379';
    expect((await submit('beats')).status).toBe(503);
    delete process.env.REDIS_URL;
    process.env.WEB_CONCURRENCY = '2';
    expect((await submit('beats')).status).toBe(503);
    delete process.env.WEB_CONCURRENCY;
    process.env.CHORDMINI_GATEWAY_UID_PER_MINUTE = '0';
    expect((await submit('beats')).status).toBe(503);
    delete process.env.CHORDMINI_GATEWAY_UID_PER_MINUTE;
    process.env.CHORDMINI_GATEWAY_MAX_UPLOAD_BYTES = String(DEFAULT_MAX_UPLOAD_BYTES + 1);
    expect((await submit('chords')).status).toBe(503);
    delete process.env.CHORDMINI_GATEWAY_MAX_UPLOAD_BYTES;
    process.env.CHORDMINI_GATEWAY_MAX_AUDIO_SECONDS = String(DEFAULT_MAX_AUDIO_SECONDS + 1);
    const widened = await submit('beats');
    expect(widened.status).toBe(503);
    await expect(widened.json()).resolves.toMatchObject({ code: 'QUOTA_NOT_CONFIGURED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('O and P and Q do not honor caller uid, cookies, or query fields, and preserve success JSON', async () => {
    const payload = { success: true, beats: [0, 0.5], bpm: 120, model_used: 'madmom' };
    fetchMock.mockResolvedValue(jsonResponse(payload));
    const response = await submit('beats', TOKEN_A, SHORT_WAV, undefined, {
      'x-request-id': REQUEST_ID,
      'x-chordmini-inference-token': FLASK_SECRET,
    });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual(payload);
    expect(mockVerifyIdToken).toHaveBeenCalledWith(TOKEN_A, true);
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ 'X-ChordMini-Inference-Token': FLASK_SECRET });
    expect(JSON.stringify(body)).not.toContain(FLASK_SECRET);
    expect(response.headers.get('x-chordmini-inference-token')).toBeNull();

    const second = await submit('beats', TOKEN_A, SHORT_WAV, undefined, { 'x-request-id': REQUEST_ID });
    expect(second.status).toBe(200);
    const replay = await submit('chords', TOKEN_A, SHORT_WAV, undefined, { 'x-request-id': REQUEST_ID });
    expect(replay.status).toBe(429);
    await expect(replay.json()).resolves.toMatchObject({ code: 'UID_MINUTE_QUOTA' });

    resetGatewayAdmissionForTests();
    fetchMock.mockResolvedValue(jsonResponse(payload));
    expect((await submit('beats', TOKEN_A)).status).toBe(200);
    expect((await submit('chords', TOKEN_A)).status).toBe(200);
    const forged = await submit('beats', TOKEN_A);
    expect(forged.status).toBe(429);
    const otherUser = await submit('beats', TOKEN_B);
    expect(otherUser.status).toBe(200);
    const logged = [
      ...(console.log as jest.Mock).mock.calls,
      ...(console.error as jest.Mock).mock.calls,
    ].flat().join('\n');
    expect(logged).not.toContain(FLASK_SECRET);
    expect(logged).not.toContain(TOKEN_A);
  });

  it('uses the private staging defaults and records admission overhead', () => {
    const config = readGatewayAdmissionConfig({
      CHORDMINI_GATEWAY_ADMISSION: 'process',
      CHORDMINI_GATEWAY_INSTANCES: '1',
    });
    expect(config.ok).toBe(true);
    if (config.ok) {
      expect(config.limits.perMinute).toBe(DEFAULT_UID_PER_MINUTE);
      expect(config.limits.perDay).toBe(DEFAULT_UID_PER_DAY);
      expect(config.limits.uidActive).toBe(DEFAULT_UID_ACTIVE);
      expect(config.limits.globalActive).toBe(DEFAULT_GLOBAL_ACTIVE);
      expect(config.limits.maxUploadBytes).toBe(50 * 1024 * 1024);
      expect(config.limits.maxDurationSeconds).toBe(5 * 60);
    }
    expect(readGatewayAdmissionConfig({}).ok).toBe(false);
    const elapsed = measureAdmissionOverhead(1000);
    fs.writeFileSync('/tmp/chordmini-04e-admission-overhead.txt', `${elapsed}\n`);
    expect(elapsed).toBeLessThan(1000);
    resetGatewayAdmissionForTests();
  });
});
