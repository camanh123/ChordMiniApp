/**
 * Desktop availability gate for chord and beat analysis.
 *
 * The packaged app serves the UI from loopback and does not start Flask.
 * A missing or loopback PYTHON_API_URL is the development default, not a
 * deployed analysis service. This module returns a privacy-safe response
 * before the long model request, and it never includes the backend URL.
 */

import { NextResponse } from 'next/server';
import { classifyPythonBackend } from '@/runtime/backendConnectivity';

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

function configuredOrigin(env: NodeJS.ProcessEnv): string | null {
  const raw = env.PYTHON_API_URL?.trim() || 'http://localhost:5001';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

async function probeOrigin(
  origin: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const health = await fetchImpl(`${origin}/health`, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
    });
    if (health.ok) {
      return true;
    }
    const root = await fetchImpl(`${origin}/`, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
    });
    return root.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns a response when the desktop app must not start analysis.
 * Web and local Next.js development keep the existing proxy behavior.
 * A loopback service that actually answers /health is allowed through so a
 * developer running Flask is not blocked.
 */
export async function analysisServiceGateResponse(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 2000,
): Promise<NextResponse | null> {
  if (env.CHORDMINI_DESKTOP_MODE !== '1') {
    return null;
  }

  const classification = classifyPythonBackend(env);
  if (classification.deploymentClass === 'remote') {
    return null;
  }
  if (classification.deploymentClass === 'invalid') {
    return NextResponse.json(
      analysisUnavailableBody(ANALYSIS_SERVICE_NOT_CONFIGURED),
      { status: 503 },
    );
  }

  const origin = configuredOrigin(env);
  if (!origin) {
    return NextResponse.json(
      analysisUnavailableBody(ANALYSIS_SERVICE_NOT_CONFIGURED),
      { status: 503 },
    );
  }

  const reachable = await probeOrigin(origin, fetchImpl, timeoutMs);
  if (reachable) {
    return null;
  }

  const code = classification.explicitlyConfigured
    ? ANALYSIS_SERVICE_UNAVAILABLE
    : ANALYSIS_SERVICE_NOT_CONFIGURED;
  return NextResponse.json(analysisUnavailableBody(code), { status: 503 });
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
