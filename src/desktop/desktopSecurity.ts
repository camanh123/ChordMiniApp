import { timingSafeEqual } from 'crypto';

export const DESKTOP_COOKIE_NAME = 'chordmini_desktop';
export const DESKTOP_LOOPBACK_HOST = '127.0.0.1';
export const DESKTOP_READY_PATH = '/api/desktop/ready';

export interface DesktopRequestInput {
  desktopMode: boolean;
  method: string;
  hostHeader: string | null;
  origin: string | null;
  secFetchSite: string | null;
  secFetchDest: string | null;
  pathname: string;
  cookieToken: string | null;
  expectedCookie: string | null;
}

export type DesktopDecision =
  | { action: 'bypass' }
  | { action: 'allow' }
  | { action: 'allow-document' }
  | { action: 'deny'; status: 403; reason: string };

function hostnameFromHostHeader(hostHeader: string | null): string | null {
  if (!hostHeader) {
    return null;
  }

  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return null;
  }
}

function requestOrigin(hostHeader: string | null): string | null {
  if (!hostHeader) {
    return null;
  }

  try {
    return new URL(`http://${hostHeader}`).origin;
  } catch {
    return null;
  }
}

function tokensMatch(provided: string | null, expected: string | null): boolean {
  if (!provided || !expected) {
    return false;
  }

  const actual = Buffer.from(provided);
  const wanted = Buffer.from(expected);
  if (actual.length !== wanted.length) {
    return false;
  }

  return timingSafeEqual(actual, wanted);
}

/**
 * Desktop-only request gate. Production web traffic leaves this as a bypass.
 * A browser on another origin cannot call the loopback API. The readiness
 * probe is allowed without the session cookie because the Electron main
 * process authenticates it with a separate proof header.
 */
export function decideDesktopRequest(input: DesktopRequestInput): DesktopDecision {
  if (!input.desktopMode) {
    return { action: 'bypass' };
  }

  if (hostnameFromHostHeader(input.hostHeader) !== DESKTOP_LOOPBACK_HOST) {
    return { action: 'deny', status: 403, reason: 'non-loopback-host' };
  }

  // IP origins are site-keyed by port. Another loopback port is cross-site.
  // same-site is denied as well so a lax browser cannot reach the API.
  if (input.secFetchSite && input.secFetchSite !== 'same-origin' && input.secFetchSite !== 'none') {
    return { action: 'deny', status: 403, reason: 'cross-site' };
  }

  if (input.origin) {
    let provided: string;
    try {
      provided = new URL(input.origin).origin;
    } catch {
      return { action: 'deny', status: 403, reason: 'bad-origin' };
    }
    const expected = requestOrigin(input.hostHeader);
    if (!expected || provided !== expected) {
      return { action: 'deny', status: 403, reason: 'foreign-origin' };
    }
  }

  if (input.pathname === DESKTOP_READY_PATH) {
    return { action: 'allow' };
  }

  const isDocument = input.method === 'GET' && input.secFetchDest === 'document';
  if (isDocument) {
    return { action: 'allow-document' };
  }

  if (!tokensMatch(input.cookieToken, input.expectedCookie)) {
    return { action: 'deny', status: 403, reason: 'missing-desktop-cookie' };
  }

  return { action: 'allow' };
}
