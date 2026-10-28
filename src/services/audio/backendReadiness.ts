/**
 * Reads the desktop supervisor's verified status and records it on the
 * existing diagnostics session. A retry acknowledgement is not readiness.
 * Model preflight is not inference, and this module never emits model
 * start or finish events.
 */

import {
  ensureDiagnosticSessionId,
  recordDiagnostic,
  sanitizeDiagnosticDetail,
} from '@/services/audio/analysisDiagnostics';

export const BACKEND_STATUS_PATH = '/api/desktop/backend-status';
export const BACKEND_RETRY_PATH = '/api/desktop/backend-retry';
export const READINESS_ATTEMPT_LIMIT = 3;
export const READINESS_TIMEOUT_MS = 2_000;
export const READINESS_INTERVAL_MS = 400;

const STATUS_CODE = /^[A-Z][A-Z0-9_]{0,39}$/;

export interface PublicBackendModels {
  chordCnnLstm: boolean | null;
  beatTransformer: boolean | null;
  madmom: boolean | null;
}

export interface PublicBackendReadiness {
  verified: boolean;
  phase: 'starting' | 'server-ready' | 'failed' | 'unverified';
  serverReady: boolean;
  modelPreflightReady: boolean;
  inferenceVerified: false;
  code: string;
  reason: string;
  models: PublicBackendModels;
}

export interface BackendReadinessSource {
  phase: string;
  code: string;
  message: string;
  serverReady: boolean;
  modelPreflightReady: boolean;
  models: PublicBackendModels;
}

export interface ReadinessObserveOptions {
  sessionId?: string | null;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  attemptLimit?: number;
  intervalMs?: number;
  signal?: AbortSignal;
}

const EMPTY_MODELS: PublicBackendModels = {
  chordCnnLstm: null,
  beatTransformer: null,
  madmom: null,
};

export function boundedStatusCode(code: unknown): string {
  return typeof code === 'string' && STATUS_CODE.test(code) ? code : 'STATUS_INVALID';
}

export function unverifiedReadiness(code: string, reason = ''): PublicBackendReadiness {
  return {
    verified: false,
    phase: 'unverified',
    serverReady: false,
    modelPreflightReady: false,
    inferenceVerified: false,
    code: boundedStatusCode(code),
    reason: sanitizeDiagnosticDetail(reason),
    models: { ...EMPTY_MODELS },
  };
}

export function toPublicBackendReadiness(status: BackendReadinessSource): PublicBackendReadiness {
  const phase = status.phase === 'server-ready' || status.phase === 'failed' || status.phase === 'starting'
    ? status.phase
    : 'unverified';
  const serverReady = status.serverReady === true;
  return {
    verified: phase !== 'unverified',
    phase,
    serverReady,
    modelPreflightReady: serverReady && status.modelPreflightReady === true,
    inferenceVerified: false,
    code: boundedStatusCode(status.code),
    reason: sanitizeDiagnosticDetail(status.message),
    models: {
      chordCnnLstm: typeof status.models?.chordCnnLstm === 'boolean' ? status.models.chordCnnLstm : null,
      beatTransformer: typeof status.models?.beatTransformer === 'boolean' ? status.models.beatTransformer : null,
      madmom: typeof status.models?.madmom === 'boolean' ? status.models.madmom : null,
    },
  };
}

function modelFlag(record: Record<string, unknown>, key: string): boolean | null {
  return typeof record[key] === 'boolean' ? record[key] as boolean : null;
}

export function parsePublicBackendReadiness(body: unknown): PublicBackendReadiness | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const phase = record.phase === 'server-ready' || record.phase === 'failed' || record.phase === 'starting' || record.phase === 'unverified'
    ? record.phase
    : null;
  if (!phase) return null;
  const models = record.models;
  if (!models || typeof models !== 'object') return null;
  const modelRecord = models as Record<string, unknown>;
  const serverReady = record.serverReady === true;
  return {
    verified: record.verified === true && phase !== 'unverified',
    phase,
    serverReady,
    modelPreflightReady: serverReady && record.modelPreflightReady === true,
    inferenceVerified: false,
    code: boundedStatusCode(record.code),
    reason: sanitizeDiagnosticDetail(typeof record.reason === 'string' ? record.reason : ''),
    models: {
      chordCnnLstm: modelFlag(modelRecord, 'chordCnnLstm'),
      beatTransformer: modelFlag(modelRecord, 'beatTransformer'),
      madmom: modelFlag(modelRecord, 'madmom'),
    },
  };
}

function withReason(code: string, reason: string): string {
  return reason ? `${code} ${reason}` : code;
}

export function observeVerifiedReadiness(sessionId: string, status: PublicBackendReadiness): void {
  if (!status.verified || !status.serverReady) {
    recordDiagnostic('BACKEND_UNAVAILABLE', {
      sessionId,
      detail: withReason(status.code || 'STATUS_UNVERIFIED', status.reason),
    });
    return;
  }
  recordDiagnostic('BACKEND_READY', { sessionId, detail: 'server-ready inference=unverified' });
  const missing = (['chordCnnLstm', 'beatTransformer', 'madmom'] as const)
    .filter((name) => status.models[name] === false);
  if (status.modelPreflightReady) {
    recordDiagnostic('MODEL_PREFLIGHT_READY', { sessionId, detail: 'inference=unverified' });
  }
  if (!status.modelPreflightReady || missing.length > 0) {
    const detail = missing.length > 0 ? `missing=${missing.join(',')}` : status.code;
    recordDiagnostic('MODEL_PREFLIGHT_FAILED', { sessionId, detail: withReason(detail, status.reason) });
  }
}

type ReadOutcome = PublicBackendReadiness | 'invalid' | 'not-desktop';

function combineSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 0) return undefined;
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of active) {
    if (signal.aborted) {
      abort();
      break;
    }
    signal.addEventListener('abort', abort, { once: true });
  }
  return controller.signal;
}

async function readBackendStatusResponse(
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<ReadOutcome> {
  const response = await fetchImpl(BACKEND_STATUS_PATH, {
    method: 'GET',
    cache: 'no-store',
    signal,
  });
  if (response.status === 404) return 'not-desktop';
  if (!response.ok) return 'invalid';
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return 'invalid';
  }
  return parsePublicBackendReadiness(body) ?? 'invalid';
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function pollVerifiedBackendStatus(options: ReadinessObserveOptions = {}): Promise<void> {
  const sessionId = ensureDiagnosticSessionId(options.sessionId);
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? READINESS_TIMEOUT_MS;
  const attemptLimit = options.attemptLimit ?? READINESS_ATTEMPT_LIMIT;
  const intervalMs = options.intervalMs ?? READINESS_INTERVAL_MS;
  const started = now();
  const budget = new AbortController();
  const budgetTimer = setTimeout(() => budget.abort(), Math.max(0, timeoutMs));
  let attempts = 0;
  let lastStarting: PublicBackendReadiness | null = null;

  const finishStartingOrTimeout = () => {
    if (lastStarting) {
      observeVerifiedReadiness(sessionId, lastStarting);
      return;
    }
    recordDiagnostic('BACKEND_UNAVAILABLE', { sessionId, detail: 'TIMEOUT' });
  };

  try {
    while (attempts < attemptLimit) {
      if (options.signal?.aborted) return;
      if (budget.signal.aborted || now() - started >= timeoutMs) {
        finishStartingOrTimeout();
        return;
      }
      attempts += 1;
      const signal = combineSignals([options.signal, budget.signal]);
      let outcome: ReadOutcome;
      try {
        outcome = await readBackendStatusResponse(fetchImpl, signal);
      } catch {
        if (options.signal?.aborted && !budget.signal.aborted) return;
        recordDiagnostic('BACKEND_UNAVAILABLE', { sessionId, detail: 'TIMEOUT' });
        return;
      }
      if (outcome === 'invalid') {
        recordDiagnostic('BACKEND_UNAVAILABLE', { sessionId, detail: 'STATUS_INVALID' });
        return;
      }
      if (outcome === 'not-desktop') {
        recordDiagnostic('BACKEND_UNAVAILABLE', { sessionId, detail: 'NOT_DESKTOP' });
        return;
      }
      const terminal = outcome.serverReady || outcome.phase === 'failed' || outcome.phase === 'unverified' || !outcome.verified;
      if (terminal) {
        observeVerifiedReadiness(sessionId, outcome);
        return;
      }
      lastStarting = outcome;
      if (attempts >= attemptLimit || now() - started + intervalMs >= timeoutMs) {
        observeVerifiedReadiness(sessionId, outcome);
        return;
      }
      await sleep(intervalMs);
    }
    finishStartingOrTimeout();
  } finally {
    clearTimeout(budgetTimer);
  }
}

export async function requestBackendRetryAndObserve(options: ReadinessObserveOptions = {}): Promise<void> {
  const sessionId = ensureDiagnosticSessionId(options.sessionId);
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(BACKEND_RETRY_PATH, {
      method: 'POST',
      cache: 'no-store',
      signal: options.signal,
    });
  } catch {
    if (options.signal?.aborted) return;
    recordDiagnostic('BACKEND_UNAVAILABLE', { sessionId, detail: 'TIMEOUT' });
    return;
  }
  if (!response.ok) {
    recordDiagnostic('BACKEND_UNAVAILABLE', {
      sessionId,
      detail: response.status === 404 ? 'NOT_DESKTOP' : 'RETRY_REJECTED',
    });
    return;
  }
  // The retry file was accepted. That does not mean the server process is ready.
  recordDiagnostic('BACKEND_RETRY_REQUESTED', { sessionId, detail: 'accepted' });
  await pollVerifiedBackendStatus({ ...options, sessionId });
}
