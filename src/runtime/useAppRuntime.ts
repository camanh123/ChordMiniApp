'use client';

import { useSyncExternalStore } from 'react';
import {
  getHydrationSafeRuntime,
  resolveRuntimeAfterHydration,
  type AppRuntime,
  type DisplayMode,
} from '@/runtime/appRuntime';

export interface AppRuntimeState {
  runtime: AppRuntime;
  displayMode: DisplayMode;
  /** False for the server render and the hydration render. */
  hydrated: boolean;
}

const DISPLAY_MODE_QUERIES = [
  '(display-mode: fullscreen)',
  '(display-mode: standalone)',
  '(display-mode: minimal-ui)',
  '(display-mode: browser)',
] as const;

const serverSnapshots = new Map<AppRuntime, AppRuntimeState>();
let clientSnapshot: AppRuntimeState | null = null;

function getServerRuntimeSnapshot(): AppRuntimeState {
  const runtime = getHydrationSafeRuntime();
  const existing = serverSnapshots.get(runtime);
  if (existing) {
    return existing;
  }

  const snapshot: AppRuntimeState = {
    runtime,
    displayMode: 'unknown',
    hydrated: false,
  };
  serverSnapshots.set(runtime, snapshot);
  return snapshot;
}

function getClientRuntimeSnapshot(): AppRuntimeState {
  const resolved = resolveRuntimeAfterHydration(window);
  if (
    clientSnapshot
    && clientSnapshot.runtime === resolved.runtime
    && clientSnapshot.displayMode === resolved.displayMode
  ) {
    return clientSnapshot;
  }

  clientSnapshot = {
    runtime: resolved.runtime,
    displayMode: resolved.displayMode,
    hydrated: true,
  };
  return clientSnapshot;
}

function subscribeToRuntime(onStoreChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => undefined;
  }

  const queries = DISPLAY_MODE_QUERIES.map((query) => window.matchMedia(query));
  queries.forEach((query) => query.addEventListener('change', onStoreChange));
  return () => {
    queries.forEach((query) => query.removeEventListener('change', onStoreChange));
  };
}

/**
 * Hydration-safe runtime hook.
 * React reuses the server snapshot for the hydration render, then reads
 * display mode and the Electron user agent from the client snapshot.
 */
export function useAppRuntime(): AppRuntimeState {
  return useSyncExternalStore(
    subscribeToRuntime,
    getClientRuntimeSnapshot,
    getServerRuntimeSnapshot,
  );
}
