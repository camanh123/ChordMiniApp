import {
  abandonDiagnosticSession,
  bindDiagnosticSession,
  configureAnalysisDiagnostics,
  formatDiagnosticElapsed,
  getAnalysisDiagnosticsSnapshot,
  noteAnalysisCompleted,
  noteBeatRequestSent,
  noteBeatResponseReceived,
  recordDiagnostic,
  refreshDiagnosticClock,
  resetAnalysisDiagnostics,
  sanitizeDiagnosticDetail,
} from '@/services/audio/analysisDiagnostics';

describe('analysis diagnostics', () => {
  beforeEach(() => {
    resetAnalysisDiagnostics();
  });

  it('keeps a stale completion off the current session', () => {
    const first = bindDiagnosticSession('song-a');
    noteBeatRequestSent(first, 'madmom');
    const second = bindDiagnosticSession('song-b');
    noteBeatResponseReceived(first, 'madmom');
    noteAnalysisCompleted(first);

    const snapshot = getAnalysisDiagnosticsSnapshot();
    expect(snapshot.currentSessionId).toBe(second);
    expect(snapshot.sessionState).toBe('submitted');
    const completed = snapshot.events.find((event) => event.code === 'ANALYSIS_COMPLETED');
    expect(completed?.sessionId).toBe(first);
    expect(completed?.applied).toBe(false);
    expect(snapshot.events.map((event) => event.code)).not.toContain('MODEL_PREFLIGHT_READY');
    expect(snapshot.events.map((event) => event.code)).not.toContain('BACKEND_READY');
  });

  it('does not treat a sent request as model start and marks unconfirmed cancellation only after a request', () => {
    const idle = bindDiagnosticSession('idle');
    abandonDiagnosticSession();
    expect(getAnalysisDiagnosticsSnapshot().cancellationUnconfirmed).toBe(false);

    const active = bindDiagnosticSession('active');
    noteBeatRequestSent(active, 'beat-transformer');
    expect(getAnalysisDiagnosticsSnapshot().sessionState).toBe('running');
    expect(getAnalysisDiagnosticsSnapshot().events.map((event) => event.code)).toEqual(['BEAT_REQUEST_SENT']);
    abandonDiagnosticSession();
    expect(getAnalysisDiagnosticsSnapshot().cancellationUnconfirmed).toBe(true);
    expect(idle).not.toBe(active);
  });

  it('measures elapsed time with the injected monotonic clock', () => {
    let clock = 1_000;
    configureAnalysisDiagnostics({ now: () => clock });
    bindDiagnosticSession('clock');
    clock = 4_250;
    refreshDiagnosticClock();
    expect(getAnalysisDiagnosticsSnapshot().elapsedMs).toBe(3_250);
    expect(formatDiagnosticElapsed(3_250)).toBe('0:03');
    expect(formatDiagnosticElapsed(3_250)).not.toContain('%');
  });

  it('sanitizes paths, hosts, and secrets and keeps a bounded buffer', () => {
    expect(sanitizeDiagnosticDetail('C:\\Users\\private\\song.wav')).toContain('[redacted-path]');
    expect(sanitizeDiagnosticDetail('file /home/private/song.wav')).toContain('[redacted-path]');
    expect(sanitizeDiagnosticDetail('see http://127.0.0.1:5001/health')).not.toMatch(/127\.0\.0\.1|https?:\/\//i);
    expect(sanitizeDiagnosticDetail('cookie=session-secret')).toContain('[redacted-secret]');
    expect(sanitizeDiagnosticDetail(`token=${'a'.repeat(48)}`)).toContain('[redacted-secret]');
    expect(sanitizeDiagnosticDetail('model=madmom')).toContain('madmom');

    const sessionId = bindDiagnosticSession('buffer');
    for (let index = 0; index < 90; index += 1) {
      recordDiagnostic('CHORD_REQUEST_SENT', { sessionId, detail: 'model=chord-cnn-lstm' });
    }
    const snapshot = getAnalysisDiagnosticsSnapshot();
    expect(snapshot.events).toHaveLength(80);
    expect(snapshot.events[0]?.id).toBeGreaterThan(10);
    expect(snapshot.events.every((event) => event.detail.includes('chord-cnn-lstm'))).toBe(true);
  });
});
