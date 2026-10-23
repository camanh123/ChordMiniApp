/**
 * MOCKED Firebase user. This file does not contact Firebase Auth.
 */
import { inferenceAuthorizationHeader, readInferenceIdToken } from '@/services/audio/inferenceUserToken';

describe('MOCKED inference user token', () => {
  it('returns the id token from getIdToken without forcing a separate refresh call', async () => {
    const getIdToken = jest.fn(async () => 'aaa.bbb.ccc');
    const token = await readInferenceIdToken(async () => ({
      waitForAuthState: async () => true,
      getCurrentAuthUser: () => ({ getIdToken }),
    }));

    expect(token).toBe('aaa.bbb.ccc');
    expect(getIdToken).toHaveBeenCalledTimes(1);
    expect(getIdToken.mock.calls[0]).toEqual([]);
    await expect(inferenceAuthorizationHeader(async () => ({
      waitForAuthState: async () => true,
      getCurrentAuthUser: () => ({ getIdToken }),
    }))).resolves.toEqual({ Authorization: 'Bearer aaa.bbb.ccc' });
  });

  it('returns nothing when the user is missing, signed out, or the token refresh fails', async () => {
    await expect(readInferenceIdToken(async () => ({
      waitForAuthState: async () => false,
      getCurrentAuthUser: () => null,
    }))).resolves.toBeNull();

    await expect(readInferenceIdToken(async () => ({
      waitForAuthState: async () => true,
      getCurrentAuthUser: () => null,
    }))).resolves.toBeNull();

    await expect(readInferenceIdToken(async () => ({
      waitForAuthState: async () => true,
      getCurrentAuthUser: () => ({
        getIdToken: async () => {
          throw Object.assign(new Error('expired'), { code: 'auth/id-token-expired' });
        },
      }),
    }))).resolves.toBeNull();

    await expect(readInferenceIdToken(async () => {
      throw new Error('firebase unavailable');
    })).resolves.toBeNull();
  });
});
