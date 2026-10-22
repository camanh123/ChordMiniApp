/**
 * Windows-only acceptance for the real Electron binary.
 * A non-Windows run exits 2 and must not be reported as a Windows pass.
 */
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactDir = path.join(repoRoot, 'windows-electron-artifacts');
const mainScript = path.join(repoRoot, 'electron', 'main.cjs');
const serverEntry = path.join(repoRoot, '.next', 'standalone', 'server.js');
const serverBackup = path.join(repoRoot, '.next', 'standalone', 'server.js.acceptance-backup');
const leakFixture = path.join(repoRoot, '__tests__', 'fixtures', 'desktopReadyServer.cjs');
const plantedBackend = 'https://analysis.example/private-token-value';

const report = {
  status: 'FAIL',
  mockedElectron: false,
  platform: process.platform,
  checks: {},
};

function redact(value) {
  return String(value)
    .replace(/https?:\/\/\S*private-token-value\S*/gi, '[redacted]')
    .replace(/(PYTHON_API_URL|SONGFORMER_API_URL|SHEETSAGE_API_URL|CHORDMINI_READY_TOKEN|CHORDMINI_DESKTOP_COOKIE|FIREBASE_SERVICE_ACCOUNT_KEY|GEMINI_API_KEY|GENIUS_API_KEY|MUSIC_AI_API_KEY|CRON_SECRET)=([^\s]+)/gi, '$1=[redacted]');
}

function writeReport() {
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
}

function record(name, pass, detail) {
  report.checks[name] = { pass, ...detail };
  if (!pass) {
    report.status = 'FAIL';
  }
}

function httpRequest(options, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request({ ...options, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    request.setTimeout(5000, () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    request.end();
  });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function windowsProcesses() {
  const command = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress -Depth 3';
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(redact(result.stderr || 'Windows process query failed'));
  }
  const parsed = JSON.parse(result.stdout || '[]');
  return Array.isArray(parsed) ? parsed : [parsed];
}

function ownedServerPids(electronPid) {
  return windowsProcesses()
    .filter((entry) => Number(entry.ParentProcessId) === electronPid)
    .filter((entry) => typeof entry.CommandLine === 'string' && entry.CommandLine.includes(`${path.sep}standalone${path.sep}server.js`))
    .map((entry) => ({ pid: Number(entry.ProcessId), name: String(entry.Name || '') }));
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function restoreServer() {
  if (fs.existsSync(serverBackup)) {
    fs.copyFileSync(serverBackup, serverEntry);
    fs.rmSync(serverBackup, { force: true });
  }
}

async function verifyStartupFailure(electronPath) {
  fs.copyFileSync(serverEntry, serverBackup);
  fs.copyFileSync(leakFixture, serverEntry);
  const diagnosticFile = path.join(artifactDir, 'startup-failure.txt');
  const child = spawn(electronPath, [mainScript], {
    cwd: repoRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CHORDMINI_SKIP_ERROR_DIALOG: '1',
      CHORDMINI_DESKTOP_DIAGNOSTIC_FILE: diagnosticFile,
      CHORDMINI_TEST_LEAK: '1',
      PYTHON_API_URL: plantedBackend,
    },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const exitCode = await waitForExit(child, 30000);
  const diagnostic = fs.existsSync(diagnosticFile) ? fs.readFileSync(diagnosticFile, 'utf8') : '';
  const safeDiagnostic = redact(diagnostic);
  fs.writeFileSync(diagnosticFile, safeDiagnostic);
  const leaked = diagnostic.includes(plantedBackend) || /CHORDMINI_READY_TOKEN=[0-9a-f]{16,}/i.test(diagnostic);
  record('startupFailure', diagnostic.includes('did not become ready') && !leaked, {
    exitCode,
    leaked,
    diagnostic: safeDiagnostic.slice(0, 500),
    stderr: redact(stderr).slice(0, 500),
  });
}

async function main() {
  if (process.platform !== 'win32') {
    report.status = 'NOT_RUN';
    report.reason = 'This script records a Windows Electron result only.';
    writeReport();
    process.exit(2);
  }

  fs.mkdirSync(artifactDir, { recursive: true });
  const electronPath = require('electron');
  const electronPackage = require('electron/package.json');
  report.electronVersion = electronPackage.version;
  report.electronBinary = electronPath;
  if (typeof electronPath !== 'string' || !fs.existsSync(electronPath) || fs.statSync(electronPath).size < 1000000) {
    throw new Error('The Windows Electron executable is missing.');
  }
  if (!fs.existsSync(serverEntry) || !fs.existsSync(mainScript)) {
    throw new Error('Build the Next standalone server and compile the Electron main process first.');
  }

  const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  report.sentinelPid = sentinel.pid;

  const { _electron: electron } = require('playwright-core');
  let electronApp = null;
  try {
    await verifyStartupFailure(electronPath);
    restoreServer();
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const launchEnv = { ...process.env };
    delete launchEnv.CHORDMINI_SKIP_ERROR_DIALOG;
    delete launchEnv.CHORDMINI_DESKTOP_DIAGNOSTIC_FILE;
    delete launchEnv.CHORDMINI_TEST_LEAK;
    delete launchEnv.PYTHON_API_URL;

    electronApp = await electron.launch({
      executablePath: electronPath,
      args: [mainScript],
      cwd: repoRoot,
      env: launchEnv,
      timeout: 90000,
    });
    const electronPid = electronApp.process().pid;
    report.electronPid = electronPid;
    const window = await electronApp.firstWindow({ timeout: 90000 });
    await window.waitForSelector('text=Open source chord & beat detection application.', { timeout: 30000 });
    await window.waitForSelector('input[placeholder="Search for music or paste YouTube URL..."]', { timeout: 30000 });
    const pageUrl = window.url();
    const parsedUrl = new URL(pageUrl);
    await window.screenshot({ path: path.join(artifactDir, 'homepage.png') });
    record('electronLaunch', true, { pid: electronPid });
    record('windowRender', parsedUrl.hostname === '127.0.0.1' && parsedUrl.protocol === 'http:', {
      origin: parsedUrl.origin,
    });

    const observed = await electronApp.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      let prefs = null;
      try {
        const readPrefs = win.webContents.getLastWebPreferences;
        if (typeof readPrefs === 'function') {
          prefs = readPrefs.call(win.webContents);
        }
      } catch {
        prefs = null;
      }
      const page = JSON.parse(await win.webContents.executeJavaScript(`JSON.stringify({
        requireType: typeof require,
        processType: typeof process,
        bridge: typeof window.electron,
        crossOriginIsolated: window.crossOriginIsolated === true,
        sharedArrayBuffer: typeof SharedArrayBuffer === 'function',
        youtubeFrames: document.querySelectorAll('iframe[src*="youtube"]').length,
        title: document.title
      })`));
      return {
        windowCount: BrowserWindow.getAllWindows().length,
        page,
        prefs: prefs ? {
          nodeIntegration: prefs.nodeIntegration === true,
          contextIsolation: prefs.contextIsolation === true,
          sandbox: prefs.sandbox === true,
          webSecurity: prefs.webSecurity !== false,
          webviewTag: prefs.webviewTag === true,
          preload: Boolean(prefs.preload),
        } : null,
      };
    });
    report.windowTitle = observed.page.title;
    const securityOk = observed.page.requireType === 'undefined'
      && observed.page.processType === 'undefined'
      && observed.page.bridge === 'undefined'
      && observed.prefs
      && observed.prefs.nodeIntegration === false
      && observed.prefs.contextIsolation === true
      && observed.prefs.sandbox === true
      && observed.prefs.webSecurity === true
      && observed.prefs.webviewTag === false
      && observed.prefs.preload === false;
    record('windowSecurity', securityOk, {
      webPreferencesReadFromProcess: Boolean(observed.prefs),
      prefs: observed.prefs,
      page: {
        requireType: observed.page.requireType,
        processType: observed.page.processType,
        bridge: observed.page.bridge,
      },
    });

    const port = Number(parsedUrl.port);
    const ready = await httpRequest({ hostname: '127.0.0.1', port, path: '/api/desktop/ready', method: 'GET' }, {
      'x-chordmini-nonce': 'windows-acceptance',
    });
    const readyBody = JSON.parse(ready.body);
    record('localServerReady', ready.status === 200 && readyBody.role === 'next-standalone' && !String(ready.body).includes('CHORDMINI_READY_TOKEN'), {
      status: ready.status,
      role: readyBody.role,
      hostname: parsedUrl.hostname,
      port,
    });

    const foreign = await httpRequest({ hostname: '127.0.0.1', port, path: '/api/config', method: 'GET' }, {
      Origin: 'https://evil.example',
      'Sec-Fetch-Site': 'cross-site',
    });
    const localhostHost = await httpRequest({ hostname: '127.0.0.1', port, path: '/api/config', method: 'GET' }, {
      Host: `localhost:${port}`,
    });
    const anonymousApi = await httpRequest({ hostname: '127.0.0.1', port, path: '/api/config', method: 'GET' }, {});
    const pageApiStatus = await window.evaluate(async () => {
      const response = await fetch('/api/config');
      return {
        status: response.status,
        cookieVisible: document.cookie.includes('chordmini_desktop'),
      };
    });
    record('desktopBoundary', foreign.status === 403 && localhostHost.status === 403 && anonymousApi.status === 403 && pageApiStatus.status === 200 && pageApiStatus.cookieVisible === false, {
      foreignStatus: foreign.status,
      localhostHostStatus: localhostHost.status,
      anonymousApiStatus: anonymousApi.status,
      pageApiStatus: pageApiStatus.status,
      cookieVisibleToRenderer: pageApiStatus.cookieVisible,
    });

    await window.goto(`${parsedUrl.origin}/analyze`);
    await window.waitForSelector('text=Choose Audio File', { timeout: 30000 });
    const audioFile = path.join(artifactDir, 'acceptance-tone.wav');
    writeWav(audioFile);
    await window.locator('input[type="file"]').setInputFiles(audioFile);
    await window.waitForSelector('text=acceptance-tone.wav', { timeout: 10000 });
    await window.screenshot({ path: path.join(artifactDir, 'audio-file.png') });
    record('audioInput', true, { filename: 'acceptance-tone.wav', analysisInvoked: false });

    const workerStatus = await window.evaluate(async () => {
      const response = await fetch('/ffmpeg-worker/worker.js');
      return response.status;
    });
    const homepage = await httpRequest({ hostname: '127.0.0.1', port, path: '/', method: 'GET' }, {
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Site': 'none',
    });
    const headerValue = (headers, name) => {
      const value = headers[name];
      return Array.isArray(value) ? value.join(',') : value || '';
    };
    record('mediaInvestigation', true, {
      youtubeEmbedExercised: false,
      youtubeFrameCount: observed.page.youtubeFrames,
      ffmpegWasmExercised: false,
      ffmpegWorkerStatus: workerStatus,
      crossOriginIsolated: observed.page.crossOriginIsolated,
      sharedArrayBuffer: observed.page.sharedArrayBuffer,
      coep: headerValue(homepage.headers, 'cross-origin-embedder-policy'),
      coop: headerValue(homepage.headers, 'cross-origin-opener-policy'),
    });

    const serversBefore = ownedServerPids(electronPid);
    record('ownedServerObserved', serversBefore.length > 0, { servers: serversBefore });

    const second = spawn(electronPath, [mainScript], {
      cwd: repoRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: launchEnv,
    });
    const secondCode = await waitForExit(second, 20000);
    const afterSecond = await electronApp.evaluate(({ BrowserWindow }) => ({
      count: BrowserWindow.getAllWindows().length,
      focused: BrowserWindow.getAllWindows()[0]?.isFocused() ?? false,
    }));
    record('singleInstance', secondCode === 0 && afterSecond.count === 1, {
      secondExitCode: secondCode,
      windowCount: afterSecond.count,
      focused: afterSecond.focused,
    });

    await electronApp.close();
    electronApp = null;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && isAlive(electronPid)) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const serversAfter = serversBefore.filter((entry) => isAlive(entry.pid));
    record('processTreeCleanup', !isAlive(electronPid) && serversAfter.length === 0 && isAlive(sentinel.pid), {
      electronAlive: isAlive(electronPid),
      remainingServers: serversAfter,
      sentinelAlive: isAlive(sentinel.pid),
    });

    const failed = Object.values(report.checks).some((check) => check.pass === false);
    report.status = failed ? 'FAIL' : 'PASS';
  } finally {
    restoreServer();
    if (electronApp) {
      await electronApp.close().catch(() => undefined);
    }
    if (sentinel.pid && isAlive(sentinel.pid)) {
      spawnSync('taskkill', ['/PID', String(sentinel.pid), '/T', '/F'], { windowsHide: true });
    }
    writeReport();
  }
}

function writeWav(file) {
  const sampleRate = 8000;
  const samples = Math.floor(sampleRate / 10);
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  fs.writeFileSync(file, buffer);
}

main().catch((error) => {
  report.status = report.status === 'NOT_RUN' ? report.status : 'FAIL';
  report.error = redact(error && error.stack ? error.stack : error);
  writeReport();
  process.exit(1);
}).then(() => {
  if (report.status === 'PASS') {
    process.exit(0);
  }
  if (report.status === 'NOT_RUN') {
    process.exit(2);
  }
  process.exit(1);
});
