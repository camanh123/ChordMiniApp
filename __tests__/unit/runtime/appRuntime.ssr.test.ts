/**
 * @jest-environment node
 */

import { canUseAudioContext, resumeSharedAudioContext } from '@/runtime/audioSession';
import { readSelectedAudioFile } from '@/runtime/audioFileInput';
import {
  getHydrationSafeRuntime,
  resolveRuntimeAfterHydration,
} from '@/runtime/appRuntime';

describe('app runtime during SSR', () => {
  const originalRuntime = process.env.NEXT_PUBLIC_APP_RUNTIME;

  afterAll(() => {
    if (originalRuntime === undefined) {
      delete process.env.NEXT_PUBLIC_APP_RUNTIME;
    } else {
      process.env.NEXT_PUBLIC_APP_RUNTIME = originalRuntime;
    }
  });

  it('resolves without window or document', () => {
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');

    delete process.env.NEXT_PUBLIC_APP_RUNTIME;
    expect(getHydrationSafeRuntime()).toBe('web');
    expect(resolveRuntimeAfterHydration()).toEqual({
      runtime: 'web',
      source: 'fallback',
      displayMode: 'unknown',
    });
  });

  it('does not touch audio or file APIs on the server', async () => {
    expect(canUseAudioContext()).toBe(false);
    await expect(resumeSharedAudioContext()).resolves.toEqual({
      available: false,
      reason: 'server',
    });
    expect(readSelectedAudioFile(null)).toBeNull();
  });
});
