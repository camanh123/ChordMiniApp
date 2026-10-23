/**
 * CONTRACT (mocked Flask): Next.js route authentication and forwarding.
 * These tests do not load Madmom or Chord-CNN-LSTM.
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

    async text() {
      return JSON.stringify(this.body);
    }
  },
}));

const mockGetAudioDurationFromFile = jest.fn();
const mockCreateSafeTimeoutSignal = jest.fn();
const mockIsLocalBackend = jest.fn();

jest.mock('@/utils/audioDurationUtils', () => ({
  getAudioDurationFromFile: (...args: unknown[]) => mockGetAudioDurationFromFile(...args),
}));

jest.mock('@/utils/environmentUtils', () => ({
  createSafeTimeoutSignal: (...args: unknown[]) => mockCreateSafeTimeoutSignal(...args),
}));

jest.mock('@/utils/backendConfig', () => ({
  isLocalBackend: () => mockIsLocalBackend(),
}));

import { POST as postBeats } from '@/app/api/detect-beats/route';
import { POST as postChords } from '@/app/api/recognize-chords/route';

const SECRET = 'contract-route-secret-0123456789abcdef0123456789';
const ATTACKER = 'attacker-token-0123456789abcdef0123456789abcd';
const fetchMock = jest.fn();

const makeFile = () => new File([new Uint8Array([1, 2, 3, 4])], 'clip.wav', { type: 'audio/wav' });

const makeRequest = (formData: FormData, headers?: Record<string, string>) => ({
  formData: async () => formData,
  headers: new Headers(headers),
}) as never;

const makeResponse = ({
  ok,
  status,
  statusText = ok ? 'OK' : 'Error',
  jsonData,
  textData = '',
  headers = {},
}: {
  ok: boolean;
  status: number;
  statusText?: string;
  jsonData?: unknown;
  textData?: string;
  headers?: Record<string, string>;
}) => ({
  ok,
  status,
  statusText,
  headers: new Headers(headers),
  json: async () => jsonData,
  text: async () => textData,
});

function audioForm(extra?: (formData: FormData) => void): FormData {
  const formData = new FormData();
  formData.append('file', makeFile());
  extra?.(formData);
  return formData;
}

describe('CONTRACT mocked Next.js to Flask inference', () => {
  const original = {
    auth: process.env.CHORDMINI_INFERENCE_AUTH,
    secret: process.env.CHORDMINI_INFERENCE_SECRET,
    desktop: process.env.CHORDMINI_DESKTOP_MODE,
    python: process.env.PYTHON_API_URL,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.CHORDMINI_INFERENCE_AUTH;
    delete process.env.CHORDMINI_INFERENCE_SECRET;
    delete process.env.CHORDMINI_DESKTOP_MODE;
    delete process.env.CHORDMINI_HOSTED_STAGING_AUTH;
    delete process.env.CHORDMINI_STAGING_ALLOWED_UIDS;
    process.env.PYTHON_API_URL = 'http://127.0.0.1:5001';
    global.fetch = fetchMock as never;
    mockCreateSafeTimeoutSignal.mockReturnValue(new AbortController().signal);
    mockGetAudioDurationFromFile.mockResolvedValue(12);
    mockIsLocalBackend.mockReturnValue(true);
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
  });

  it('sends a valid server token and leaves the success contract unchanged', async () => {
    process.env.CHORDMINI_INFERENCE_AUTH = 'required';
    process.env.CHORDMINI_INFERENCE_SECRET = SECRET;
    const payload = { success: true, beats: [0, 0.5], bpm: 120, model_used: 'madmom' };
    fetchMock.mockResolvedValue(makeResponse({ ok: true, status: 200, jsonData: payload }));

    const response = await postBeats(makeRequest(audioForm((formData) => {
      formData.append('detector', 'madmom');
    }), { 'X-ChordMini-Inference-Token': ATTACKER }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(payload);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:5001/api/detect-beats');
    expect(url).not.toContain(SECRET);
    expect(init.headers).toEqual({ 'X-ChordMini-Inference-Token': SECRET });
    expect(JSON.stringify(init.headers)).not.toContain(ATTACKER);
  });

  it('fails closed before fetch when the protected secret is missing or invalid', async () => {
    process.env.CHORDMINI_INFERENCE_AUTH = 'required';
    const missing = await postBeats(makeRequest(audioForm()));
    expect(missing.status).toBe(503);
    await expect(missing.json()).resolves.toMatchObject({ code: 'INFERENCE_AUTH_NOT_CONFIGURED' });

    process.env.CHORDMINI_INFERENCE_SECRET = 'changeme';
    const invalid = await postChords(makeRequest(audioForm()));
    expect(invalid.status).toBe(503);
    await expect(invalid.json()).resolves.toMatchObject({ code: 'INFERENCE_AUTH_NOT_CONFIGURED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('replaces an invalid upstream credential without reflecting it', async () => {
    process.env.CHORDMINI_INFERENCE_AUTH = 'required';
    process.env.CHORDMINI_INFERENCE_SECRET = SECRET;
    fetchMock.mockResolvedValue(makeResponse({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      textData: JSON.stringify({ success: false, error: SECRET, code: 'AUTH_FAILED' }),
    }));

    const response = await postBeats(makeRequest(audioForm()));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({
      success: false,
      error: 'Analysis authentication failed',
      code: 'INFERENCE_AUTH_FAILED',
    });
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const logged = (console.error as jest.Mock).mock.calls.flat().join('\n');
    expect(logged).not.toContain(SECRET);
  });

  it('reports an unavailable Flask URL without the secret', async () => {
    process.env.CHORDMINI_INFERENCE_AUTH = 'required';
    process.env.CHORDMINI_INFERENCE_SECRET = SECRET;
    process.env.PYTHON_API_URL = 'http://127.0.0.1:9';
    fetchMock.mockRejectedValue(new TypeError(`fetch failed ${SECRET}`));

    const response = await postChords(makeRequest(audioForm()));
    const text = JSON.stringify(await response.json());

    expect(response.status).toBe(500);
    expect(text).not.toContain(SECRET);
    expect(text).toContain('[redacted]');
  });

  it('forwards the audio file and drops browser-supplied credentials', async () => {
    process.env.CHORDMINI_INFERENCE_AUTH = 'required';
    process.env.CHORDMINI_INFERENCE_SECRET = SECRET;
    const formData = audioForm((form) => {
      form.append('detector', 'madmom');
      form.append('token', ATTACKER);
      form.append('audio_path', '/etc/passwd');
    });
    fetchMock.mockResolvedValue(makeResponse({
      ok: true,
      status: 200,
      jsonData: { success: true, beats: [0] },
    }));

    await postBeats(makeRequest(formData, { authorization: `Bearer ${ATTACKER}` }));
    const forwarded = fetchMock.mock.calls[0][1].body as FormData;

    expect(forwarded).toBe(formData);
    expect(forwarded.get('detector')).toBe('madmom');
    expect((forwarded.get('file') as File).name).toBe('clip.wav');
    expect(forwarded.get('token')).toBeNull();
    expect(forwarded.get('audio_path')).toBeNull();
    expect(fetchMock.mock.calls[0][1].headers['X-ChordMini-Inference-Token']).toBe(SECRET);
  });

  it('does not attach a token in local mode and does not log form secrets', async () => {
    process.env.CHORDMINI_INFERENCE_AUTH = 'local';
    process.env.CHORDMINI_INFERENCE_SECRET = SECRET;
    const formData = audioForm((form) => form.append('secret', SECRET));
    fetchMock.mockResolvedValue(makeResponse({
      ok: true,
      status: 200,
      jsonData: { success: true, chords: [] },
    }));

    await postChords(makeRequest(formData));

    expect(fetchMock.mock.calls[0][1].headers).toEqual({});
    expect((fetchMock.mock.calls[0][1].body as FormData).get('secret')).toBeNull();
    const logged = (console.log as jest.Mock).mock.calls.flat().join('\n');
    expect(logged).not.toContain(SECRET);
  });

  it('keeps a chord HTTP 200 failure and a beat HTTP 500 failure distinct', async () => {
    fetchMock.mockResolvedValue(makeResponse({
      ok: true,
      status: 200,
      jsonData: { success: false, error: 'Inference failed', model_used: 'chord-cnn-lstm' },
    }));
    const chords = await postChords(makeRequest(audioForm((form) => form.append('model', 'chord-cnn-lstm'))));
    expect(chords.status).toBe(200);
    await expect(chords.json()).resolves.toEqual({
      success: false,
      error: 'Inference failed',
      model_used: 'chord-cnn-lstm',
    });

    fetchMock.mockResolvedValue(makeResponse({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      textData: JSON.stringify({ success: false, error: 'Inference failed', model_used: 'madmom' }),
    }));
    const beats = await postBeats(makeRequest(audioForm()));
    const beatBody = await beats.json();
    expect(beats.status).toBe(500);
    expect(beatBody.error).toBe('Beat detection failed');
    expect(beatBody.model_used).toBeUndefined();
    expect(JSON.stringify(beatBody)).not.toContain('Inference failed');
  });

  it('does not retry a beat-transformer authentication failure', async () => {
    process.env.CHORDMINI_INFERENCE_AUTH = 'required';
    process.env.CHORDMINI_INFERENCE_SECRET = SECRET;
    fetchMock.mockResolvedValue(makeResponse({
      ok: false,
      status: 401,
      textData: JSON.stringify({ code: 'AUTH_FAILED', error: SECRET }),
    }));

    const response = await postBeats(makeRequest(audioForm((form) => form.append('detector', 'beat-transformer'))));

    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await response.json())).not.toContain(SECRET);
  });

  it('sends the same server token when a checkpoint retry is allowed', async () => {
    process.env.CHORDMINI_INFERENCE_AUTH = 'required';
    process.env.CHORDMINI_INFERENCE_SECRET = SECRET;
    fetchMock
      .mockResolvedValueOnce(makeResponse({
        ok: false,
        status: 500,
        textData: "Can't load save_path for checkpoint",
      }))
      .mockResolvedValueOnce(makeResponse({
        ok: true,
        status: 200,
        jsonData: { success: true, beats: [0], detector: 'madmom' },
      }));

    const formData = audioForm((form) => {
      form.append('detector', 'beat-transformer');
      form.append('token', ATTACKER);
    });
    const response = await postBeats(makeRequest(formData));
    const retry = fetchMock.mock.calls[1][1];

    expect(response.status).toBe(200);
    expect(retry.headers).toEqual({ 'X-ChordMini-Inference-Token': SECRET });
    expect((retry.body as FormData).get('detector')).toBe('madmom');
    expect((retry.body as FormData).get('token')).toBeNull();
    expect(JSON.stringify(await response.json())).not.toContain(SECRET);
  });
});
