/**
 * Hosted staging identity gate for the two primary inference routes.
 *
 * This is not production authentication. When CHORDMINI_HOSTED_STAGING_AUTH
 * is required, a non-desktop Next.js process verifies a Firebase ID token
 * with the Admin SDK and checks the UID against CHORDMINI_STAGING_ALLOWED_UIDS
 * before the existing Flask header may be attached.
 *
 * The UID is taken only from the verified token. Callers cannot supply it in
 * a body field, query string, or custom header. The desktop process never
 * receives the Flask secret and does not forward hosted staging calls.
 *
 * After this gate returns an allowlisted UID, the route applies the
 * single-process quota and duration guard before Flask is called.
 * A caller request id is not an authenticator. An allowlist is not a quota
 * system and is not sufficient for a public production service.
 */

import { getFirebaseAdminAuth } from '@/utils/firebaseAdmin';
import {
  INFERENCE_TOKEN_HEADER,
  inferenceForwardPlan,
  type InferenceForwardPlan,
} from '@/server/inferenceUpstream';

export const STAGING_AUTH_ENV = 'CHORDMINI_HOSTED_STAGING_AUTH';
export const STAGING_ALLOWLIST_ENV = 'CHORDMINI_STAGING_ALLOWED_UIDS';

const MAX_UID_LENGTH = 128;
const MAX_ALLOWLIST_SIZE = 100;

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

const USER_TOKEN_INVALID = {
  success: false as const,
  error: 'User authentication is invalid',
  code: 'USER_TOKEN_INVALID',
};

const USER_TOKEN_EXPIRED = {
  success: false as const,
  error: 'User authentication has expired',
  code: 'USER_TOKEN_EXPIRED',
};

const USER_NOT_ALLOWLISTED = {
  success: false as const,
  error: 'User is not allowed to use staging analysis',
  code: 'USER_NOT_ALLOWLISTED',
};

const STAGING_ALLOWLIST_NOT_CONFIGURED = {
  success: false as const,
  error: 'Staging access is not configured',
  code: 'STAGING_ALLOWLIST_NOT_CONFIGURED',
};

const STAGING_ALLOWLIST_INVALID = {
  success: false as const,
  error: 'Staging access is not configured',
  code: 'STAGING_ALLOWLIST_INVALID',
};

const STAGING_AUTH_NOT_CONFIGURED = {
  success: false as const,
  error: 'Staging authentication is not configured',
  code: 'STAGING_AUTH_NOT_CONFIGURED',
};

const INFERENCE_NOT_AVAILABLE = {
  success: false as const,
  error: 'Protected analysis is not available from this installation',
  code: 'INFERENCE_AUTH_NOT_AVAILABLE',
};

const INFERENCE_NOT_CONFIGURED = {
  success: false as const,
  error: 'Analysis authentication is not configured',
  code: 'INFERENCE_AUTH_NOT_CONFIGURED',
};

export type StagingFailure = {
  ok: false;
  status: 401 | 403 | 503;
  body: { success: false; error: string; code: string };
};

export type HostedInferenceAccess =
  | { ok: true; headers: Record<string, string>; uid: string | null }
  | StagingFailure;

type VerifiedIdentity = { uid: string };

export type IdentityVerifier = (token: string) => Promise<VerifiedIdentity>;

class StagingTokenError extends Error {
  constructor(readonly reason: 'expired' | 'invalid' | 'unavailable') {
    super(reason);
  }
}

function requestedStagingMode(env: NodeJS.ProcessEnv): 'off' | 'required' | 'unknown' {
  const requested = (env[STAGING_AUTH_ENV] || '').trim().toLowerCase();
  if (requested === '' || requested === 'off' || requested === 'local') {
    return 'off';
  }
  if (requested === 'required') {
    return 'required';
  }
  return 'unknown';
}

/**
 * Parse the server allowlist. Empty, missing, and malformed values fail closed.
 * A UID from the request is never consulted.
 */
export function parseStagingAllowlist(
  env: NodeJS.ProcessEnv,
): { ok: true; uids: Set<string> } | { ok: false; body: StagingFailure['body'] } {
  const raw = env[STAGING_ALLOWLIST_ENV];
  if (raw == null || raw.trim() === '') {
    return { ok: false, body: STAGING_ALLOWLIST_NOT_CONFIGURED };
  }

  const parts = raw.split(',');
  if (parts.length > MAX_ALLOWLIST_SIZE) {
    return { ok: false, body: STAGING_ALLOWLIST_INVALID };
  }

  const uids = new Set<string>();
  for (const part of parts) {
    const uid = part.trim();
    if (!uid || uid.length > MAX_UID_LENGTH || /\s/.test(uid)) {
      return { ok: false, body: STAGING_ALLOWLIST_INVALID };
    }
    uids.add(uid);
  }

  if (uids.size === 0) {
    return { ok: false, body: STAGING_ALLOWLIST_NOT_CONFIGURED };
  }
  return { ok: true, uids };
}

function adminCredentialsLookUsable(env: NodeJS.ProcessEnv): boolean {
  const raw = env.FIREBASE_SERVICE_ACCOUNT_KEY?.trim();
  if (raw) {
    if (raw.length > 20000) {
      return false;
    }
    try {
      const parsed = JSON.parse(raw) as {
        project_id?: unknown;
        private_key?: unknown;
        client_email?: unknown;
      };
      return typeof parsed.project_id === 'string' && parsed.project_id.trim() !== ''
        && typeof parsed.private_key === 'string' && parsed.private_key.trim() !== ''
        && typeof parsed.client_email === 'string' && parsed.client_email.trim() !== '';
    } catch {
      return false;
    }
  }
  return Boolean(env.GOOGLE_APPLICATION_CREDENTIALS?.trim());
}

function readBearerToken(authorization: string | null): { ok: true; token: string } | { ok: false } {
  if (authorization == null || authorization.trim() === '') {
    return { ok: false };
  }
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
  if (!match) {
    return { ok: false };
  }
  const token = match[1];
  if (token.split('.').length !== 3) {
    return { ok: false };
  }
  return { ok: true, token };
}

function firebaseErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') {
      return code;
    }
  }
  return '';
}

/**
 * Verify a Firebase ID token with the Admin SDK.
 *
 * `verifyIdToken(token, true)` checks the signature, audience, issuer,
 * expiration, and revocation. This function does not decode an unverified JWT
 * into an identity. Tests inject a stub at the route boundary; a stub is not
 * production Firebase authentication.
 */
export async function verifyFirebaseIdToken(token: string): Promise<VerifiedIdentity> {
  try {
    const auth = await getFirebaseAdminAuth();
    const decoded = await auth.verifyIdToken(token, true);
    if (!decoded?.uid || typeof decoded.uid !== 'string' || decoded.uid.trim() === '') {
      throw new StagingTokenError('invalid');
    }
    return { uid: decoded.uid };
  } catch (error) {
    if (error instanceof StagingTokenError) {
      throw error;
    }
    const code = firebaseErrorCode(error);
    if (code === 'auth/id-token-expired') {
      throw new StagingTokenError('expired');
    }
    if (code.startsWith('app/') || code === 'auth/invalid-credential') {
      throw new StagingTokenError('unavailable');
    }
    throw new StagingTokenError('invalid');
  }
}

function failure(status: StagingFailure['status'], body: StagingFailure['body']): StagingFailure {
  return { ok: false, status, body };
}

/**
 * Authorize a hosted staging caller, then apply the BACKEND-04A Flask plan.
 * Staging mode that is off preserves the previous forwarder.
 * Required staging never calls Flask without both an allowlisted UID and the
 * server-only inference header.
 */
export async function gateHostedStagingThenForward(
  authorization: string | null,
  env: NodeJS.ProcessEnv = process.env,
  verify: IdentityVerifier = verifyFirebaseIdToken,
): Promise<HostedInferenceAccess> {
  const mode = requestedStagingMode(env);
  if (mode === 'off') {
    const plan = inferenceForwardPlan(env);
    if (!plan.ok) {
      return plan;
    }
    return { ok: true, headers: plan.headers, uid: null };
  }
  if (mode === 'unknown') {
    return failure(503, STAGING_AUTH_NOT_CONFIGURED);
  }

  if (env.CHORDMINI_DESKTOP_MODE === '1') {
    return failure(503, INFERENCE_NOT_AVAILABLE);
  }

  const allowlist = parseStagingAllowlist(env);
  if (!allowlist.ok) {
    return failure(503, allowlist.body);
  }

  if (!adminCredentialsLookUsable(env)) {
    return failure(503, STAGING_AUTH_NOT_CONFIGURED);
  }

  if (authorization == null || authorization.trim() === '') {
    return failure(401, USER_AUTH_REQUIRED);
  }
  const bearer = readBearerToken(authorization);
  if (!bearer.ok) {
    return failure(401, USER_AUTH_MALFORMED);
  }

  let identity: VerifiedIdentity;
  try {
    identity = await verify(bearer.token);
  } catch (error) {
    if (error instanceof StagingTokenError && error.reason === 'unavailable') {
      return failure(503, STAGING_AUTH_NOT_CONFIGURED);
    }
    const code = error instanceof StagingTokenError ? '' : firebaseErrorCode(error);
    if (
      (error instanceof StagingTokenError && error.reason === 'expired')
      || code === 'auth/id-token-expired'
    ) {
      return failure(401, USER_TOKEN_EXPIRED);
    }
    if (code.startsWith('app/') || code === 'auth/invalid-credential') {
      return failure(503, STAGING_AUTH_NOT_CONFIGURED);
    }
    return failure(401, USER_TOKEN_INVALID);
  }

  if (!allowlist.uids.has(identity.uid)) {
    return failure(403, USER_NOT_ALLOWLISTED);
  }

  // Quota and duration run after this returns, using uid, and before Flask.
  // Repeated request IDs are not an authenticator and are not a replay cache.
  const forward: InferenceForwardPlan = inferenceForwardPlan(env);
  if (!forward.ok) {
    return forward;
  }
  if (!forward.headers[INFERENCE_TOKEN_HEADER]) {
    return failure(503, INFERENCE_NOT_CONFIGURED);
  }
  return { ok: true, headers: forward.headers, uid: identity.uid };
}
