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
