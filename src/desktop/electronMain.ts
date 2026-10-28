import { app, BrowserWindow, dialog, powerMonitor, session, shell } from 'electron';
import fs from 'fs';
import path from 'path';
import { sanitizeDiagnostic, secretsFromEnv } from './diagnostics';
import { analysisHistoryDir } from './analysisHistory/location';
import { consumeRetryRequest } from './localBackend';
import { prepareOwnedBackend, type OwnedBackendHandle } from './ownedBackend';
import { startOwnedServer, stopOwnedServer, type OwnedServer } from './ownedServer';
import { acceptanceDiagnosticFile, acceptancePidFile, isDesktopAcceptance, resolveDesktopLaunch } from './packagedApp';
import { prepareStandalone } from './prepareStandalone';
import {
  classifyNavigation,
  createBrowserWindowOptions,
  microphonePermissionGranted,
  nonMediaPermissionCheckAllowed,
  singleInstanceDecision,
  windowOpenDecision,
} from './windowPolicy';

const repoRoot = path.join(__dirname, '..', '..');
let owned: OwnedServer | null = null;
let backend: OwnedBackendHandle | null = null;
let retryTimer: ReturnType<typeof setInterval> | null = null;
let quitting = false;

function diagnosticSecrets(): string[] {
  return [
    ...(owned ? [owned.readyToken, owned.cookieToken] : []),
    ...secretsFromEnv(process.env),
  ];
}

function writeDiagnostic(message: string): void {
  const line = sanitizeDiagnostic(message, diagnosticSecrets());
  try {
    const logPath = path.join(app.getPath('userData'), 'desktop.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // The dialog still reports the failure when the log file cannot be written.
  }
}

function showStartupFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : 'The desktop shell failed to start.';
  const safe = sanitizeDiagnostic(message, diagnosticSecrets()).slice(0, 2000);
  writeDiagnostic(safe);
  const diagnosticFile = acceptanceDiagnosticFile(process.env);
  if (diagnosticFile) {
    try {
      fs.mkdirSync(path.dirname(diagnosticFile), { recursive: true });
      fs.writeFileSync(diagnosticFile, safe);
    } catch {
      // The dialog remains the user-facing report.
    }
  }
  if (isDesktopAcceptance(process.env) && process.env.CHORDMINI_SKIP_ERROR_DIALOG === '1') {
    return;
  }
  dialog.showErrorBox('ChordMini could not start', safe);
}

function attachMicrophonePermission(appOrigin: string): void {
  const current = session.defaultSession;
  current.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined;
    callback(microphonePermissionGranted({
      permission,
      isMainFrame: details.isMainFrame,
      mediaTypes,
      requestingUrl: details.requestingUrl,
    }, appOrigin));
  });
  current.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => (
    nonMediaPermissionCheckAllowed({
      permission,
      requestingOrigin,
      isMainFrame: details.isMainFrame,
    }, appOrigin)
  ));
  current.setDisplayMediaRequestHandler((_request, callback) => {
    callback(null);
  });
}

function attachNavigationGuards(window: BrowserWindow, appOrigin: string): void {
  const guard = (event: { preventDefault: () => void }, targetUrl: string) => {
    const decision = classifyNavigation(targetUrl, appOrigin);
    if (decision === 'allow') {
      return;
    }
    event.preventDefault();
    if (decision === 'external') {
      void shell.openExternal(targetUrl);
    }
  };

  window.webContents.on('will-navigate', guard);
  window.webContents.on('will-redirect', guard);
  window.webContents.setWindowOpenHandler(({ url }) => {
    const decision = windowOpenDecision(url, appOrigin);
    if (decision.openExternal) {
      void shell.openExternal(decision.openExternal);
    }
    return { action: 'deny' };
  });
  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}

async function openOwnedWindow(): Promise<void> {
  const launch = resolveDesktopLaunch({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    repoRoot,
  });
  if (launch.prepareFromRepo) {
    prepareStandalone(repoRoot);
  }
  const userDataDir = app.getPath('userData');
  backend = await prepareOwnedBackend({
    env: process.env,
    userDataDir,
    historyDir: analysisHistoryDir(userDataDir),
    log: writeDiagnostic,
  });
  owned = await startOwnedServer({
    serverEntry: launch.serverEntry,
    extraEnv: backend.nextEnv,
  });
  if (retryTimer) {
    clearInterval(retryTimer);
  }
  const retryFile = backend.retryFile;
  retryTimer = setInterval(() => {
    if (!backend || !consumeRetryRequest(retryFile, backend.retryToken)) {
      return;
    }
    void backend.retry();
  }, 1000);
  retryTimer.unref?.();
  const pidFile = acceptancePidFile(process.env);
  if (pidFile && owned.child.pid) {
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, String(owned.child.pid));
  }
  const window = new BrowserWindow(createBrowserWindowOptions());
  attachNavigationGuards(window, owned.origin);
  attachMicrophonePermission(owned.origin);
  window.once('ready-to-show', () => {
    window.show();
  });
  await window.loadURL(`${owned.origin}/`);
}

async function shutdownOwnedServer(): Promise<void> {
  if (retryTimer) {
    clearInterval(retryTimer);
    retryTimer = null;
  }
  const currentBackend = backend;
  const current = owned;
  backend = null;
  owned = null;
  await currentBackend?.stop().catch(() => undefined);
  await stopOwnedServer(current);
}

const instance = singleInstanceDecision(app.requestSingleInstanceLock());
if (instance === 'quit') {
  app.quit();
} else {
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) {
      return;
    }
    if (window.isMinimized()) {
      window.restore();
    }
    window.focus();
  });

  app.on('before-quit', (event) => {
    if (quitting || (!owned && !backend)) {
      return;
    }
    event.preventDefault();
    quitting = true;
    void shutdownOwnedServer().catch(() => undefined).finally(() => {
      app.quit();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  void app.whenReady().then(() => {
    powerMonitor.on('resume', () => {
      void backend?.onResume();
    });
    return openOwnedWindow();
  }).catch(async (error: unknown) => {
    showStartupFailure(error);
    await shutdownOwnedServer();
    app.quit();
  });
}
