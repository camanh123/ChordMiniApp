/**
 * Server-only forwarder for the protected Flask inference routes.
 *
 * The token is read from CHORDMINI_INFERENCE_SECRET in this process.
 * It is attached only when this Next.js server is explicitly configured
 * for the protected integration and is not the Electron desktop process.
 * Callers cannot supply the token through a header, a form field, or a URL.
 */

export const INFERENCE_TOKEN_HEADER = 'X-ChordMini-Inference-Token';

const MIN_SECRET_LENGTH = 32;

const WEAK_SECRETS = new Set([
  'dev-secret-key-change-in-production',
  'replace_with_random_secret',
  'changeme',
  'password',
  'secret',
]);

const UNTRUSTED_FORM_KEYS = new Set([
  'x-chordmini-inference-token',
  'inference_token',
  'inference-token',
  'token',
  'secret',
  'authorization',
  'api_key',
  'apikey',
  'access_token',
  'password',
  'credential',
  'credentials',
  'audio_path',
  'audiourl',
  'audio_url',
  'audiopath',
  'firebase_url',
  'file_path',
  'filepath',
]);

const NOT_CONFIGURED = {
  success: false as const,
  error: 'Analysis authentication is not configured',
  code: 'INFERENCE_AUTH_NOT_CONFIGURED',
};

const NOT_AVAILABLE = {
  success: false as const,
  error: 'Protected analysis is not available from this installation',
  code: 'INFERENCE_AUTH_NOT_AVAILABLE',
};

const AUTH_FAILED = {
  success: false as const,
  error: 'Analysis authentication failed',
  code: 'INFERENCE_AUTH_FAILED',
};

export type InferenceForwardPlan =
  | { ok: true; headers: Record<string, string> }
  | {
      ok: false;
      status: 503;
      body: { success: false; error: string; code: string };
    };

function requestedMode(env: NodeJS.ProcessEnv): string {
  return (env.CHORDMINI_INFERENCE_AUTH || '').trim().toLowerCase();
}

/**
 * Return the server secret when it meets the same minimum bar as Flask.
 * A missing, short, placeholder, or SECRET_KEY-equal value is not usable.
 */
export function configuredInferenceSecret(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env.CHORDMINI_INFERENCE_SECRET;
  if (raw == null) {
    return null;
  }
  const value = raw.trim();
  if (value.length < MIN_SECRET_LENGTH) {
    return null;
  }
  if (WEAK_SECRETS.has(value.toLowerCase())) {
    return null;
  }
  const flaskSecret = env.SECRET_KEY?.trim();
  if (flaskSecret && value === flaskSecret) {
    return null;
  }
  return value;
}

/**
 * Decide whether this server may call protected Flask inference.
 *
 * `local` and an unset mode keep the existing proxy and send no token.
 * `required` and any unknown mode fail closed unless a valid server secret
 * exists. The Electron desktop process never receives or attaches a token.
 */
export function inferenceForwardPlan(
  env: NodeJS.ProcessEnv = process.env,
): InferenceForwardPlan {
  const mode = requestedMode(env);
  const desktop = env.CHORDMINI_DESKTOP_MODE === '1';
  const protectedIntegration = mode !== '' && mode !== 'local';

  if (!protectedIntegration) {
    return { ok: true, headers: {} };
  }

  if (desktop) {
    return { ok: false, status: 503, body: NOT_AVAILABLE };
  }

  const secret = configuredInferenceSecret(env);
  if (!secret) {
    return { ok: false, status: 503, body: NOT_CONFIGURED };
  }

  return {
    ok: true,
    headers: { [INFERENCE_TOKEN_HEADER]: secret },
  };
}

export function stripUntrustedInferenceFields(formData: FormData): FormData {
  const doomed: string[] = [];
  for (const key of formData.keys()) {
    if (UNTRUSTED_FORM_KEYS.has(key.toLowerCase())) {
      doomed.push(key);
    }
  }
  for (const key of doomed) {
    formData.delete(key);
  }
  return formData;
}

export function formDataForDetectorRetry(source: FormData, detector: string): FormData {
  const retry = new FormData();
  for (const [key, value] of source.entries()) {
    if (key === 'detector' || UNTRUSTED_FORM_KEYS.has(key.toLowerCase())) {
      continue;
    }
    if (typeof value === 'string') {
      retry.append(key, value);
    } else {
      retry.append(key, value, value.name);
    }
  }
  retry.append('detector', detector);
  return retry;
}

/**
 * Map a Flask authentication rejection to a fixed body.
 * The upstream text is never copied into the result.
 */
export function upstreamAuthFailure(
  status: number,
  bodyText: string,
): { status: number; body: { success: false; error: string; code: string } } | null {
  if (status === 401) {
    return { status: 401, body: AUTH_FAILED };
  }

  let code = '';
  try {
    const parsed = JSON.parse(bodyText.slice(0, 4096)) as { code?: unknown };
    if (typeof parsed?.code === 'string') {
      code = parsed.code;
    }
  } catch {
    code = '';
  }

  if (
    status === 503
    && (code === 'AUTH_NOT_CONFIGURED' || code === 'AUTH_REQUIRED' || code === 'AUTH_FAILED')
  ) {
    return { status: 503, body: NOT_CONFIGURED };
  }

  return null;
}

export function redactInferenceSecret(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = env.CHORDMINI_INFERENCE_SECRET;
  if (!raw) {
    return text;
  }
  const value = raw.trim();
  if (!value) {
    return text;
  }
  return text.split(value).join('[redacted]');
}

export function scrubInferencePayload<T>(payload: T, env: NodeJS.ProcessEnv = process.env): T {
  const raw = env.CHORDMINI_INFERENCE_SECRET?.trim();
  if (!raw) {
    return payload;
  }
  const encoded = JSON.stringify(payload);
  if (!encoded || !encoded.includes(raw)) {
    return payload;
  }
  return JSON.parse(encoded.split(raw).join('[redacted]')) as T;
}
