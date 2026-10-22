/**
 * Requirements for later packaging phases. This module records the contract.
 * It does not launch Electron, install a service worker, or bind a port.
 */

export const PHASE_2_WINDOWS_CONTRACT = {
  shell: 'electron',
  server: 'next-standalone',
  bindHost: '127.0.0.1',
  portSelection: 'ephemeral-loopback',
  healthPath: '/api/health',
  packagedAssets: ['public', '.next/static'],
  includeSecrets: false,
  includePythonMlAssets: false,
  analysisBackend: 'existing-remote-flask',
} as const;

export const PHASE_4_IPAD_PWA_CONTRACT = {
  shell: 'pwa',
  host: 'existing-hosted-next-site',
  localPython: false,
  localNodeServer: false,
  analysisTransport: 'same-origin-api-routes',
  cachePrivateAudio: false,
  cacheAuthenticatedApiResponses: false,
  offlineInference: false,
} as const;

export interface LoopbackServerPlan {
  host: '127.0.0.1';
  healthPath: '/api/health';
  exposeOnLan: false;
}

/** Phase 2 must bind the future Node server to loopback and check /api/health. */
export function getLoopbackServerPlan(): LoopbackServerPlan {
  return {
    host: PHASE_2_WINDOWS_CONTRACT.bindHost,
    healthPath: PHASE_2_WINDOWS_CONTRACT.healthPath,
    exposeOnLan: false,
  };
}
