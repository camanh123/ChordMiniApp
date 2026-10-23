/**
 * @jest-environment node
 *
 * CONTRACT (mocked Flask): desktop availability stays ahead of inference auth.
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

const SECRET = 'desktop-contract-secret-0123456789abcdef012345';
const fetchMock = jest.fn();

const makeRequest = () => {
  const formData = new FormData();
  formData.append('file', new File([new Uint8Array([1])], 'clip.wav', { type: 'audio/wav' }));
  return { formData: async () => formData, headers: new Headers() } as never;
};

describe('CONTRACT desktop inference boundary', () => {
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
    delete process.env.CHORDMINI_HOSTED_GATEWAY_URL;
    delete process.env.CHORDMINI_HOSTED_GATEWAY_TEST_LOOPBACK;
    delete process.env.PYTHON_API_URL;
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
  });

  it('keeps the missing-service error when desktop Flask is not configured', async () => {
    process.env.CHORDMINI_DESKTOP_MODE = '1';
    process.env.CHORDMINI_INFERENCE_AUTH = 'required';
    process.env.CHORDMINI_INFERENCE_SECRET = SECRET;
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const response = await postBeats(makeRequest());
    const body = await response.json();
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));

    expect(response.status).toBe(503);
    expect(body.code).toBe('ANALYSIS_SERVICE_NOT_CONFIGURED');
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(urls.some((url) => url.includes('/api/detect-beats'))).toBe(false);
  });

  it('keeps the unavailable error for an explicit dead loopback service', async () => {
    process.env.CHORDMINI_DESKTOP_MODE = '1';
    process.env.PYTHON_API_URL = 'http://127.0.0.1:9';
    process.env.CHORDMINI_INFERENCE_SECRET = SECRET;
    fetchMock.mockRejectedValue(new TypeError(`fetch failed ${SECRET}`));

    const response = await postBeats(makeRequest());
    const text = JSON.stringify(await response.json());

    expect(response.status).toBe(503);
    expect(text).toContain('ANALYSIS_SERVICE_UNAVAILABLE');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('127.0.0.1:9');
  });

  it('refuses protected mode on desktop even when Flask answers health', async () => {
    process.env.CHORDMINI_DESKTOP_MODE = '1';
    process.env.CHORDMINI_INFERENCE_AUTH = 'required';
    process.env.CHORDMINI_INFERENCE_SECRET = SECRET;
    process.env.PYTHON_API_URL = 'http://127.0.0.1:5001';
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/health')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ status: 'healthy' }),
          text: async () => '{"status":"healthy"}',
        };
      }
      throw new Error(`inference fetch was not allowed: ${url}`);
    });

    const response = await postBeats(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.code).toBe('INFERENCE_AUTH_NOT_AVAILABLE');
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://127.0.0.1:5001/health');
  });

  it('does not start hosted staging from the desktop process', async () => {
    process.env.CHORDMINI_DESKTOP_MODE = '1';
    process.env.CHORDMINI_HOSTED_STAGING_AUTH = 'required';
    process.env.CHORDMINI_STAGING_ALLOWED_UIDS = 'owner-uid';
    process.env.CHORDMINI_INFERENCE_AUTH = 'required';
    process.env.CHORDMINI_INFERENCE_SECRET = SECRET;
    process.env.PYTHON_API_URL = 'http://127.0.0.1:5001';
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/health')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ status: 'healthy' }),
          text: async () => '{"status":"healthy"}',
        };
      }
      throw new Error(`inference fetch was not allowed: ${url}`);
    });

    const response = await postBeats(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.code).toBe('INFERENCE_AUTH_NOT_AVAILABLE');
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
