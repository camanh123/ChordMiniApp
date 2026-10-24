/**
 * Fail-closed desktop policy for PYTHON_API_URL.
 *
 * Desktop mode may open a connection only to an explicit http://127.0.0.1
 * origin. localhost is rejected because it can resolve outside that IPv4
 * binding. A rejected URL never reaches fetch. Outside desktop mode the
 * existing authenticated forwarding path is unchanged, including redirects.
 */

import { getPythonApiUrl, getSheetSageApiUrl } from '@/config/serverBackend';

export type DesktopLoopbackDecision =
  | { scope: 'passthrough' }
  | { scope: 'accepted'; origin: string }
  | { scope: 'rejected' };

export type PythonFetchState = 'response' | 'refused' | 'redirect';

export type PythonFetchResult =
  | { state: 'response'; response: Response }
  | { state: 'refused' }
  | { state: 'redirect' };

const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1(?::([1-9][0-9]{0,4}))?\/?$/;

export class DesktopPythonFetchError extends Error {
  readonly code: 'ANALYSIS_SERVICE_NOT_CONFIGURED' | 'ANALYSIS_SERVICE_UNAVAILABLE';

  constructor(code: DesktopPythonFetchError['code']) {
    super(code);
    this.name = 'DesktopPythonFetchError';
    this.code = code;
  }
}

function schemeNormalized(value: string): string {
  const marker = value.indexOf('://');
  if (marker <= 0) {
    return value;
  }
  return `${value.slice(0, marker).toLowerCase()}${value.slice(marker)}`;
}

export function decideDesktopLoopback(
  env: NodeJS.ProcessEnv = process.env,
): DesktopLoopbackDecision {
  if (env.CHORDMINI_DESKTOP_MODE !== '1') {
    return { scope: 'passthrough' };
  }

  const candidate = schemeNormalized((env.PYTHON_API_URL ?? '').trim());
  const match = LOOPBACK_ORIGIN.exec(candidate);
  if (!match) {
    return { scope: 'rejected' };
  }

  const port = match[1] === undefined ? null : Number(match[1]);
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    return { scope: 'rejected' };
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { scope: 'rejected' };
  }

  const origin = port === null ? 'http://127.0.0.1' : `http://127.0.0.1:${port}`;
  if (
    parsed.origin !== origin
    || parsed.protocol !== 'http:'
    || parsed.hostname !== '127.0.0.1'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
    || (parsed.pathname !== '/' && parsed.pathname !== '')
  ) {
    return { scope: 'rejected' };
  }

  return { scope: 'accepted', origin };
}

export function isRedirectResponse(response: { status?: number; type?: string }): boolean {
  if (response.type === 'opaqueredirect') {
    return true;
  }
  return typeof response.status === 'number' && response.status >= 300 && response.status < 400;
}

function resolveAcceptedPath(origin: string, path: string): string | null {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    return null;
  }

  let resolved: URL;
  try {
    resolved = new URL(path, `${origin}/`);
  } catch {
    return null;
  }

  if (
    resolved.origin !== origin
    || resolved.protocol !== 'http:'
    || resolved.hostname !== '127.0.0.1'
    || resolved.username !== ''
    || resolved.password !== ''
  ) {
    return null;
  }

  return resolved.toString();
}

export async function fetchPythonBackend(
  path: string,
  init: RequestInit = {},
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<PythonFetchResult> {
  const decision = decideDesktopLoopback(env);
  if (decision.scope === 'rejected') {
    return { state: 'refused' };
  }

  if (decision.scope === 'passthrough') {
    const response = await fetchImpl(`${getPythonApiUrl()}${path}`, init);
    return { state: 'response', response };
  }

  const target = resolveAcceptedPath(decision.origin, path);
  if (!target) {
    return { state: 'refused' };
  }

  const response = await fetchImpl(target, { ...init, redirect: 'manual' });
  if (isRedirectResponse(response)) {
    return { state: 'redirect' };
  }
  return { state: 'response', response };
}

export async function requirePythonBackendResponse(
  path: string,
  init: RequestInit = {},
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const outcome = await fetchPythonBackend(path, init, env, fetchImpl);
  if (outcome.state === 'response') {
    return outcome.response;
  }
  throw new DesktopPythonFetchError(
    outcome.state === 'redirect'
      ? 'ANALYSIS_SERVICE_UNAVAILABLE'
      : 'ANALYSIS_SERVICE_NOT_CONFIGURED',
  );
}

export type AuxiliaryTarget =
  | { action: 'direct'; url: string }
  | { action: 'loopback'; origin: string }
  | { action: 'skip' };

/**
 * A separately configured SheetSage or SongFormer host stays reachable.
 * A production fallback that is actually PYTHON_API_URL follows the desktop
 * loopback decision and is skipped before any request when that URL is refused.
 */
export function auxiliaryTarget(
  resolvedUrl: string,
  productionPythonFallback: boolean,
  env: NodeJS.ProcessEnv = process.env,
): AuxiliaryTarget {
  const decision = decideDesktopLoopback(env);
  if (decision.scope === 'passthrough' || !productionPythonFallback) {
    return { action: 'direct', url: resolvedUrl };
  }
  if (decision.scope !== 'accepted') {
    return { action: 'skip' };
  }

  try {
    const parsed = new URL(resolvedUrl);
    if (
      parsed.origin === decision.origin
      && parsed.protocol === 'http:'
      && parsed.hostname === '127.0.0.1'
      && parsed.username === ''
      && parsed.password === ''
    ) {
      return { action: 'loopback', origin: decision.origin };
    }
  } catch {
    return { action: 'skip' };
  }

  return { action: 'skip' };
}

export function sheetSageTarget(env: NodeJS.ProcessEnv = process.env): AuxiliaryTarget {
  const explicitSheetSage = Boolean(env.SHEETSAGE_API_URL?.trim());
  return auxiliaryTarget(
    getSheetSageApiUrl(),
    env.NODE_ENV === 'production' && !explicitSheetSage,
    env,
  );
}

export function songFormerProductionFallback(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production' && !env.SONGFORMER_API_URL?.trim();
}
