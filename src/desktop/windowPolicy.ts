export interface DesktopWindowOptions {
  width: number;
  height: number;
  show: boolean;
  title: string;
  autoHideMenuBar: boolean;
  webPreferences: {
    nodeIntegration: false;
    contextIsolation: true;
    sandbox: true;
    webSecurity: true;
    allowRunningInsecureContent: false;
    webviewTag: false;
    nodeIntegrationInSubFrames: false;
  };
}

export function createBrowserWindowOptions(): DesktopWindowOptions {
  return {
    width: 1280,
    height: 840,
    show: false,
    title: 'ChordMini',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      nodeIntegrationInSubFrames: false,
    },
  };
}

export type NavigationClass = 'allow' | 'external' | 'deny';

export function classifyNavigation(targetUrl: string, appOrigin: string): NavigationClass {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return 'deny';
  }

  if (parsed.origin === appOrigin && parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1') {
    return 'allow';
  }

  if (parsed.protocol === 'https:') {
    return 'external';
  }

  return 'deny';
}

export function windowOpenDecision(
  targetUrl: string,
  appOrigin: string,
): { action: 'deny'; openExternal?: string } {
  const kind = classifyNavigation(targetUrl, appOrigin);
  if (kind === 'external') {
    return { action: 'deny', openExternal: targetUrl };
  }
  return { action: 'deny' };
}

export function singleInstanceDecision(lockGranted: boolean): 'continue' | 'quit' {
  return lockGranted ? 'continue' : 'quit';
}

export interface MicrophonePermissionRequest {
  permission: string;
  isMainFrame: boolean;
  mediaTypes?: readonly string[];
  requestingUrl?: string;
}

/**
 * Grants only a main-frame microphone request from the owned loopback origin.
 * Camera, display capture, and every other permission stay denied here.
 */
export function microphonePermissionGranted(
  request: MicrophonePermissionRequest,
  appOrigin: string,
): boolean {
  if (request.permission !== 'media' || !request.isMainFrame) return false;
  if (!request.mediaTypes || request.mediaTypes.length !== 1 || request.mediaTypes[0] !== 'audio') return false;
  if (!request.requestingUrl) return false;
  let parsed: URL;
  try {
    parsed = new URL(request.requestingUrl);
  } catch {
    return false;
  }
  return parsed.origin === appOrigin && parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1';
}

export interface PermissionCheckRequest {
  permission: string;
  requestingOrigin?: string;
  isMainFrame?: boolean;
}

/**
 * Media and display capture are never pre-granted. A microphone request still
 * has to pass microphonePermissionGranted. Other checks stay on the owned origin.
 */
export function nonMediaPermissionCheckAllowed(
  request: PermissionCheckRequest,
  appOrigin: string,
): boolean {
  if (request.permission === 'media' || request.permission === 'display-capture') return false;
  if (!request.isMainFrame || !request.requestingOrigin) return false;
  let parsed: URL;
  try {
    parsed = new URL(request.requestingOrigin);
  } catch {
    return false;
  }
  return parsed.origin === appOrigin && parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1';
}
