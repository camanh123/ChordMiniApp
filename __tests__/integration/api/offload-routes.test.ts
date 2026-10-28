/**
 * Integration tests for Next.js offload BFF routes.
 * Verifies the BFF forwards only firebase_url + metadata to the backend,
 * never re-sending uploaded audio bytes.
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

const fetchMock = jest.fn();
const mockCreateSafeTimeoutSignal = jest.fn();
const mockValidateOffloadUrl = jest.fn();
const mockGetPythonApiUrl = jest.fn();
const mockDeleteOffloadUrl = jest.fn();

jest.mock('@/utils/environmentUtils', () => ({
  createSafeTimeoutSignal: (...args: unknown[]) => mockCreateSafeTimeoutSignal(...args),
}));

jest.mock('@/utils/blobValidation', () => ({
  validateOffloadUrl: (...args: unknown[]) => mockValidateOffloadUrl(...args),
}));

jest.mock('@/config/serverBackend', () => ({
  getPythonApiUrl: (...args: unknown[]) => mockGetPythonApiUrl(...args),
}));

jest.mock('@/services/storage/offloadCleanupService', () => ({
  deleteOffloadUrl: (...args: unknown[]) => mockDeleteOffloadUrl(...args),
}));

import { POST as detectBeatsOffload } from '@/app/api/detect-beats-offload/route';
import { POST as recognizeChordsOffload } from '@/app/api/recognize-chords-offload/route';

const makeRequest = (formData: FormData) => ({ formData: async () => formData }) as any;
const makeFile = (size = 128, name = 'demo.mp3', type = 'audio/mpeg') =>
  new File([new Uint8Array(size)], name, { type });

const makeResponse = (jsonData: unknown) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  json: async () => jsonData,
  text: async () => JSON.stringify(jsonData),
});

describe('offload BFF routes', () => {
  const firebaseUrl = 'https://firebasestorage.googleapis.com/v0/b/demo/o/temp%2Fsong.mp3?alt=media&token=abc';

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = fetchMock as any;
    mockCreateSafeTimeoutSignal.mockReturnValue(new AbortController().signal);
    mockValidateOffloadUrl.mockImplementation((url: string) => url);
    mockGetPythonApiUrl.mockReturnValue('https://python-backend.example');
    mockDeleteOffloadUrl.mockResolvedValue({ success: true, provider: 'firebase' });
  });

  it('detect-beats-offload forwards only firebase_url + metadata, not file bytes', async () => {
    const formData = new FormData();
    formData.append('offload_url', firebaseUrl);
    formData.append('detector', 'madmom');
    formData.append('force', 'true');
    formData.append('audio_duration', '123.4');
    formData.append('file', makeFile());

    fetchMock.mockResolvedValue(makeResponse({ success: true, beats: [0, 1] }));

    const response = await detectBeatsOffload(makeRequest(formData));
    const forwardedBody = fetchMock.mock.calls[0][1].body as FormData;

    expect(fetchMock).toHaveBeenCalledWith(
      'https://python-backend.example/api/detect-beats-firebase',
      expect.objectContaining({ method: 'POST', body: forwardedBody })
    );
    expect(forwardedBody.get('firebase_url')).toBe(firebaseUrl);
    expect(forwardedBody.get('detector')).toBe('madmom');
    expect(forwardedBody.get('force')).toBe('true');
    expect(forwardedBody.get('file')).toBeNull();
    expect(mockDeleteOffloadUrl).toHaveBeenCalledWith(firebaseUrl);
    await expect(response.json()).resolves.toEqual({ success: true, beats: [0, 1] });
  });

  it('does not contact a remote python URL from the desktop offload route', async () => {
    const previousDesktop = process.env.CHORDMINI_DESKTOP_MODE;
    const previousPython = process.env.PYTHON_API_URL;
    process.env.CHORDMINI_DESKTOP_MODE = '1';
    process.env.PYTHON_API_URL = 'https://user:secret@ml.example/private';
    const formData = new FormData();
    formData.append('offload_url', firebaseUrl);

    try {
      const response = await detectBeatsOffload(makeRequest(formData));
      const text = JSON.stringify(await response.json());

      expect(response.status).toBe(503);
      expect(text).toContain('ANALYSIS_SERVICE_NOT_CONFIGURED');
      expect(text).not.toContain('ml.example');
      expect(text).not.toContain('secret');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (previousDesktop === undefined) delete process.env.CHORDMINI_DESKTOP_MODE;
      else process.env.CHORDMINI_DESKTOP_MODE = previousDesktop;
      if (previousPython === undefined) delete process.env.PYTHON_API_URL;
      else process.env.PYTHON_API_URL = previousPython;
    }
  });

  it('recognize-chords-offload forwards only firebase_url + metadata, not file bytes', async () => {
    const formData = new FormData();
    formData.append('offload_url', firebaseUrl);
    formData.append('model', 'chord-cnn-lstm');
    formData.append('detector', 'chord-cnn-lstm');
    formData.append('file', makeFile());

    fetchMock.mockResolvedValue(makeResponse({ success: true, chords: [{ chord: 'C:maj', start: 0, end: 1 }] }));

    const response = await recognizeChordsOffload(makeRequest(formData));
    const forwardedBody = fetchMock.mock.calls[0][1].body as FormData;

    expect(fetchMock).toHaveBeenCalledWith(
      'https://python-backend.example/api/recognize-chords-firebase',
      expect.objectContaining({ method: 'POST', body: forwardedBody })
    );
    expect(forwardedBody.get('firebase_url')).toBe(firebaseUrl);
    expect(forwardedBody.get('model')).toBe('chord-cnn-lstm');
    expect(forwardedBody.get('detector')).toBe('chord-cnn-lstm');
    expect(forwardedBody.get('chord_dict')).toBe('full');
    expect(forwardedBody.get('file')).toBeNull();
    expect(mockDeleteOffloadUrl).toHaveBeenCalledWith(firebaseUrl);
    await expect(response.json()).resolves.toEqual({ success: true, chords: [{ chord: 'C:maj', start: 0, end: 1 }] });
  });

  it('rejects a supplied duration over 12 minutes before calling the backend', async () => {
    const formData = new FormData();
    formData.append('offload_url', firebaseUrl);
    formData.append('audio_duration', '721');

    const response = await detectBeatsOffload(makeRequest(formData));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBe('DURATION_REJECTED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards a Firebase URL when duration was not supplied', async () => {
    const formData = new FormData();
    formData.append('offload_url', firebaseUrl);
    formData.append('detector', 'madmom');
    fetchMock.mockResolvedValue(makeResponse({ success: true, beats: [] }));

    const response = await detectBeatsOffload(makeRequest(formData));
    const forwardedBody = fetchMock.mock.calls[0][1].body as FormData;

    expect(response.status).toBe(200);
    expect(forwardedBody.get('firebase_url')).toBe(firebaseUrl);
    expect(forwardedBody.get('audio_duration')).toBeNull();
    expect(mockCreateSafeTimeoutSignal).toHaveBeenCalledWith(290000);
  });

  it('strips signed query text from backend beat errors', async () => {
    const formData = new FormData();
    formData.append('offload_url', firebaseUrl);
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => `download failed ${firebaseUrl} token=signed-token-value`,
      json: async () => ({}),
    });

    const response = await detectBeatsOffload(makeRequest(formData));
    const text = JSON.stringify(await response.json());

    expect(response.status).toBe(400);
    expect(text).not.toContain('token=');
    expect(text).not.toContain('signed-token-value');
    expect(text).not.toContain('alt=media');
  });

  it('does not return HTTP 200 when the backend body says inference failed', async () => {
    const formData = new FormData();
    formData.append('offload_url', firebaseUrl);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '',
      json: async () => ({ success: false, error: 'Madmom is not available', code: 'INFERENCE_FAILED' }),
    });

    const beats = await detectBeatsOffload(makeRequest(formData));
    const beatBody = await beats.json();
    expect(beats.status).toBe(500);
    expect(beatBody.success).toBe(false);
    expect(beatBody.code).toBe('INFERENCE_FAILED');
    expect(mockDeleteOffloadUrl).not.toHaveBeenCalled();

    const chordForm = new FormData();
    chordForm.append('offload_url', firebaseUrl);
    chordForm.append('model', 'chord-cnn-lstm');
    const chords = await recognizeChordsOffload(makeRequest(chordForm));
    const chordBody = await chords.json();
    expect(chords.status).toBe(500);
    expect(chordBody.success).toBe(false);
    expect(chordBody.error).toBe('Madmom is not available');
  });

  it('surfaces a backend format rejection instead of hiding it', async () => {
    const formData = new FormData();
    formData.append('offload_url', firebaseUrl);
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => JSON.stringify({
        success: false,
        error: 'Firebase offload accepts WAV and MP3. This file is FLAC.',
        code: 'UNSUPPORTED_OFFLOAD_FORMAT',
      }),
      json: async () => ({}),
    });

    const response = await recognizeChordsOffload(makeRequest(formData));
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.code).toBe('UNSUPPORTED_OFFLOAD_FORMAT');
    expect(body.error).toContain('WAV and MP3');
    expect(body.error).toContain('FLAC');
  });

  it('rejects an ineligible chord duration before calling the backend', async () => {
    const formData = new FormData();
    formData.append('offload_url', firebaseUrl);
    formData.append('audio_duration', '0');

    const response = await recognizeChordsOffload(makeRequest(formData));

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
