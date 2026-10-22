import { API_ROUTES } from '@/config/api';
import { backendConfig } from '@/utils/backendConfig';
import { GET } from '@/app/api/config/route';

class TestResponse {
  status: number;
  private readonly body: string;

  constructor(body?: BodyInit | null, init?: ResponseInit) {
    this.body = typeof body === 'string' ? body : '';
    this.status = init?.status ?? 200;
  }

  async json(): Promise<unknown> {
    return JSON.parse(this.body);
  }
}

if (typeof globalThis.Response === 'undefined') {
  globalThis.Response = TestResponse as unknown as typeof Response;
}

const ANALYSIS_ROUTES = {
  RECOGNIZE_CHORDS: '/api/recognize-chords',
  RECOGNIZE_CHORDS_BTC_PL: '/api/recognize-chords-btc-pl',
  RECOGNIZE_CHORDS_BTC_SL: '/api/recognize-chords-btc-sl',
  DETECT_KEY: '/api/detect-key',
  MODEL_INFO: '/api/model-info',
  TRANSCRIBE_SHEETSAGE: '/api/transcribe-sheetsage',
} as const;

describe('same-origin analysis API contract', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('keeps client analysis routes on this origin', () => {
    for (const path of Object.values(API_ROUTES)) {
      expect(path.startsWith('/api/')).toBe(true);
      expect(path.includes('://')).toBe(false);
    }

    expect(API_ROUTES).toMatchObject(ANALYSIS_ROUTES);
    expect(backendConfig.endpoints).toMatchObject({
      detectBeats: '/api/detect-beats',
      recognizeChords: '/api/recognize-chords',
      recognizeChordsBtcPl: '/api/recognize-chords-btc-pl',
      recognizeChordsBtcSl: '/api/recognize-chords-btc-sl',
      modelInfo: '/api/model-info',
    });
  });

  it('serves public runtime config without private backend material', async () => {
    process.env.NEXT_PUBLIC_BASE_URL = 'https://chordmini.example';
    process.env.NEXT_PUBLIC_APP_RUNTIME = 'web';
    process.env.NEXT_PUBLIC_FIREBASE_API_KEY = 'public-firebase-key';
    process.env.PYTHON_API_URL = 'https://user:secret@ml.internal.example';
    process.env.SONGFORMER_API_URL = 'https://songformer.internal.example';
    process.env.SHEETSAGE_API_URL = 'https://sheetsage.internal.example';
    process.env.FIREBASE_SERVICE_ACCOUNT_KEY = '{"private_key":"admin-secret"}';
    process.env.GEMINI_API_KEY = 'gemini-secret';
    process.env.NEXT_PUBLIC_PYTHON_API_URL = 'https://leaked-python.example';
    process.env.NEXT_PUBLIC_SHEETSAGE_API_URL = 'https://leaked-sheetsage.example';
    process.env.NEXT_PUBLIC_SERVICE_ACCOUNT_JSON = '{"private_key":"prefixed-secret"}';

    const response = await GET();
    const body = await response.json() as Record<string, string>;
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(body.NEXT_PUBLIC_BASE_URL).toBe('https://chordmini.example');
    expect(body.NEXT_PUBLIC_APP_RUNTIME).toBe('web');
    expect(body.NEXT_PUBLIC_FIREBASE_API_KEY).toBe('public-firebase-key');
    expect(body.PYTHON_API_URL).toBeUndefined();
    expect(body.NEXT_PUBLIC_PYTHON_API_URL).toBeUndefined();
    expect(body.NEXT_PUBLIC_SHEETSAGE_API_URL).toBeUndefined();
    expect(body.FIREBASE_SERVICE_ACCOUNT_KEY).toBeUndefined();
    expect(body.GEMINI_API_KEY).toBeUndefined();
    expect(serialized).not.toContain('ml.internal.example');
    expect(serialized).not.toContain('admin-secret');
    expect(serialized).not.toContain('gemini-secret');
    expect(serialized).not.toContain('leaked-python.example');
    expect(serialized).not.toContain('prefixed-secret');
  });
});
