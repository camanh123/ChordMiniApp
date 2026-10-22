/**
 * @jest-environment jsdom
 */

import { render } from '@testing-library/react';
import { renderToString } from 'react-dom/server.node';
import { useAppRuntime } from '@/runtime/useAppRuntime';
import {
  getHydrationSafeRuntime,
  parseAppRuntime,
  resolveRuntimeAfterHydration,
  type RuntimeHost,
} from '@/runtime/appRuntime';
import { readSelectedAudioFile, AUDIO_FILE_ACCEPT } from '@/runtime/audioFileInput';
import { canUseAudioContext, resumeSharedAudioContext } from '@/runtime/audioSession';
import { getLoopbackServerPlan, PHASE_2_WINDOWS_CONTRACT, PHASE_4_IPAD_PWA_CONTRACT } from '@/runtime/packagingContract';

function host(partial: RuntimeHost): RuntimeHost {
  return partial;
}

function Probe({ onRender }: { onRender: (hydrated: boolean, runtime: string) => void }) {
  const state = useAppRuntime();
  onRender(state.hydrated, state.runtime);
  return null;
}

describe('app runtime selection', () => {
  const originalRuntime = process.env.NEXT_PUBLIC_APP_RUNTIME;

  afterEach(() => {
    if (originalRuntime === undefined) {
      delete process.env.NEXT_PUBLIC_APP_RUNTIME;
    } else {
      process.env.NEXT_PUBLIC_APP_RUNTIME = originalRuntime;
    }
  });

  it('falls back to web for missing and unknown configuration', () => {
    delete process.env.NEXT_PUBLIC_APP_RUNTIME;
    expect(parseAppRuntime(undefined)).toBeNull();
    expect(parseAppRuntime('desktop')).toBeNull();
    expect(getHydrationSafeRuntime()).toBe('web');
    expect(resolveRuntimeAfterHydration(null).runtime).toBe('web');
  });

  it('pins electron and pwa before hydration', () => {
    process.env.NEXT_PUBLIC_APP_RUNTIME = ' electron ';
    expect(getHydrationSafeRuntime()).toBe('electron');

    process.env.NEXT_PUBLIC_APP_RUNTIME = 'pwa';
    expect(getHydrationSafeRuntime()).toBe('pwa');
    expect(resolveRuntimeAfterHydration(host({
      matchMedia: () => ({ matches: false }),
    })).source).toBe('configured');
  });

  it('detects an installed PWA only from a client host', () => {
    delete process.env.NEXT_PUBLIC_APP_RUNTIME;
    const standalone = host({
      matchMedia: (query: string) => ({ matches: query === '(display-mode: standalone)' }),
    });

    expect(getHydrationSafeRuntime()).toBe('web');
    expect(resolveRuntimeAfterHydration(standalone)).toEqual({
      runtime: 'pwa',
      source: 'display-mode',
      displayMode: 'standalone',
    });
  });

  it('detects legacy iOS standalone and an Electron user agent after hydration', () => {
    delete process.env.NEXT_PUBLIC_APP_RUNTIME;

    expect(resolveRuntimeAfterHydration(host({
      navigator: { standalone: true },
    })).runtime).toBe('pwa');

    expect(resolveRuntimeAfterHydration(host({
      navigator: { userAgent: 'Mozilla/5.0 Electron/30.0' },
      matchMedia: () => ({ matches: false }),
    }))).toMatchObject({ runtime: 'electron', source: 'electron-client' });
  });

  it('keeps server HTML on the safe runtime and resolves an installed PWA in the browser', () => {
    delete process.env.NEXT_PUBLIC_APP_RUNTIME;
    window.matchMedia = jest.fn().mockImplementation((query: string) => ({
      matches: query === '(display-mode: standalone)',
      media: query,
      onchange: null,
      addListener: jest.fn(),
      removeListener: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      dispatchEvent: jest.fn(),
    }));

    const serverSeen: Array<{ hydrated: boolean; runtime: string }> = [];
    renderToString(
      <Probe onRender={(hydrated, runtime) => serverSeen.push({ hydrated, runtime })} />,
    );
    expect(serverSeen[0]).toEqual({ hydrated: false, runtime: 'web' });

    const clientSeen: Array<{ hydrated: boolean; runtime: string }> = [];
    render(<Probe onRender={(hydrated, runtime) => clientSeen.push({ hydrated, runtime })} />);
    expect(clientSeen.at(-1)).toEqual({ hydrated: true, runtime: 'pwa' });
  });

  it('does not construct an audio context while resuming, and keeps the upload accept string', async () => {
    expect(canUseAudioContext()).toBe(true);
    await expect(resumeSharedAudioContext()).resolves.toEqual({ available: true });
    expect(AUDIO_FILE_ACCEPT).toBe('audio/*');
    expect(readSelectedAudioFile(null)).toBeNull();

    const file = new File(['a'], 'song.mp3', { type: 'audio/mpeg' });
    expect(readSelectedAudioFile([file])).toBe(file);
  });

  it('records the future loopback and hosted-PWA packaging limits', () => {
    expect(getLoopbackServerPlan()).toEqual({
      host: '127.0.0.1',
      healthPath: '/api/health',
      exposeOnLan: false,
    });
    expect(PHASE_2_WINDOWS_CONTRACT.includeSecrets).toBe(false);
    expect(PHASE_2_WINDOWS_CONTRACT.includePythonMlAssets).toBe(false);
    expect(PHASE_2_WINDOWS_CONTRACT.packagedAssets).toEqual(['public', '.next/static']);
    expect(PHASE_4_IPAD_PWA_CONTRACT).toMatchObject({
      localPython: false,
      localNodeServer: false,
      cachePrivateAudio: false,
      cacheAuthenticatedApiResponses: false,
      offlineInference: false,
    });
  });
});
