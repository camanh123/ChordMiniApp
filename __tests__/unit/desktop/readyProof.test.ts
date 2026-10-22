/**
 * @jest-environment node
 */
import { computeReadyProof, createDesktopSecret, createReadyNonce, readyProofMatches } from '@/desktop/readyProof';

describe('desktop ready proof', () => {
  it('accepts only the hash of the owned token and the caller nonce', () => {
    const token = createDesktopSecret();
    const nonce = createReadyNonce();
    const proof = computeReadyProof(token, nonce);

    expect(proof).toMatch(/^[0-9a-f]{64}$/);
    expect(readyProofMatches(token, nonce, proof)).toBe(true);
    expect(readyProofMatches(token, nonce, computeReadyProof(token, createReadyNonce()))).toBe(false);
    expect(readyProofMatches(token, nonce, 'forged')).toBe(false);
    expect(readyProofMatches(token, nonce, null)).toBe(false);
    expect(readyProofMatches('', nonce, proof)).toBe(false);
  });
});
