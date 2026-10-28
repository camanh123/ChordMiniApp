/**
 * In-memory analysis diagnostics for the current page.
 * Events are session-scoped, sanitized, and discarded when the page reloads.
 * This is not a telemetry service and it does not write to disk.
 */

import { redactDiagnosticsText } from '@/utils/analysisServiceError';
import type { DurationEligibility } from '@/utils/analysisDurationLimit';

export const DIAGNOSTIC_CODES = [
  'SOURCE_SELECTED',
  'AUDIO_VALIDATED',
  'AUDIO_REJECTED',
  'BACKEND_CONNECTING',
  'BACKEND_RETRY_REQUESTED',
  'BACKEND_READY',
  'BACKEND_UNAVAILABLE',
  'MODEL_PREFLIGHT_READY',
  'MODEL_PREFLIGHT_FAILED',
  'BEAT_REQUEST_SENT',
  'BEAT_RESPONSE_RECEIVED',
  'CHORD_REQUEST_SENT',
  'CHORD_RESPONSE_RECEIVED',
  'ANALYSIS_COMPLETED',
  'ANALYSIS_FAILED',
  'HISTORY_SAVE_STARTED',
  'HISTORY_SAVE_COMPLETED',
  'HISTORY_SAVE_FAILED',
] as const;

export type DiagnosticCode = typeof DIAGNOSTIC_CODES[number];

export type DiagnosticSessionState = 'submitted' | 'running' | 'returned' | 'failed' | 'abandoned';

export interface DiagnosticEvent {
  id: number;
  code: DiagnosticCode;
  sessionId: string;
  elapsedMs: number;
  detail: string;
  applied: boolean;
}

export interface DiagnosticSnapshot {
  events: readonly DiagnosticEvent[];
  currentSessionId: string | null;
  sessionState: DiagnosticSessionState | null;
  elapsedMs: number;
  sessionActive: boolean;
  cancellationUnconfirmed: boolean;
}

const BUFFER_LIMIT = 80;
const MODEL_IDS = new Set([
  'auto',
  'madmom',
  'beat-transformer',
  'chord-cnn-lstm',
  'btc-sl',
  'btc-pl',
]);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'flac', 'ogg', 'aiff', 'aif', 'm4a', 'mp4']);
const SERVICE_CODES = new Set([
  'ANALYSIS_SERVICE_UNAVAILABLE',
  'ANALYSIS_SERVICE_NOT_CONFIGURED',
  'ANALYSIS_BACKEND_NOT_READY',
  'MODEL_UNAVAILABLE',
]);

interface SessionRecord {
  id: string;
  state: DiagnosticSessionState;
  startedAt: number;
  requestSent: boolean;
  cancellationUnconfirmed: boolean;
  frozenElapsedMs: number | null;
}

const EMPTY_SNAPSHOT: DiagnosticSnapshot = {
  events: [],
  currentSessionId: null,
  sessionState: null,
  elapsedMs: 0,
  sessionActive: false,
  cancellationUnconfirmed: false,
};

let nowImpl = defaultNow;
let sessions = new Map<string, SessionRecord>();
let currentAnalysisSessionId: string | null = null;
let scopeStack: Array<string | null> = [];
let events: DiagnosticEvent[] = [];
let eventSeq = 0;
let sessionSeq = 0;
let snapshot: DiagnosticSnapshot = EMPTY_SNAPSHOT;
const listeners = new Set<() => void>();

function defaultNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return 0;
}

export function configureAnalysisDiagnostics(options: { now?: () => number }): void {
  if (options.now) nowImpl = options.now;
}

export function monotonicDiagnosticNow(): number {
  const value = nowImpl();
  return Number.isFinite(value) ? value : 0;
}

export function sanitizeDiagnosticDetail(value: string): string {
  const redacted = redactDiagnosticsText(value)
    .replace(/(?:[A-Za-z]:\\+|\\\\)[^\s]+/g, '[redacted-path]')
    .replace(/(?:^|\s)\/(?:[^\s/]+\/)+[^\s]+/g, ' [redacted-path]')
    .replace(/\b(?:cookie|token|secret|authorization|bearer)\b\s*[:=]\s*\S+/gi, '[redacted-secret]')
    .replace(/\b[A-Za-z0-9_-]{48,}\b/g, '[redacted-token]')
    .replace(/[\u0000-\u001f]/g, '');
  return redacted.replace(/\s+/g, ' ').trim().slice(0, 180);
}

export function audioExtensionLabel(name: string): string | null {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  if (!match) return null;
  const extension = match[1].toLowerCase();
  return AUDIO_EXTENSIONS.has(extension) ? extension : null;
}

export function diagnosticModelLabel(model: string): string | null {
  return MODEL_IDS.has(model) ? model : null;
}

function publish(): void {
  const session = currentAnalysisSessionId ? sessions.get(currentAnalysisSessionId) ?? null : null;
  const elapsedMs = session ? sessionElapsed(session) : 0;
  const sessionActive = session?.state === 'submitted' || session?.state === 'running';
  snapshot = {
    events,
    currentSessionId: currentAnalysisSessionId,
    sessionState: session?.state ?? null,
    elapsedMs,
    sessionActive,
    cancellationUnconfirmed: Boolean(session?.cancellationUnconfirmed),
  };
  listeners.forEach((listener) => listener());
}

function sessionElapsed(session: SessionRecord): number {
  if (session.frozenElapsedMs !== null) return session.frozenElapsedMs;
  return Math.max(0, monotonicDiagnosticNow() - session.startedAt);
}

function freeze(session: SessionRecord): void {
  if (session.frozenElapsedMs === null) {
    session.frozenElapsedMs = sessionElapsed(session);
  }
}

export function subscribeAnalysisDiagnostics(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAnalysisDiagnosticsSnapshot(): DiagnosticSnapshot {
  return snapshot;
}

export function refreshDiagnosticClock(): void {
  publish();
}

export function resetAnalysisDiagnostics(): void {
  sessions = new Map();
  currentAnalysisSessionId = null;
  scopeStack = [];
  events = [];
  eventSeq = 0;
  snapshot = EMPTY_SNAPSHOT;
  nowImpl = defaultNow;
  publish();
}

export function uiDiagnosticSessionId(): string | null {
  return currentAnalysisSessionId;
}

export function currentDiagnosticSessionId(): string | null {
  if (scopeStack.length > 0) return scopeStack[scopeStack.length - 1];
  return currentAnalysisSessionId;
}

/**
 * Keeps a readiness note on the session that asked for it.
 * A missing id does not replace an analysis session that is already current.
 */
export function ensureDiagnosticSessionId(preferred?: string | null): string {
  if (preferred) return preferred;
  const current = currentDiagnosticSessionId();
  if (current) return current;
  const id = `note-${++sessionSeq}`;
  sessions.set(id, {
    id,
    state: 'submitted',
    startedAt: monotonicDiagnosticNow(),
    requestSent: false,
    cancellationUnconfirmed: false,
    frozenElapsedMs: 0,
  });
  currentAnalysisSessionId = id;
  publish();
  return id;
}

export function pushDiagnosticScope(sessionId: string | null): void {
  scopeStack.push(sessionId);
}

export function popDiagnosticScope(sessionId: string | null): void {
  const top = scopeStack[scopeStack.length - 1];
  if (scopeStack.length > 0 && top === sessionId) {
    scopeStack.pop();
    return;
  }
  const index = scopeStack.lastIndexOf(sessionId);
  if (index >= 0) scopeStack.splice(index, 1);
}

function abandonRecord(session: SessionRecord): void {
  if (session.state === 'returned' || session.state === 'failed' || session.state === 'abandoned') return;
  session.state = 'abandoned';
  session.cancellationUnconfirmed = session.requestSent;
  freeze(session);
}

export function bindDiagnosticSession(token: number | string): string {
  const previous = currentAnalysisSessionId ? sessions.get(currentAnalysisSessionId) : null;
  if (previous) abandonRecord(previous);
  const id = `analysis-${token}-${++sessionSeq}`;
  sessions.set(id, {
    id,
    state: 'submitted',
    startedAt: monotonicDiagnosticNow(),
    requestSent: false,
    cancellationUnconfirmed: false,
    frozenElapsedMs: null,
  });
  currentAnalysisSessionId = id;
  publish();
  return id;
}

export function beginDiagnosticSession(): string {
  return bindDiagnosticSession(`ui-${sessionSeq + 1}`);
}

export function abandonDiagnosticSession(): void {
  if (!currentAnalysisSessionId) return;
  const session = sessions.get(currentAnalysisSessionId);
  if (!session) return;
  abandonRecord(session);
  publish();
}

const SOURCE_KINDS = new Set(['youtube', 'soundcloud', 'local-audio', 'microphone']);

export function noteSourceSelected(kind: string): void {
  if (!SOURCE_KINDS.has(kind)) return;
  if (currentAnalysisSessionId) {
    abandonDiagnosticSession();
    recordDiagnostic('SOURCE_SELECTED', { detail: kind });
    return;
  }
  const id = `note-${++sessionSeq}`;
  sessions.set(id, {
    id,
    state: 'submitted',
    startedAt: monotonicDiagnosticNow(),
    requestSent: false,
    cancellationUnconfirmed: false,
    frozenElapsedMs: 0,
  });
  recordDiagnostic('SOURCE_SELECTED', { sessionId: id, detail: kind });
}

export function recordDiagnostic(
  code: DiagnosticCode,
  options?: { sessionId?: string | null; detail?: string },
): void {
  const sessionId = options && 'sessionId' in options
    ? options.sessionId ?? null
    : currentAnalysisSessionId;
  if (!sessionId) return;
  let session = sessions.get(sessionId);
  if (!session) {
    session = {
      id: sessionId,
      state: 'submitted',
      startedAt: monotonicDiagnosticNow(),
      requestSent: false,
      cancellationUnconfirmed: false,
      frozenElapsedMs: null,
    };
    sessions.set(sessionId, session);
  }

  let applied = false;
  if (code === 'BEAT_REQUEST_SENT' || code === 'CHORD_REQUEST_SENT') {
    session.requestSent = true;
    if (session.state === 'abandoned') session.cancellationUnconfirmed = true;
    else if (session.state === 'submitted') session.state = 'running';
  } else if (code === 'AUDIO_REJECTED' || code === 'ANALYSIS_FAILED') {
    if (session.state !== 'abandoned' && sessionId === currentAnalysisSessionId) {
      session.state = 'failed';
      freeze(session);
    }
  } else if (code === 'ANALYSIS_COMPLETED') {
    if (session.state !== 'abandoned' && sessionId === currentAnalysisSessionId) {
      session.state = 'returned';
      session.cancellationUnconfirmed = false;
      freeze(session);
      applied = true;
    }
  }

  const next: DiagnosticEvent = {
    id: ++eventSeq,
    code,
    sessionId,
    elapsedMs: sessionElapsed(session),
    detail: sanitizeDiagnosticDetail(options?.detail ?? ''),
    applied,
  };
  events = [...events, next].slice(-BUFFER_LIMIT);
  publish();
}

export function noteAudioRejected(
  sessionId: string | null,
  decision: Extract<DurationEligibility, { eligible: false }>,
  extension?: string | null,
): void {
  const seconds = decision.seconds === null ? '' : `seconds=${decision.seconds.toFixed(1)}`;
  const ext = extension ? `ext=${extension}` : '';
  recordDiagnostic('AUDIO_REJECTED', {
    sessionId,
    detail: [decision.reason, ext, seconds].filter(Boolean).join(' '),
  });
}

export function noteAudioValidated(
  sessionId: string | null,
  seconds: number,
  extension?: string | null,
): void {
  const ext = extension ? `ext=${extension}` : '';
  recordDiagnostic('AUDIO_VALIDATED', {
    sessionId,
    detail: [ext, `seconds=${seconds.toFixed(1)}`].filter(Boolean).join(' '),
  });
}

export function noteAudioRejectedCode(sessionId: string | null, reason: string): void {
  if (!/^[a-z-]{1,32}$/.test(reason)) return;
  recordDiagnostic('AUDIO_REJECTED', { sessionId, detail: reason });
}

export function noteBeatRequestSent(sessionId: string | null, model: string): void {
  const label = diagnosticModelLabel(model);
  recordDiagnostic('BEAT_REQUEST_SENT', { sessionId, detail: label ? `model=${label}` : '' });
}

export function noteBeatResponseReceived(sessionId: string | null, model: string): void {
  const label = diagnosticModelLabel(model);
  recordDiagnostic('BEAT_RESPONSE_RECEIVED', { sessionId, detail: label ? `model=${label}` : '' });
}

export function noteChordRequestSent(sessionId: string | null, model: string): void {
  const label = diagnosticModelLabel(model);
  recordDiagnostic('CHORD_REQUEST_SENT', { sessionId, detail: label ? `model=${label}` : '' });
}

export function noteChordResponseReceived(sessionId: string | null, model: string): void {
  const label = diagnosticModelLabel(model);
  recordDiagnostic('CHORD_RESPONSE_RECEIVED', { sessionId, detail: label ? `model=${label}` : '' });
}

export function noteTransportFailure(
  sessionId: string | null,
  failure: { code: string; reason: string | null },
): void {
  if (failure.reason === 'MODEL_UNAVAILABLE') {
    recordDiagnostic('MODEL_PREFLIGHT_FAILED', { sessionId, detail: 'MODEL_UNAVAILABLE' });
    return;
  }
  if (!SERVICE_CODES.has(failure.code)) return;
  recordDiagnostic('BACKEND_UNAVAILABLE', { sessionId, detail: failure.code });
}

export function noteBackendConnecting(sessionId?: string | null): void {
  const id = sessionId === undefined ? currentAnalysisSessionId : sessionId;
  if (id) {
    recordDiagnostic('BACKEND_CONNECTING', { sessionId: id });
    return;
  }
  const noteId = `note-${++sessionSeq}`;
  sessions.set(noteId, {
    id: noteId,
    state: 'submitted',
    startedAt: monotonicDiagnosticNow(),
    requestSent: false,
    cancellationUnconfirmed: false,
    frozenElapsedMs: 0,
  });
  recordDiagnostic('BACKEND_CONNECTING', { sessionId: noteId });
}

export function noteAnalysisCompleted(sessionId: string | null): void {
  recordDiagnostic('ANALYSIS_COMPLETED', { sessionId });
}

export function noteAnalysisFailed(sessionId: string | null, code?: string | null): void {
  const detail = code && SERVICE_CODES.has(code) ? code : '';
  recordDiagnostic('ANALYSIS_FAILED', { sessionId, detail });
}

export async function observeHistorySave<T extends { state: string; reason?: string }>(
  sessionId: string | null,
  run: () => Promise<T>,
): Promise<T> {
  recordDiagnostic('HISTORY_SAVE_STARTED', { sessionId });
  try {
    const outcome = await run();
    if (outcome.state === 'saved') {
      recordDiagnostic('HISTORY_SAVE_COMPLETED', { sessionId, detail: 'saved' });
    } else if (outcome.state === 'failed') {
      const reason = outcome.reason && /^[a-z-]{1,32}$/.test(outcome.reason) ? outcome.reason : 'failed';
      recordDiagnostic('HISTORY_SAVE_FAILED', { sessionId, detail: reason });
    }
    return outcome;
  } catch (error) {
    recordDiagnostic('HISTORY_SAVE_FAILED', { sessionId, detail: 'failed' });
    throw error;
  }
}

export function formatDiagnosticElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
