/**
 * Desktop bridge to a trusted hosted Next.js gateway.
 *
 * The Electron-owned Next.js process may forward the caller's Firebase ID
 * token and approved multipart fields. It never reads or attaches
 * CHORDMINI_INFERENCE_SECRET. The hosted gateway, not Windows, verifies the
 * token and allowlist before calling Flask.
 *
 * Forwarding is off unless CHORDMINI_HOSTED_GATEWAY_URL is set. An unset URL
 * leaves the existing desktop missing-service behavior in place.
 */

import { NextResponse } from 'next/server';
import { analysisUnavailableBody } from '@/server/analysisServiceAvailability';

export const HOSTED_GATEWAY_URL_ENV = 'CHORDMINI_HOSTED_GATEWAY_URL';
export const HOSTED_GATEWAY_TEST_LOOPBACK_ENV = 'CHORDMINI_HOSTED_GATEWAY_TEST_LOOPBACK';

const GATEWAY_TIMEOUT_MS = 800_000;
const MAX_RESPONSE_CHARS = 2_000_000;
const MAX_FIELD_LENGTH = 64;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const BEAT_FIELDS = new Set(['file', 'detector', 'force']);
const CHORD_FIELDS = new Set(['file', 'detector', 'model', 'chord_dict']);

const USER_AUTH_REQUIRED = {
  success: false as const,
  error: 'User authentication is required',
  code: 'USER_AUTH_REQUIRED',
};

const USER_AUTH_MALFORMED = {
  success: false as const,
  error: 'User authentication is malformed',
  code: 'USER_AUTH_MALFORMED',
};

const GATEWAY_NOT_CONFIGURED = {
  success: false as const,
  error: 'Hosted analysis gateway is not configured',
  code: 'HOSTED_GATEWAY_NOT_CONFIGURED',
};

const GATEWAY_REDIRECT_REJECTED = {
  success: false as const,
  error: 'Hosted analysis gateway rejected the connection',
  code: 'HOSTED_GATEWAY_REDIRECT_REJECTED',
};

const GATEWAY_TIMEOUT = {
  success: false as const,
  error: 'Hosted analysis gateway timed out',
  code: 'HOSTED_GATEWAY_TIMEOUT',
};

const REQUEST_CANCELLED = {
  success: false as const,
  error: 'Analysis request was cancelled',
  code: 'ANALYSIS_REQUEST_CANCELLED',
};

export type GatewayRouteName = 'beats' | 'chords';

export type GatewayInbound = {
  headers?: { get(name: string): string | null };
  formData: () => Promise<FormData>;
  signal?: AbortSignal;
};

type GatewayPlan =
  | { state: 'off' }
  | { state: 'invalid' }
  | { state: 'ready'; origin: string };

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status });
}

function effectiveFlaskOrigin(env: NodeJS.ProcessEnv): string | null {
  const raw = env.PYTHON_API_URL?.trim() || 'http://localhost:5001';
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/**
 * Resolve the trusted gateway origin. The caller cannot choose this URL.
 * HTTPS is required. Loopback HTTP is accepted only for Jest.
 */
export function hostedGatewayOrigin(env: NodeJS.ProcessEnv = process.env): GatewayPlan {
  if (env.CHORDMINI_DESKTOP_MODE !== '1') {
    return { state: 'off' };
  }
  const raw = env[HOSTED_GATEWAY_URL_ENV]?.trim() ?? '';
  if (!raw) {
    return { state: 'off' };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { state: 'invalid' };
  }

  if (url.username || url.password || url.search || url.hash) {
    return { state: 'invalid' };
  }
  if (url.pathname !== '' && url.pathname !== '/') {
    return { state: 'invalid' };
  }

  const host = url.hostname.toLowerCase();
  if (!host) {
    return { state: 'invalid' };
  }

  const loopbackTest = env[HOSTED_GATEWAY_TEST_LOOPBACK_ENV] === '1'
    && env.NODE_ENV === 'test'
    && LOOPBACK_HOSTS.has(host);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopbackTest)) {
    return { state: 'invalid' };
  }

  const origin = url.origin;
  if (origin === effectiveFlaskOrigin(env)) {
    return { state: 'invalid' };
  }
  return { state: 'ready', origin };
}

function readBearer(authorization: string | null): 'missing' | 'malformed' | { token: string } {
  if (authorization == null || authorization.trim() === '') {
    return 'missing';
  }
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
  if (!match) {
    return 'malformed';
  }
  const token = match[1];
  if (token.length > 8192 || token.split('.').length !== 3) {
    return 'malformed';
  }
  return { token };
}

function approvedForm(
  source: FormData,
  route: GatewayRouteName,
): FormData | { error: 'file' } {
  const allowed = route === 'beats' ? BEAT_FIELDS : CHORD_FIELDS;
  const next = new FormData();
  const file = source.get('file');
  if (!(file instanceof Blob) || file.size <= 0) {
    return { error: 'file' };
  }
  const rawName = file instanceof File ? file.name : 'audio';
  const safeName = rawName.replace(/[^\w.\- ]+/g, '').slice(0, 120) || 'audio';
  next.append('file', file, safeName);

  for (const [key, value] of source.entries()) {
    if (key === 'file' || !allowed.has(key)) {
      continue;
    }
    if (typeof value !== 'string') {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_FIELD_LENGTH || /[\r\n]/.test(trimmed)) {
      continue;
    }
    if (!next.has(key)) {
      next.append(key, trimmed);
    }
  }
  return next;
}

function scrubText(text: string, secrets: readonly string[]): string {
  let output = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 8) {
      output = output.split(secret).join('[redacted]');
    }
  }
  return output;
}

function combineSignals(
  incoming: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void; timedOut: () => boolean; cancelled: () => boolean } {
  const controller = new AbortController();
  let didTimeout = false;
  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  if (incoming) {
    if (incoming.aborted) {
      controller.abort();
    } else {
      incoming.addEventListener('abort', onAbort, { once: true });
    }
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      incoming?.removeEventListener('abort', onAbort);
    },
    timedOut: () => didTimeout && !incoming?.aborted,
    cancelled: () => Boolean(incoming?.aborted),
  };
}

function isRedirect(response: Response): boolean {
  return response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400);
}

/**
 * Forward a desktop inference request, or return null when forwarding is off.
 * Null preserves the BACKEND-04A/04C path, including missing-backend errors.
 */
export async function desktopHostedGatewayResponse(
  request: GatewayInbound,
  route: GatewayRouteName,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = GATEWAY_TIMEOUT_MS,
): Promise<NextResponse | null> {
  const plan = hostedGatewayOrigin(env);
  if (plan.state === 'off') {
    return null;
  }
  if (plan.state === 'invalid') {
    return json(GATEWAY_NOT_CONFIGURED, 503);
  }

  const authorization = request.headers?.get('authorization') ?? null;
  const bearer = readBearer(authorization);
  if (bearer === 'missing') {
    return json(USER_AUTH_REQUIRED, 401);
  }
  if (bearer === 'malformed') {
    return json(USER_AUTH_MALFORMED, 401);
  }

  if (request.signal?.aborted) {
    return json(REQUEST_CANCELLED, 503);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'No audio file provided' }, 400);
  }
  const approved = approvedForm(form, route);
  if ('error' in approved) {
    return json({ error: 'No audio file provided' }, 400);
  }

  const path = route === 'beats' ? '/api/detect-beats' : '/api/recognize-chords';
  const target = `${plan.origin}${path}`;
  const linked = combineSignals(request.signal, timeoutMs);
  const secret = env.CHORDMINI_INFERENCE_SECRET?.trim() ?? '';
  const rawUrl = env[HOSTED_GATEWAY_URL_ENV]?.trim() ?? '';
  try {
    const response = await fetchImpl(target, {
      method: 'POST',
      body: approved,
      headers: { Authorization: `Bearer ${bearer.token}` },
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
      signal: linked.signal,
    });
    if (isRedirect(response)) {
      return json(GATEWAY_REDIRECT_REJECTED, 502);
    }

    const text = await response.text();
    if (text.length > MAX_RESPONSE_CHARS) {
      return json(analysisUnavailableBody('ANALYSIS_SERVICE_UNAVAILABLE'), 503);
    }
    const cleaned = scrubText(text, [plan.origin, rawUrl, bearer.token, secret]);
    try {
      return json(JSON.parse(cleaned), response.status);
    } catch {
      return json(analysisUnavailableBody('ANALYSIS_SERVICE_UNAVAILABLE'), 503);
    }
  } catch {
    if (linked.cancelled()) {
      return json(REQUEST_CANCELLED, 503);
    }
    if (linked.timedOut()) {
      return json(GATEWAY_TIMEOUT, 504);
    }
    return json(analysisUnavailableBody('ANALYSIS_SERVICE_UNAVAILABLE'), 503);
  } finally {
    linked.cleanup();
  }
}
