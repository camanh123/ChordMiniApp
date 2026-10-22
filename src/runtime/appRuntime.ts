/**
 * Shared application runtime contract.
 *
 * Server rendering and the first client render both use getHydrationSafeRuntime().
 * Installed-PWA and Electron detection run only through resolveRuntimeAfterHydration(),
 * which callers must invoke after hydration. That keeps display-mode checks from
 * changing the server markup.
 */

export const APP_RUNTIMES = ['web', 'electron', 'pwa'] as const;

export type AppRuntime = (typeof APP_RUNTIMES)[number];

export type RuntimeSource = 'configured' | 'electron-client' | 'display-mode' | 'fallback';

export type DisplayMode = 'browser' | 'standalone' | 'minimal-ui' | 'fullscreen' | 'unknown';

export interface RuntimeSnapshot {
  runtime: AppRuntime;
  source: RuntimeSource;
  displayMode: DisplayMode;
}

export interface RuntimeHost {
  matchMedia?: (query: string) => { matches: boolean };
  navigator?: {
    userAgent?: string;
    standalone?: boolean;
  };
}

const DISPLAY_MODES: readonly DisplayMode[] = ['fullscreen', 'standalone', 'minimal-ui', 'browser'];

export function parseAppRuntime(value: string | undefined | null): AppRuntime | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return (APP_RUNTIMES as readonly string[]).includes(normalized)
    ? (normalized as AppRuntime)
    : null;
}

/**
 * Explicit Electron or PWA selection. `web` and missing/invalid values stay
 * unpinned so one hosted build can refine to an installed PWA after hydration.
 */
export function getPinnedAppRuntime(env: NodeJS.ProcessEnv = process.env): AppRuntime | null {
  const parsed = parseAppRuntime(env.NEXT_PUBLIC_APP_RUNTIME);
  return parsed === 'electron' || parsed === 'pwa' ? parsed : null;
}

/** Value that is identical on the server and during the first client render. */
export function getHydrationSafeRuntime(env: NodeJS.ProcessEnv = process.env): AppRuntime {
  return getPinnedAppRuntime(env) ?? 'web';
}

export function readDisplayMode(host: RuntimeHost | null | undefined): DisplayMode {
  if (!host) {
    return 'unknown';
  }

  if (typeof host.matchMedia === 'function') {
    for (const mode of DISPLAY_MODES) {
      try {
        if (host.matchMedia(`(display-mode: ${mode})`).matches) {
          return mode;
        }
      } catch {
        return 'unknown';
      }
    }
  }

  if (host.navigator?.standalone === true) {
    return 'standalone';
  }

  return 'unknown';
}

export function isElectronClient(host: RuntimeHost | null | undefined): boolean {
  return (host?.navigator?.userAgent ?? '').includes('Electron');
}

export function isInstalledPwaDisplay(host: RuntimeHost | null | undefined): boolean {
  if (host?.navigator?.standalone === true) {
    return true;
  }

  const mode = readDisplayMode(host);
  return mode === 'standalone' || mode === 'minimal-ui' || mode === 'fullscreen';
}

/**
 * Client refinement. Pass no host when window/document are unavailable; the
 * result stays on the hydration-safe runtime and does not touch browser APIs.
 */
export function resolveRuntimeAfterHydration(
  host?: RuntimeHost | null,
  env: NodeJS.ProcessEnv = process.env,
): RuntimeSnapshot {
  const pinned = getPinnedAppRuntime(env);
  const displayMode = host ? readDisplayMode(host) : 'unknown';

  if (pinned) {
    return { runtime: pinned, source: 'configured', displayMode };
  }

  if (!host) {
    return { runtime: 'web', source: 'fallback', displayMode: 'unknown' };
  }

  if (isElectronClient(host)) {
    return { runtime: 'electron', source: 'electron-client', displayMode };
  }

  if (isInstalledPwaDisplay(host)) {
    return { runtime: 'pwa', source: 'display-mode', displayMode };
  }

  return { runtime: 'web', source: 'fallback', displayMode };
}
