import {
  bindDiagnosticSession,
  getAnalysisDiagnosticsSnapshot,
  resetAnalysisDiagnostics,
} from '@/services/audio/analysisDiagnostics';
import {
  observeVerifiedReadiness,
  parsePublicBackendReadiness,
  pollVerifiedBackendStatus,
  requestBackendRetryAndObserve,
  type PublicBackendReadiness,
} from '@/services/audio/backendReadiness';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function readiness(overrides: Partial<PublicBackendReadiness> = {}): PublicBackendReadiness {
  return {
    verified: true,
    phase: 'server-ready',
    serverReady: true,
    modelPreflightReady: true,
    inferenceVerified: false,
    code: 'MODEL_PREFLIGHT_READY',
    reason: '',
    models: { chordCnnLstm: true, beatTransformer: true, madmom: true },
    ...overrides,
  };
}

describe('verified backend readiness', () => {
  beforeEach(() => {
    resetAnalysisDiagnostics();
  });

  it('treats an accepted retry as a request and keeps Flask unavailable when status says so', async () => {
    const fetchImpl = jest.fn(async (url: string) => {
      if (String(url).includes('backend-retry')) return jsonResponse({ ok: true });
      return jsonResponse(readiness({
        phase: 'failed',
        serverReady: false,
        modelPreflightReady: false,
        code: 'BACKEND_START_FAILED',
        reason: 'The local analysis service is not ready.',
        models: { chordCnnLstm: null, beatTransformer: null, madmom: null },
      }));
    });

    await requestBackendRetryAndObserve({ fetchImpl: fetchImpl as unknown as typeof fetch, attemptLimit: 3 });

    const codes = getAnalysisDiagnosticsSnapshot().events.map((event) => event.code);
    expect(codes).toEqual(['BACKEND_RETRY_REQUESTED', 'BACKEND_UNAVAILABLE']);
    expect(getAnalysisDiagnosticsSnapshot().events[0]?.detail).toBe('accepted');
    expect(getAnalysisDiagnosticsSnapshot().events[1]?.detail).toContain('BACKEND_START_FAILED');
    expect(codes).not.toContain('BACKEND_READY');
    expect(codes).not.toContain('MODEL_PREFLIGHT_READY');
  });

  it('records server readiness and a missing model without calling that inference', async () => {
    const sessionId = bindDiagnosticSession('flask');
    observeVerifiedReadiness(sessionId, readiness({
      phase: 'failed',
      modelPreflightReady: false,
      code: 'MODEL_UNAVAILABLE',
      reason: 'Madmom weight file C:\\Users\\private\\madmom.pt was not confirmed.',
      models: { chordCnnLstm: false, beatTransformer: false, madmom: false },
    }));

    const snapshot = getAnalysisDiagnosticsSnapshot();
    expect(snapshot.events.map((event) => event.code)).toEqual(['BACKEND_READY', 'MODEL_PREFLIGHT_FAILED']);
    expect(snapshot.events[1]?.detail).toContain('missing=chordCnnLstm,beatTransformer,madmom');
    expect(snapshot.events[1]?.detail).toContain('[redacted-path]');
    expect(snapshot.events.map((event) => event.detail).join(' ')).not.toMatch(/Users\\|madmom\.pt|inference verified/i);
    expect(snapshot.events.map((event) => event.code)).not.toContain('ANALYSIS_COMPLETED');
  });

  it('records model preflight without a real inference event', () => {
    const sessionId = bindDiagnosticSession('preflight');
    const parsed = parsePublicBackendReadiness({
      verified: true,
      phase: 'server-ready',
      serverReady: true,
      modelPreflightReady: true,
      inferenceVerified: true,
      code: 'MODEL_PREFLIGHT_READY',
      reason: 'imports only',
      models: { chordCnnLstm: true, beatTransformer: false, madmom: true },
    });
    expect(parsed?.inferenceVerified).toBe(false);
    expect(parsed?.modelPreflightReady).toBe(true);
    observeVerifiedReadiness(sessionId, parsed as PublicBackendReadiness);

    const codes = getAnalysisDiagnosticsSnapshot().events.map((event) => event.code);
    expect(codes).toEqual(['BACKEND_READY', 'MODEL_PREFLIGHT_READY', 'MODEL_PREFLIGHT_FAILED']);
    expect(getAnalysisDiagnosticsSnapshot().events[1]?.detail).toBe('inference=unverified');
    expect(getAnalysisDiagnosticsSnapshot().events[2]?.detail).toContain('missing=beatTransformer');
    expect(codes).not.toContain('ANALYSIS_COMPLETED');
    expect(codes).not.toContain('BEAT_REQUEST_SENT');
    expect(codes.join(' ')).not.toMatch(/MODEL_START|MODEL_FINISH|INFERENCE_VERIFIED/);
  });

  it('records timeout, invalid status, and a later restart as unavailable', async () => {
    const hanging = jest.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    await pollVerifiedBackendStatus({
      fetchImpl: hanging as unknown as typeof fetch,
      timeoutMs: 30,
      attemptLimit: 3,
    });
    expect(getAnalysisDiagnosticsSnapshot().events.map((event) => event.detail)).toContain('TIMEOUT');

    resetAnalysisDiagnostics();
    const invalid = jest.fn(async () => jsonResponse({
      phase: 'server-ready',
      serverReady: true,
      inferenceVerified: true,
      code: 'BACKEND_READY',
    }));
    await pollVerifiedBackendStatus({ fetchImpl: invalid as unknown as typeof fetch, attemptLimit: 3 });
    expect(getAnalysisDiagnosticsSnapshot().events.map((event) => event.code)).toEqual(['BACKEND_UNAVAILABLE']);
    expect(getAnalysisDiagnosticsSnapshot().events[0]?.detail).toBe('STATUS_INVALID');

    resetAnalysisDiagnostics();
    const sessionId = bindDiagnosticSession('restart');
    observeVerifiedReadiness(sessionId, readiness());
    observeVerifiedReadiness(sessionId, readiness({
      phase: 'failed',
      serverReady: false,
      modelPreflightReady: false,
      code: 'BACKEND_CRASH',
      reason: 'The analysis service stopped.',
      models: { chordCnnLstm: null, beatTransformer: null, madmom: null },
    }));
    const events = getAnalysisDiagnosticsSnapshot().events;
    expect(events.map((event) => event.code)).toEqual([
      'BACKEND_READY',
      'MODEL_PREFLIGHT_READY',
      'BACKEND_UNAVAILABLE',
    ]);
    expect(events[2]?.detail).toContain('BACKEND_CRASH');
    expect(events.filter((event) => event.code === 'BACKEND_READY')).toHaveLength(1);
  });

  it('stops polling once status is terminal and caps starting polls', async () => {
    let clock = 0;
    let reads = 0;
    const fetchImpl = jest.fn(async (url: string) => {
      if (String(url).includes('backend-retry')) return jsonResponse({ ok: true });
      reads += 1;
      return jsonResponse(readiness({
        phase: 'starting',
        serverReady: false,
        modelPreflightReady: false,
        code: 'STARTING',
        models: { chordCnnLstm: null, beatTransformer: null, madmom: null },
      }));
    });

    await requestBackendRetryAndObserve({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
      },
      timeoutMs: 5_000,
      attemptLimit: 3,
      intervalMs: 400,
    });

    expect(reads).toBe(3);
    expect(getAnalysisDiagnosticsSnapshot().events.map((event) => event.code)).toEqual([
      'BACKEND_RETRY_REQUESTED',
      'BACKEND_UNAVAILABLE',
    ]);
    expect(getAnalysisDiagnosticsSnapshot().events[1]?.detail).toContain('STARTING');
  });

  it('keeps a late readiness event on the session that requested it', async () => {
    const first = bindDiagnosticSession('song-a');
    let releaseGet: (response: Response) => void = () => {};
    const fetchImpl = jest.fn((url: string) => {
      if (String(url).includes('backend-retry')) return Promise.resolve(jsonResponse({ ok: true }));
      return new Promise<Response>((resolve) => {
        releaseGet = resolve;
      });
    });

    const pending = requestBackendRetryAndObserve({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 2_000,
      attemptLimit: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = bindDiagnosticSession('song-b');
    releaseGet(jsonResponse(readiness()));
    await pending;

    const snapshot = getAnalysisDiagnosticsSnapshot();
    expect(snapshot.currentSessionId).toBe(second);
    expect(snapshot.sessionState).toBe('submitted');
    const ready = snapshot.events.find((event) => event.code === 'BACKEND_READY');
    expect(ready?.sessionId).toBe(first);
    expect(snapshot.events.filter((event) => event.sessionId === second).map((event) => event.code)).not.toContain('BACKEND_READY');
    expect(snapshot.events.map((event) => event.code)).not.toContain('ANALYSIS_COMPLETED');
    expect(first).not.toBe(second);
  });
});
