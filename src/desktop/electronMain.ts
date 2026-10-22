import { app, BrowserWindow, dialog, shell } from 'electron';
import fs from 'fs';
import path from 'path';
import { sanitizeDiagnostic } from './diagnostics';
import { startOwnedServer, stopOwnedServer, type OwnedServer } from './ownedServer';
import { prepareStandalone } from './prepareStandalone';
import {
  classifyNavigation,
  createBrowserWindowOptions,
  singleInstanceDecision,
  windowOpenDecision,
} from './windowPolicy';

const repoRoot = path.join(__dirname, '..', '..');
let owned: OwnedServer | null = null;
let quitting = false;

function writeDiagnostic(message: string): void {
  const secrets = owned ? [owned.readyToken, owned.cookieToken] : [];
  const line = sanitizeDiagnostic(message, secrets);
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
  const safe = sanitizeDiagnostic(message, owned ? [owned.readyToken, owned.cookieToken] : []).slice(0, 2000);
  writeDiagnostic(safe);
  dialog.showErrorBox('ChordMini could not start', safe);
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
  const layout = prepareStandalone(repoRoot);
  owned = await startOwnedServer({ serverEntry: layout.serverEntry });
  const window = new BrowserWindow(createBrowserWindowOptions());
  attachNavigationGuards(window, owned.origin);
  window.once('ready-to-show', () => {
    window.show();
  });
  await window.loadURL(`${owned.origin}/`);
}

async function shutdownOwnedServer(): Promise<void> {
  const current = owned;
  owned = null;
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
    if (quitting || !owned) {
      return;
    }
    event.preventDefault();
    quitting = true;
    void shutdownOwnedServer().finally(() => {
      app.quit();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  void app.whenReady().then(openOwnedWindow).catch(async (error: unknown) => {
    showStartupFailure(error);
    await shutdownOwnedServer();
    app.quit();
  });
}
