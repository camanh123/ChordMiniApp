/**
 * Attach the current Firebase user's ID token to an inference request.
 *
 * getIdToken() returns a short-lived ID token and refreshes it when the
 * cached token is expired. This module never reads a refresh token, a service
 * account, or a UID from the page. A missing user is not an anonymous bypass:
 * the desktop gateway refuses to forward without a bearer token.
 */

type TokenUser = {
  getIdToken: (forceRefresh?: boolean) => Promise<string>;
};

type TokenSource = {
  waitForAuthState: (timeoutMs?: number) => Promise<boolean>;
  getCurrentAuthUser: () => TokenUser | null;
};

const AUTH_WAIT_MS = 1500;

function looksLikeIdToken(token: string): boolean {
  return token.length > 0 && token.length <= 8192 && token.split('.').length === 3;
}

export async function readInferenceIdToken(
  load: () => Promise<TokenSource> = () => import('@/config/firebase'),
): Promise<string | null> {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const source = await load();
    await source.waitForAuthState(AUTH_WAIT_MS);
    const user = source.getCurrentAuthUser();
    if (!user) {
      return null;
    }
    const token = await user.getIdToken();
    if (typeof token !== 'string' || !looksLikeIdToken(token)) {
      return null;
    }
    return token;
  } catch {
    return null;
  }
}

export async function inferenceAuthorizationHeader(
  load?: () => Promise<TokenSource>,
): Promise<Record<string, string>> {
  const token = await readInferenceIdToken(load);
  if (!token) {
    return {};
  }
  return { Authorization: `Bearer ${token}` };
}
