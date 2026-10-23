/**
 * @jest-environment node
 *
 * CONTRACT: desktop forwarding to a trusted gateway.
 * Firebase verification is not performed in this file. The gateway responses
 * are mocked. This is not a production authentication test and not real inference.
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

import { POST as postBeats } from '@/app/api/detect-beats/route';
import { POST as postChords } from '@/app/api/recognize-chords/route';
import { desktopHostedGatewayResponse } from '@/server/hostedGatewayForward';

const FLASK_SECRET = 'desktop-gateway-secret-0123456789abcdef0123';
const ATTACKER_FLASK_TOKEN = 'attacker-flask-token-0123456789abcdef0123';
const USER_TOKEN = 'eyJhbGciOiJub25lIn0.eyJ1aWQiOiJhbGxvd2VkIn0.signature';
const GATEWAY = 'https://gateway.example.test';
const fetchMock = jest.fn();

const makeRequest = (
  headers?: Record<string, string>,
  extra?: (form: FormData) => void,
  signal?: AbortSignal,
) => {
  const formData = new FormData();
  formData.append('file', new File([new Uint8Array([9, 8, 7, 6])], 'clip.wav', { type: 'audio/wav' }));
  formData.append('detector', 'madmom');
  extra?.(formData);
  return {
    formData: async () => formData,
    headers: new Headers(headers),
    signal,
  } as never;
};

const jsonResponse = (body: unknown, status = 200, extra?: { location?: string; type?: string }) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? 'OK' : 'Error',
  type: extra?.type ?? 'basic',
  headers: new Headers(extra?.location ? { location: extra.location } : {}),
  json: async () => body,
  text: async () => JSON.stringify(body),
});

describe('CONTRACT desktop hosted gateway bridge', () => {
  const original = {
    auth: process.env.CHORDMINI_INFERENCE_AUTH,
    secret: process.env.CHORDMINI_INFERENCE_SECRET,
    desktop: process.env.CHORDMINI_DESKTOP_MODE,
    python: process.env.PYTHON_API_URL,
    gateway: process.env.CHORDMINI_HOSTED_GATEWAY_URL,
    loopback: process.env.CHORDMINI_HOSTED_GATEWAY_TEST_LOOPBACK,
    nodeEnv: process.env.NODE_ENV,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CHORDMINI_DESKTOP_MODE = '1';
    process.env.CHORDMINI_HOSTED_GATEWAY_URL = GATEWAY;
    delete process.env.CHORDMINI_HOSTED_GATEWAY_TEST_LOOPBACK;
    delete process.env.CHORDMINI_HOSTED_STAGING_AUTH;
    delete process.env.CHORDMINI_STAGING_ALLOWED_UIDS;
    delete process.env.CHORDMINI_INFERENCE_AUTH;
    process.env.CHORDMINI_INFERENCE_SECRET = FLASK_SECRET;
    process.env.PYTHON_API_URL = 'http://127.0.0.1:5001';
    global.fetch = fetchMock as never;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (original.auth === undefined) delete process.env.CHORDMINI_INFERENCE_AUTH;
    else process.env.CHORDMINI_INFERENCE_AUTH = original.auth;
    if (original.secret === undefined) delete process.env.CHORDMINI_INFERENCE_SECRET;
    else process.env.CHORDMINI_INFERENCE_SECRET = original.secret;
    if (original.desktop === undefined) delete process.env.CHORDMINI_DESKTOP_MODE;
    else process.env.CHORDMINI_DESKTOP_MODE = original.desktop;
    if (original.python === undefined) delete process.env.PYTHON_API_URL;
    else process.env.PYTHON_API_URL = original.python;
    if (original.gateway === undefined) delete process.env.CHORDMINI_HOSTED_GATEWAY_URL;
    else process.env.CHORDMINI_HOSTED_GATEWAY_URL = original.gateway;
    if (original.loopback === undefined) delete process.env.CHORDMINI_HOSTED_GATEWAY_TEST_LOOPBACK;
    else process.env.CHORDMINI_HOSTED_GATEWAY_TEST_LOOPBACK = original.loopback;
    if (original.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original.nodeEnv;
  });

  it('keeps remote forwarding off and preserves the missing desktop service', async () => {
    delete process.env.CHORDMINI_HOSTED_GATEWAY_URL;
    delete process.env.PYTHON_API_URL;
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const response = await postBeats(makeRequest());
    const body = await response.json();
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));

    expect(response.status).toBe(503);
    expect(body.code).toBe('ANALYSIS_SERVICE_NOT_CONFIGURED');
    expect(urls.some((url) => url.includes('/api/detect-beats'))).toBe(false);
    expect(JSON.stringify(body)).not.toContain(FLASK_SECRET);
  });

  it('preserves an explicit dead loopback when no hosted URL is configured', async () => {
    delete process.env.CHORDMINI_HOSTED_GATEWAY_URL;
    process.env.PYTHON_API_URL = 'http://127.0.0.1:9';
    fetchMock.mockRejectedValue(new TypeError('fetch failed http://127.0.0.1:9'));

    const response = await postChords(makeRequest());
    const text = JSON.stringify(await response.json());

    expect(response.status).toBe(503);
    expect(text).toContain('ANALYSIS_SERVICE_UNAVAILABLE');
    expect(text).not.toContain('127.0.0.1:9');
    expect(text).not.toContain(FLASK_SECRET);
  });

  it('rejects an unsafe gateway URL without calling Flask or the network', async () => {
    process.env.CHORDMINI_HOSTED_GATEWAY_URL = 'http://evil.example/api/detect-beats';

    const response = await postBeats(makeRequest({ authorization: `Bearer ${USER_TOKEN}` }));
    const text = JSON.stringify(await response.json());

    expect(response.status).toBe(503);
    expect(text).toContain('HOSTED_GATEWAY_NOT_CONFIGURED');
    expect(text).not.toContain('evil.example');
    expect(text).not.toContain(FLASK_SECRET);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards only the bearer token and approved fields to the trusted gateway', async () => {
    const payload = { success: true, beats: [0, 0.5], bpm: 120, model_used: 'madmom' };
    fetchMock.mockResolvedValue(jsonResponse(payload));

    const response = await postBeats(makeRequest(
      {
        authorization: `Bearer ${USER_TOKEN}`,
        cookie: 'session=secret-cookie',
        'x-chordmini-inference-token': ATTACKER_FLASK_TOKEN,
      },
      (form) => {
        form.append('token', ATTACKER_FLASK_TOKEN);
        form.append('uid', 'forged-uid');
        form.append('firebase_url', 'https://attacker.example/audio');
        form.append('force', 'true');
      },
    ));
    const [url, init] = fetchMock.mock.calls[0];
    const body = init.body as FormData;
    const logged = [
      ...(console.log as jest.Mock).mock.calls,
      ...(console.error as jest.Mock).mock.calls,
    ].flat().join('\n');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(payload);
    expect(url).toBe(`${GATEWAY}/api/detect-beats`);
    expect(init.redirect).toBe('manual');
    expect(init.credentials).toBe('omit');
    expect(init.headers).toEqual({ Authorization: `Bearer ${USER_TOKEN}` });
    expect(JSON.stringify(init.headers)).not.toContain(FLASK_SECRET);
    expect(JSON.stringify(init.headers)).not.toContain(ATTACKER_FLASK_TOKEN);
    expect(body.get('detector')).toBe('madmom');
    expect(body.get('force')).toBe('true');
    expect((body.get('file') as File).size).toBe(4);
    expect(body.get('uid')).toBeNull();
    expect(body.get('token')).toBeNull();
    expect(body.get('firebase_url')).toBeNull();
    expect(logged).not.toContain(FLASK_SECRET);
    expect(logged).not.toContain(USER_TOKEN);
    expect(logged).not.toContain(GATEWAY);
  });

  it('fails closed when the user token is missing or malformed and does not call inference', async () => {
    const missing = await postBeats(makeRequest());
    expect(missing.status).toBe(401);
    await expect(missing.json()).resolves.toMatchObject({ code: 'USER_AUTH_REQUIRED' });

    const malformed = await postChords(makeRequest({ authorization: 'Bearer not-a-jwt' }));
    expect(malformed.status).toBe(401);
    await expect(malformed.json()).resolves.toMatchObject({ code: 'USER_AUTH_MALFORMED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes a gateway auth rejection through without the gateway address', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      success: false,
      error: 'User authentication has expired',
      code: 'USER_TOKEN_EXPIRED',
      detail: GATEWAY,
    }, 401));

    const expired = await postBeats(makeRequest({ authorization: `Bearer ${USER_TOKEN}` }));
    const expiredBody = await expired.json();
    expect(expired.status).toBe(401);
    expect(expiredBody.code).toBe('USER_TOKEN_EXPIRED');
    expect(JSON.stringify(expiredBody)).not.toContain(GATEWAY);
    expect(JSON.stringify(expiredBody)).not.toContain(USER_TOKEN);

    fetchMock.mockResolvedValue(jsonResponse({
      success: false,
      error: 'User is not allowed to use staging analysis',
      code: 'USER_NOT_ALLOWLISTED',
    }, 403));
    const denied = await postChords(makeRequest(
      { authorization: `Bearer ${USER_TOKEN}` },
      (form) => form.append('uid', 'allowlisted-staging-uid'),
    ));
    const deniedBody = await denied.json();
    expect(denied.status).toBe(403);
    expect(deniedBody.code).toBe('USER_NOT_ALLOWLISTED');
    expect((fetchMock.mock.calls[1][1].body as FormData).get('uid')).toBeNull();
  });

  it('does not follow a redirect or send the bearer token to another host', async () => {
    fetchMock.mockResolvedValue(jsonResponse(
      { ok: true },
      302,
      { location: 'https://evil.example/steal', type: 'basic' },
    ));

    const response = await postBeats(makeRequest({ authorization: `Bearer ${USER_TOKEN}` }));
    const text = JSON.stringify(await response.json());

    expect(response.status).toBe(502);
    expect(text).toContain('HOSTED_GATEWAY_REDIRECT_REJECTED');
    expect(text).not.toContain('evil.example');
    expect(text).not.toContain(USER_TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('hides network failures and reports timeouts without the destination', async () => {
    fetchMock.mockRejectedValue(new TypeError('connect ECONNREFUSED 10.9.8.7'));
    const down = await postBeats(makeRequest({ authorization: `Bearer ${USER_TOKEN}` }));
    const downText = JSON.stringify(await down.json());
    expect(down.status).toBe(503);
    expect(downText).toContain('ANALYSIS_SERVICE_UNAVAILABLE');
    expect(downText).not.toContain('10.9.8.7');
    expect(downText).not.toContain(GATEWAY);

    fetchMock.mockImplementation((_url: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    }));
    const timed = await desktopHostedGatewayResponse(
      makeRequest({ authorization: `Bearer ${USER_TOKEN}` }),
      'chords',
      process.env,
      fetchMock as never,
      30,
    );
    const timedText = JSON.stringify(await timed?.json());
    expect(timed?.status).toBe(504);
    expect(timedText).toContain('HOSTED_GATEWAY_TIMEOUT');
    expect(timedText).not.toContain(GATEWAY);
    expect(timedText).not.toContain(USER_TOKEN);
  });

  it('cancels the upstream request when the caller aborts', async () => {
    const controller = new AbortController();
    let upstream: AbortSignal | undefined;
    fetchMock.mockImplementation((_url: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      upstream = init.signal;
      init.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
      controller.abort();
    }));

    const response = await postBeats(makeRequest(
      { authorization: `Bearer ${USER_TOKEN}` },
      undefined,
      controller.signal,
    ));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.code).toBe('ANALYSIS_REQUEST_CANCELLED');
    expect(upstream?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(body)).not.toContain(GATEWAY);
  });

  it('preserves beat and chord response contracts from the gateway', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      success: false,
      error: 'Inference failed',
      model_used: 'chord-cnn-lstm',
    }));
    const chords = await postChords(makeRequest({ authorization: `Bearer ${USER_TOKEN}` }));
    expect(chords.status).toBe(200);
    await expect(chords.json()).resolves.toMatchObject({
      success: false,
      model_used: 'chord-cnn-lstm',
    });

    fetchMock.mockResolvedValueOnce(jsonResponse({
      error: 'Beat detection failed',
    }, 500));
    const beats = await postBeats(makeRequest({ authorization: `Bearer ${USER_TOKEN}` }));
    const beatBody = await beats.json();
    expect(beats.status).toBe(500);
    expect(beatBody.error).toBe('Beat detection failed');
    expect(beatBody.success).toBeUndefined();
  });

  it('allows loopback HTTP only in the test exception and never as the Flask origin', async () => {
    process.env.CHORDMINI_HOSTED_GATEWAY_URL = 'http://127.0.0.1:4010';
    const blocked = await postBeats(makeRequest({ authorization: `Bearer ${USER_TOKEN}` }));
    expect((await blocked.json()).code).toBe('HOSTED_GATEWAY_NOT_CONFIGURED');
    expect(fetchMock).not.toHaveBeenCalled();

    process.env.CHORDMINI_HOSTED_GATEWAY_TEST_LOOPBACK = '1';
    process.env.NODE_ENV = 'production';
    const production = await desktopHostedGatewayResponse(
      makeRequest({ authorization: `Bearer ${USER_TOKEN}` }),
      'beats',
      process.env,
      fetchMock as never,
    );
    expect((await production?.json()).code).toBe('HOSTED_GATEWAY_NOT_CONFIGURED');
    expect(fetchMock).not.toHaveBeenCalled();

    process.env.NODE_ENV = 'test';
    process.env.PYTHON_API_URL = 'http://127.0.0.1:4010';
    const confused = await postBeats(makeRequest({ authorization: `Bearer ${USER_TOKEN}` }));
    expect((await confused.json()).code).toBe('HOSTED_GATEWAY_NOT_CONFIGURED');
    expect(fetchMock).not.toHaveBeenCalled();

    process.env.PYTHON_API_URL = 'http://127.0.0.1:5001';
    fetchMock.mockResolvedValue(jsonResponse({ success: true, beats: [1], model_used: 'madmom' }));
    const allowed = await postBeats(makeRequest({ authorization: `Bearer ${USER_TOKEN}` }));
    expect(allowed.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:4010/api/detect-beats');
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ Authorization: `Bearer ${USER_TOKEN}` });
  });
});
