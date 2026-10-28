/**
 * @jest-environment jsdom
 */

import { shouldRenderWebsiteFooter } from '@/components/common/websiteFooter';
import {
  DESKTOP_RUNTIME_MARKER,
  desktopDocumentMarkerValue,
  getHydrationSafeRuntime,
  resolveRuntimeAfterHydration,
} from '@/runtime/appRuntime';
import { youtubeAudioExtractionAllowed } from '@/services/youtube/linkedAnalysisSession';

describe('desktop runtime without a compiled public env var', () => {
  const originalPublic = process.env.NEXT_PUBLIC_APP_RUNTIME;
  const originalDesktop = process.env.CHORDMINI_DESKTOP_MODE;

  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_APP_RUNTIME;
    delete process.env.CHORDMINI_DESKTOP_MODE;
    document.documentElement.removeAttribute(DESKTOP_RUNTIME_MARKER);
  });

  afterAll(() => {
    if (originalPublic === undefined) delete process.env.NEXT_PUBLIC_APP_RUNTIME;
    else process.env.NEXT_PUBLIC_APP_RUNTIME = originalPublic;
    if (originalDesktop === undefined) delete process.env.CHORDMINI_DESKTOP_MODE;
    else process.env.CHORDMINI_DESKTOP_MODE = originalDesktop;
    document.documentElement.removeAttribute(DESKTOP_RUNTIME_MARKER);
  });

  it('keeps a browser document on the web runtime and still refines an installed PWA', () => {
    expect(getHydrationSafeRuntime()).toBe('web');
    expect(youtubeAudioExtractionAllowed(getHydrationSafeRuntime())).toBe(true);
    expect(shouldRenderWebsiteFooter()).toBe(true);
    expect(resolveRuntimeAfterHydration({
      matchMedia: (query: string) => ({ matches: query === '(display-mode: standalone)' }),
      navigator: { userAgent: 'Mozilla/5.0' },
    })).toEqual({
      runtime: 'pwa',
      source: 'display-mode',
      displayMode: 'standalone',
    });
  });

  it('identifies the desktop renderer from the document marker when the public variable is absent', () => {
    document.documentElement.setAttribute(DESKTOP_RUNTIME_MARKER, 'electron');
    expect(process.env.NEXT_PUBLIC_APP_RUNTIME).toBeUndefined();
    expect(process.env.CHORDMINI_DESKTOP_MODE).toBeUndefined();
    expect(getHydrationSafeRuntime()).toBe('electron');
    expect(youtubeAudioExtractionAllowed(getHydrationSafeRuntime())).toBe(false);
    expect(resolveRuntimeAfterHydration({
      navigator: { userAgent: 'Mozilla/5.0' },
    }).runtime).toBe('electron');
  });

  it('hides the website footer from the server process flag before the client bundle is consulted', () => {
    expect(desktopDocumentMarkerValue({ CHORDMINI_DESKTOP_MODE: '1' })).toBe('electron');
    expect(getHydrationSafeRuntime({ CHORDMINI_DESKTOP_MODE: '1' })).toBe('electron');
    expect(shouldRenderWebsiteFooter({ CHORDMINI_DESKTOP_MODE: '1' })).toBe(false);
    expect(desktopDocumentMarkerValue({})).toBeUndefined();
    expect(shouldRenderWebsiteFooter({})).toBe(true);
  });

  it('keeps an explicit PWA pin ahead of a stray desktop marker', () => {
    process.env.NEXT_PUBLIC_APP_RUNTIME = 'pwa';
    document.documentElement.setAttribute(DESKTOP_RUNTIME_MARKER, 'electron');
    expect(getHydrationSafeRuntime()).toBe('pwa');
    expect(youtubeAudioExtractionAllowed(getHydrationSafeRuntime())).toBe(true);
  });
});
