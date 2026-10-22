import { createHash, randomBytes, timingSafeEqual } from 'crypto';

/** Nonce the Electron main process sends. The renderer never sees it. */
export function createReadyNonce(): string {
  return randomBytes(16).toString('hex');
}

export function createDesktopSecret(): string {
  return randomBytes(32).toString('hex');
}

export function computeReadyProof(token: string, nonce: string): string {
  return createHash('sha256').update(`${token}:${nonce}`).digest('hex');
}

export function readyProofMatches(
  token: string,
  nonce: string,
  provided: string | null | undefined,
): boolean {
  if (!token || !nonce || !provided) {
    return false;
  }

  const expected = Buffer.from(computeReadyProof(token, nonce));
  const actual = Buffer.from(provided);
  if (expected.length !== actual.length) {
    return false;
  }

  return timingSafeEqual(expected, actual);
}
