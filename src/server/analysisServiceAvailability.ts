/**
 * Desktop availability gate for chord and beat analysis.
 *
 * The packaged app serves the UI from loopback and does not start Flask.
 * Desktop mode accepts only an explicit http://127.0.0.1 origin. Every other
 * PYTHON_API_URL, including an unset value and localhost, is refused before
 * a probe. This module never includes the backend URL.
 */

import { NextResponse } from 'next/server';
import {
  decideDesktopLoopback,
  DesktopPythonFetchError,
  isRedirectResponse,
} from '@/server/desktopLoopback';

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
  if (decision.scope === 'rejected') {
    return NextResponse.json(
      analysisUnavailableBody(ANALYSIS_SERVICE_NOT_CONFIGURED),
      { status: 503 },
    );
  }

  const probe = await probeOrigin(decision.origin, fetchImpl, timeoutMs);
  if (probe === 'ok') {
    return null;
  }
  return NextResponse.json(
    analysisUnavailableBody(ANALYSIS_SERVICE_UNAVAILABLE),
    { status: 503 },
  );
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
