/**
 * @jest-environment node
 *
 * MOCKED Firebase Admin SDK. These tests do not contact Firebase Auth and
 * are not a production authentication result.
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

import { POST as postBeats } from '@/app/api/detect-beats/route';
import { POST as postChords } from '@/app/api/recognize-chords/route';
import { resetGatewayAdmissionForTests } from '@/server/gatewayAdmission';

const FLASK_SECRET = 'staging-route-secret-0123456789abcdef01234567';
const ATTACKER_FLASK_TOKEN = 'attacker-flask-token-0123456789abcdef0123';
const USER_TOKEN = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1c2VyIn0.signature';
const ALLOWED_UID = 'allowlisted-staging-uid';
const FAKE_ADMIN = JSON.stringify({
  project_id: 'staging-test',
  private_key: 'test-only-not-a-credential',
  client_email: 'staging-test@example.invalid',
});
const fetchMock = jest.fn();

function stagingWav(): File {
  const sampleRate = 8000;
  const data = new Uint8Array(sampleRate);
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const write = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + data.length, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, data.length, true);
  return new File([header, data], 'clip.wav', { type: 'audio/wav' });
}

const makeRequest = (headers?: Record<string, string>, extra?: (form: FormData) => void) => {
  const formData = new FormData();
  formData.append('file', stagingWav());
  formData.append('detector', 'madmom');
  extra?.(formData);
  return {
    formData: async () => formData,
    headers: new Headers(headers),
  } as never;
};

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? 'OK' : 'Error',
  headers: new Headers(),
  json: async () => body,
  text: async () => JSON.stringify(body),
});

describe('MOCKED Firebase staging gate on inference routes', () => {
  const original = {
    auth: process.env.CHORDMINI_INFERENCE_AUTH,
    secret: process.env.CHORDMINI_INFERENCE_SECRET,
    staging: process.env.CHORDMINI_HOSTED_STAGING_AUTH,
    allow: process.env.CHORDMINI_STAGING_ALLOWED_UIDS,
    admin: process.env.FIREBASE_SERVICE_ACCOUNT_KEY,
    desktop: process.env.CHORDMINI_DESKTOP_MODE,
    python: process.env.PYTHON_API_URL,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CHORDMINI_HOSTED_STAGING_AUTH = 'required';
    process.env.CHORDMINI_STAGING_ALLOWED_UIDS = ALLOWED_UID;
    process.env.CHORDMINI_INFERENCE_AUTH = 'required';
    process.env.CHORDMINI_INFERENCE_SECRET = FLASK_SECRET;
    process.env.FIREBASE_SERVICE_ACCOUNT_KEY = FAKE_ADMIN;
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
    resetGatewayAdmissionForTests();
    delete process.env.CHORDMINI_HOSTED_GATEWAY_URL;
    delete process.env.CHORDMINI_HOSTED_GATEWAY_TEST_LOOPBACK;
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
    if (original.staging === undefined) delete process.env.CHORDMINI_HOSTED_STAGING_AUTH;
    else process.env.CHORDMINI_HOSTED_STAGING_AUTH = original.staging;
    if (original.allow === undefined) delete process.env.CHORDMINI_STAGING_ALLOWED_UIDS;
    else process.env.CHORDMINI_STAGING_ALLOWED_UIDS = original.allow;
    if (original.admin === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    else process.env.FIREBASE_SERVICE_ACCOUNT_KEY = original.admin;
    if (original.desktop === undefined) delete process.env.CHORDMINI_DESKTOP_MODE;
    else process.env.CHORDMINI_DESKTOP_MODE = original.desktop;
    if (original.python === undefined) delete process.env.PYTHON_API_URL;
    else process.env.PYTHON_API_URL = original.python;
    delete process.env.CHORDMINI_GATEWAY_ADMISSION;
    delete process.env.CHORDMINI_GATEWAY_INSTANCES;
    resetGatewayAdmissionForTests();
  });

  it('rejects a missing or malformed user token before inference', async () => {
    const missing = await postBeats(makeRequest());
    expect(missing.status).toBe(401);
    await expect(missing.json()).resolves.toMatchObject({ code: 'USER_AUTH_REQUIRED' });

    const malformed = await postChords(makeRequest({ authorization: 'Bearer not-a-jwt' }));
    expect(malformed.status).toBe(401);
    await expect(malformed.json()).resolves.toMatchObject({ code: 'USER_AUTH_MALFORMED' });

    const basic = await postBeats(makeRequest({ authorization: `Basic ${USER_TOKEN}` }));
    expect(basic.status).toBe(401);
    await expect(basic.json()).resolves.toMatchObject({ code: 'USER_AUTH_MALFORMED' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  it('rejects an invalid token and an expired token', async () => {
    mockVerifyIdToken.mockRejectedValueOnce({ code: 'auth/argument-error' });
    const invalid = await postBeats(makeRequest({ authorization: `Bearer ${USER_TOKEN}` }));
    expect(invalid.status).toBe(401);
    await expect(invalid.json()).resolves.toMatchObject({ code: 'USER_TOKEN_INVALID' });

    mockVerifyIdToken.mockRejectedValueOnce({ code: 'auth/id-token-expired' });
    const expired = await postChords(makeRequest({ authorization: `Bearer ${USER_TOKEN}` }));
    expect(expired.status).toBe(401);
    await expect(expired.json()).resolves.toMatchObject({ code: 'USER_TOKEN_EXPIRED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a verified uid that is not on the allowlist', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'other-user' });
    const response = await postBeats(makeRequest(
      { authorization: `Bearer ${USER_TOKEN}` },
      (form) => form.append('uid', ALLOWED_UID),
    ));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.code).toBe('USER_NOT_ALLOWLISTED');
    expect(JSON.stringify(body)).not.toContain(USER_TOKEN);
    expect(JSON.stringify(body)).not.toContain(FLASK_SECRET);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when the allowlist or admin credential is unusable', async () => {
    delete process.env.CHORDMINI_STAGING_ALLOWED_UIDS;
    const missing = await postBeats(makeRequest({ authorization: `Bearer ${USER_TOKEN}` }));
    expect(missing.status).toBe(503);
    await expect(missing.json()).resolves.toMatchObject({ code: 'STAGING_ALLOWLIST_NOT_CONFIGURED' });

    process.env.CHORDMINI_STAGING_ALLOWED_UIDS = '   ';
    const empty = await postChords(makeRequest({ authorization: `Bearer ${USER_TOKEN}` }));
    expect(empty.status).toBe(503);
    await expect(empty.json()).resolves.toMatchObject({ code: 'STAGING_ALLOWLIST_NOT_CONFIGURED' });

    process.env.CHORDMINI_STAGING_ALLOWED_UIDS = ALLOWED_UID;
    process.env.FIREBASE_SERVICE_ACCOUNT_KEY = '{';
    const badAdmin = await postBeats(makeRequest({ authorization: `Bearer ${USER_TOKEN}` }));
    expect(badAdmin.status).toBe(503);
    await expect(badAdmin.json()).resolves.toMatchObject({ code: 'STAGING_AUTH_NOT_CONFIGURED' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  it('forwards an allowlisted user with the server Flask token and unchanged success JSON', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: ALLOWED_UID });
    const payload = { success: true, beats: [0, 0.5], bpm: 120, model_used: 'madmom' };
    fetchMock.mockResolvedValue(jsonResponse(payload));

    const response = await postBeats(makeRequest(
      {
        authorization: `Bearer ${USER_TOKEN}`,
        'x-chordmini-inference-token': ATTACKER_FLASK_TOKEN,
      },
      (form) => {
        form.append('token', ATTACKER_FLASK_TOKEN);
        form.append('uid', 'forged-uid');
      },
    ));
    const [url, init] = fetchMock.mock.calls[0];
    const logged = [
      ...(console.log as jest.Mock).mock.calls,
      ...(console.error as jest.Mock).mock.calls,
    ].flat().join('\n');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(payload);
    expect(url).toBe('http://127.0.0.1:5001/api/detect-beats');
    expect(url).not.toContain(FLASK_SECRET);
    expect(init.headers).toEqual({ 'X-ChordMini-Inference-Token': FLASK_SECRET });
    expect(JSON.stringify(init.headers)).not.toContain(ATTACKER_FLASK_TOKEN);
    expect(JSON.stringify(init.headers)).not.toContain(USER_TOKEN);
    expect((init.body as FormData).get('token')).toBeNull();
    expect(mockVerifyIdToken).toHaveBeenCalledWith(USER_TOKEN, true);
    expect(logged).not.toContain(FLASK_SECRET);
    expect(logged).not.toContain(USER_TOKEN);
  });

  it('keeps chord HTTP 200 failures and beat HTTP 500 failures distinct for an allowlisted user', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: ALLOWED_UID });
    fetchMock.mockResolvedValueOnce(jsonResponse({
      success: false,
      error: 'Inference failed',
      model_used: 'chord-cnn-lstm',
    }));
    const chords = await postChords(makeRequest({ authorization: `Bearer ${USER_TOKEN}` }));
    expect(chords.status).toBe(200);
    await expect(chords.json()).resolves.toMatchObject({ success: false, model_used: 'chord-cnn-lstm' });

    fetchMock.mockResolvedValueOnce(jsonResponse({ success: false, error: 'Inference failed' }, 500));
    const beats = await postBeats(makeRequest({ authorization: `Bearer ${USER_TOKEN}` }));
    const beatBody = await beats.json();
    expect(beats.status).toBe(500);
    expect(beatBody.error).toBe('Beat detection failed');
    expect(beatBody.success).toBeUndefined();
  });
});
