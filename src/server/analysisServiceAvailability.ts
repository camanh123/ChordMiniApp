/**
 * Desktop availability gate for chord and beat analysis.
 *
 * Desktop mode accepts only an explicit http://127.0.0.1 origin. Every other
 * PYTHON_API_URL, including an unset value and localhost, is refused before
 * a probe. This module never includes the backend URL.
 *
 * When the Electron shell is supervising a local backend, /health is not
 * enough. Owned identity is a fresh HMAC challenge against the session nonce.
 * Legacy public responses are accepted only when that test mode is explicit.
 * A missing or unsigned status file fails closed while supervision is on.
 * Model flags come from detector preflight, not from a completed inference.
 */

import { NextResponse } from 'next/server';
import {
  decideDesktopLoopback,
  DesktopPythonFetchError,
  isRedirectResponse,
} from '@/server/desktopLoopback';
import {
  ANALYSIS_BACKEND_NOT_READY,
  allowLegacyBackend,
  classifyOwnedHealth,
  createIdentityChallenge,
  identityRequestUrl,
  isLegacyChordMiniRoot,
  publicBackendMessage,
  readBackendStatus,
  selectedDetectorReady,
  type BackendStatus,
} from '@/desktop/localBackend';

export const ANALYSIS_SERVICE_UNAVAILABLE = 'ANALYSIS_SERVICE_UNAVAILABLE';
export const ANALYSIS_SERVICE_NOT_CONFIGURED = 'ANALYSIS_SERVICE_NOT_CONFIGURED';

const SERVICE_MESSAGES = {
  [ANALYSIS_SERVICE_NOT_CONFIGURED]: {
    error: 'Required service configuration missing',
    suggestion: 'Chord and beat analysis needs a configured analysis service. This installation does not include one, so no chords or beats were generated.',
  },
  [ANALYSIS_SERVICE_UNAVAILABLE]: {
    error: 'Analysis service unavailable',
    suggestion: 'The analysis service could not be reached. No chords or beats were generated.',
  },
} as const;

export function analysisUnavailableBody(code: keyof typeof SERVICE_MESSAGES) {
  const copy = SERVICE_MESSAGES[code];
  return {
    success: false,
    error: copy.error,
    code,
    suggestion: copy.suggestion,
  };
}

type ProbeResult = 'ok' | 'down' | 'redirect';

function supervisedBody(status: Pick<BackendStatus, 'code' | 'message'>, fallback?: string) {
  const message = publicBackendMessage(fallback || status.message) || 'The local analysis service is not ready.';
  return {
    success: false,
    error: message,
    code: ANALYSIS_BACKEND_NOT_READY,
    suggestion: 'Retry local analysis startup, then choose Analyze again.',
    reason: status.code,
  };
}

async function readHealthIdentity(
  origin: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  challenge: string,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(identityRequestUrl(`${origin}/health`, challenge), {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    });
    if (isRedirectResponse(response) || !response.ok) {
      return null;
    }
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function readRootIdentity(
  origin: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${origin}/`, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    });
    if (isRedirectResponse(response) || !response.ok) {
      return null;
    }
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function probeOrigin(
  origin: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const health = await fetchImpl(`${origin}/health`, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    });
    if (isRedirectResponse(health)) {
      return 'redirect';
    }
    if (health.ok) {
      return 'ok';
    }
    const root = await fetchImpl(`${origin}/`, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    });
    if (isRedirectResponse(root)) {
      return 'redirect';
    }
    return root.ok ? 'ok' : 'down';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns a response when the desktop app must not start analysis.
 * Web and local Next.js development keep the existing proxy behavior.
 * An explicit 127.0.0.1 service that answers /health without a redirect is
 * allowed through so a developer running Flask is not blocked.
 */
export async function analysisServiceGateResponse(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 2000,
): Promise<NextResponse | null> {
  const decision = decideDesktopLoopback(env);
  if (decision.scope === 'passthrough') {
    return null;
  }

  const supervised = env.CHORDMINI_BACKEND_SUPERVISED === '1';
  const status = readBackendStatus(env);
  if (supervised && !status) {
    return NextResponse.json(supervisedBody({
      code: 'STATUS_UNVERIFIED',
      message: 'The supervisor did not produce a verified readiness record. No chords or beats were generated.',
    }), { status: 503 });
  }
  if (status && !status.serverReady) {
    return NextResponse.json(supervisedBody(status), { status: 503 });
  }
  if (status?.serverReady && status.identity !== 'owned' && status.identity !== 'legacy') {
    return NextResponse.json(supervisedBody({
      code: 'PORT_IDENTITY_MISMATCH',
      message: 'The readiness record does not name a verified analysis service. No chords or beats were generated.',
    }), { status: 503 });
  }
  if (status?.identity === 'legacy' && !allowLegacyBackend(env)) {
    return NextResponse.json(supervisedBody({
      code: 'PORT_IDENTITY_MISMATCH',
      message: 'Legacy backend acceptance is not enabled. No chords or beats were generated.',
    }), { status: 503 });
  }
  if (decision.scope === 'rejected') {
    if (status) {
      return NextResponse.json(supervisedBody(status), { status: 503 });
    }
    return NextResponse.json(
      analysisUnavailableBody(ANALYSIS_SERVICE_NOT_CONFIGURED),
      { status: 503 },
    );
  }

  const probe = await probeOrigin(decision.origin, fetchImpl, timeoutMs);
  if (probe !== 'ok') {
    if (status) {
      return NextResponse.json(supervisedBody(
        status,
        'The analysis service is not responding. No chords or beats were generated.',
      ), { status: 503 });
    }
    return NextResponse.json(
      analysisUnavailableBody(ANALYSIS_SERVICE_UNAVAILABLE),
      { status: 503 },
    );
  }

  if (status?.identity === 'owned') {
    const nonce = (env.CHORDMINI_BACKEND_NONCE ?? '').trim();
    const challenge = createIdentityChallenge();
    const body = nonce
      ? await readHealthIdentity(decision.origin, fetchImpl, timeoutMs, challenge)
      : null;
    if (!nonce || classifyOwnedHealth(body, nonce, challenge) !== 'owned') {
      return NextResponse.json(supervisedBody({
        code: 'PORT_IDENTITY_MISMATCH',
        message: 'The analysis port answered, but it is not the ChordMini service this session started. No chords or beats were generated.',
      }), { status: 503 });
    }
  } else if (status?.identity === 'legacy') {
    const root = await readRootIdentity(decision.origin, fetchImpl, timeoutMs);
    if (!isLegacyChordMiniRoot(root)) {
      return NextResponse.json(supervisedBody({
        code: 'PORT_IDENTITY_MISMATCH',
        message: 'The analysis port answered, but it did not match the explicit legacy test contract. A health response is not identity. No chords or beats were generated.',
      }), { status: 503 });
    }
  }

  if (status && !status.modelPreflightReady) {
    return NextResponse.json(supervisedBody(status), { status: 503 });
  }

  return null;
}

export function desktopModelGateResponse(
  env: NodeJS.ProcessEnv,
  kind: 'beat' | 'chord',
  detector: string,
): NextResponse | null {
  if (env.CHORDMINI_DESKTOP_MODE !== '1' || !env.CHORDMINI_BACKEND_STATUS_FILE?.trim()) {
    return null;
  }
  const status = readBackendStatus(env);
  if (!status) {
    if (env.CHORDMINI_BACKEND_SUPERVISED === '1') {
      return NextResponse.json(supervisedBody({
        code: 'STATUS_UNVERIFIED',
        message: 'The supervisor did not produce a verified readiness record. No chords or beats were generated.',
      }), { status: 503 });
    }
    return null;
  }
  if (!status.serverReady || !status.modelPreflightReady) {
    return NextResponse.json(supervisedBody(status), { status: 503 });
  }
  const verdict = selectedDetectorReady(status.models, kind, detector);
  if (verdict === 'ready') {
    return null;
  }
  const message = verdict === 'untracked'
    ? 'The selected detector was not part of startup preflight. No chords or beats were generated.'
    : verdict === 'unknown'
      ? 'Model readiness has not been confirmed for the selected detector. No chords or beats were generated.'
      : 'The selected detector is not available in the local analysis service. No chords or beats were generated.';
  return NextResponse.json(supervisedBody({ code: 'MODEL_UNAVAILABLE', message }), { status: 503 });
}

export function desktopPythonPolicyResponse(error: unknown): NextResponse | null {
  if (!(error instanceof DesktopPythonFetchError)) {
    return null;
  }
  return NextResponse.json(analysisUnavailableBody(error.code), { status: 503 });
}

export function isAnalysisConnectionFailure(error: unknown): boolean {
  const cause = error instanceof Error && 'cause' in error ? String(error.cause) : '';
  const message = `${error instanceof Error ? error.message : String(error)} ${cause}`;
  return /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ECONNRESET|fetch failed|network error/i.test(message);
}

/**
 * Replaces a desktop connection failure with a response that does not include
 * the backend address. Other environments keep their existing error bodies.
 */
export function desktopAnalysisConnectionResponse(
  error: unknown,
  env: NodeJS.ProcessEnv = process.env,
): NextResponse | null {
  if (env.CHORDMINI_DESKTOP_MODE !== '1' || !isAnalysisConnectionFailure(error)) {
    return null;
  }
  return NextResponse.json(
    analysisUnavailableBody(ANALYSIS_SERVICE_UNAVAILABLE),
    { status: 503 },
  );
}
