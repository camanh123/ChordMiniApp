/**
 * Install and launch the unsigned NSIS package on Windows.
 * Exits 2 on any other operating system.
 *
 * Progress lines are written with writeSync so a stalled stage is visible
 * before the process exits. Timeouts stop only the pids this script started.
 */
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactDir = path.join(repoRoot, 'windows-installer-artifacts');
const installDir = path.join(process.env.USERPROFILE || 'C:\\Users\\Public', 'ChordMini Acceptance');
const REQUIRED_CHECKS = [
  'install',
  'windowRender',
  'staticAssets',
  'musicUi',
  'serverStartup',
  'security',
  'audioInput',
  'singleInstance',
  'processCleanup',
  'uninstall',
];

const report = {
  status: 'FAIL',
  mockedElectron: false,
  platform: process.platform,
  installDir,
  stage: 'start',
  checks: {},
};

const owned = {
  electronApp: null,
  installerPid: null,
  electronPid: null,
  serverPid: null,
  secondPid: null,
  sentinelPid: null,
  uninstallerPid: null,
};

function redact(value) {
  return String(value).replace(/(PYTHON_API_URL|SONGFORMER_API_URL|SHEETSAGE_API_URL|CHORDMINI_READY_TOKEN|CHORDMINI_DESKTOP_COOKIE|FIREBASE_SERVICE_ACCOUNT_KEY|GEMINI_API_KEY|GENIUS_API_KEY|MUSIC_AI_API_KEY|CRON_SECRET)=([^\s]+)/gi, '$1=[redacted]');
}

function writeReport() {
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, 'packaged-report.json'), `${JSON.stringify(report, null, 2)}\n`);
}

function progress(stage, detail = {}) {
  report.stage = stage;
  report.updatedAt = new Date().toISOString();
  const extra = Object.entries(detail)
    .map(([key, value]) => `${key}=${redact(value).replace(/[\r\n]/g, ' ').slice(0, 240)}`)
    .join(' ');
  const line = `packaged-acceptance stage=${stage}${extra ? ` ${extra}` : ''}\n`;
  try {
    fs.writeSync(1, line);
  } catch {
    // The report file is the durable marker when stdout cannot be written.
  }
  try {
    writeReport();
  } catch {
    // A later stage still records the failure.
  }
}

function record(name, pass, detail) {
  report.checks[name] = { pass, ...detail };
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ownedPid(pid) {
  return Number.isInteger(pid) && pid > 1 && pid !== process.pid;
}

function imageName(pid) {
  const result = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
  const line = String(result.stdout || '').trim();
  if (!line || line.startsWith('INFO:')) {
    return '';
  }
  const match = /^"([^"]+)"/.exec(line);
  return match ? match[1].toLowerCase() : '';
}

function killRecordedPid(pid, allowedNames) {
  if (!ownedPid(pid)) {
    return;
  }
  const name = imageName(pid);
  if (!allowedNames.includes(name)) {
    return;
  }
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true,
    timeout: 15000,
  });
}

function killOwnedPid(pid) {
  if (pid === owned.sentinelPid) {
    return;
  }
  killRecordedPid(pid, ['chordmini.exe', 'uninstall chordmini.exe', 'cmd.exe']);
}

function withTimeout(label, timeoutMs, work) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([Promise.resolve().then(work), timeout]).finally(() => clearTimeout(timer));
}

function waitForExit(child, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      killOwnedPid(child.pid);
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function startProcess(file, args, options = {}) {
  return spawn(file, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio ?? 'ignore',
    windowsHide: true,
    shell: false,
  });
}

function assertNoShellMeta(value, label) {
  if (/[&|<>^]/.test(value)) {
    throw new Error(`${label} contains a shell metacharacter.`);
  }
}

async function runInstaller(installer) {
  assertNoShellMeta(installer, 'Installer path');
  assertNoShellMeta(installDir, 'Install directory');
  // NSIS requires /D= to be last and unquoted, including the space in the
  // directory. shell:true uses cmd /d /s /c without turning those quotes into
  // \", which cmd.exe treats as part of the program name.
  const command = `"${installer.replace(/"/g, '')}" /S /D=${installDir}`;
  const child = spawn(command, {
    shell: true,
    stdio: 'inherit',
    windowsHide: true,
  });
  owned.installerPid = child.pid ?? null;
  try {
    const code = await waitForExit(child, 180000, 'install');
    owned.installerPid = null;
    if (code !== 0) {
      throw new Error(`Installer exited with code ${code}.`);
    }
  } catch (error) {
    killOwnedPid(owned.installerPid);
    owned.installerPid = null;
    throw error;
  }
}

function findInstaller() {
  const output = path.join(repoRoot, 'desktop-dist');
  const matches = fs.readdirSync(output).filter((name) => name.endsWith('-x64.exe') && name.includes('Setup'));
  if (matches.length !== 1) {
    throw new Error(`Expected one NSIS installer in desktop-dist, found ${matches.join(', ') || 'none'}.`);
  }
  return path.join(output, matches[0]);
}

async function uninstall() {
  const uninstaller = path.join(installDir, 'Uninstall ChordMini.exe');
  const installedExe = path.join(installDir, 'ChordMini.exe');
  if (!fs.existsSync(uninstaller)) {
    return !fs.existsSync(installedExe);
  }
  const child = startProcess(uninstaller, ['/S'], { stdio: 'inherit' });
  owned.uninstallerPid = child.pid ?? null;
  try {
    const code = await waitForExit(child, 180000, 'uninstall');
    owned.uninstallerPid = null;
    return code === 0 && !fs.existsSync(installedExe);
  } catch (error) {
    killOwnedPid(owned.uninstallerPid);
    owned.uninstallerPid = null;
    throw error;
  }
}

function httpRequest(options, headers) {
  return withTimeout('loopback-request', 8000, () => new Promise((resolve, reject) => {
    const request = http.request({ ...options, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        resolve({
          status: response.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    request.setTimeout(5000, () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    request.end();
  }));
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

async function closeElectronForCleanup() {
  const app = owned.electronApp;
  owned.electronApp = null;
  if (!app) {
    return;
  }
  try {
    await withTimeout('electron-shutdown', 20000, () => app.close());
  } catch (error) {
    report.shutdownError = report.shutdownError || redact(error instanceof Error ? error.message : error);
  }
}

function killLeftoverOwnedProcesses() {
  killOwnedPid(owned.electronPid);
  killOwnedPid(owned.serverPid);
  killOwnedPid(owned.secondPid);
  killOwnedPid(owned.installerPid);
  killOwnedPid(owned.uninstallerPid);
}

async function cleanupOwned() {
  progress('cleanup-start');
  await closeElectronForCleanup();
  killLeftoverOwnedProcesses();
  if (!report.checks.uninstall) {
    try {
      progress('uninstall-start');
      const removed = await uninstall();
      record('uninstall', removed, {
        executableRemains: fs.existsSync(path.join(installDir, 'ChordMini.exe')),
      });
      progress('uninstall-finished', { removed });
    } catch (error) {
      record('uninstall', false, { error: redact(error instanceof Error ? error.message : error) });
      progress('uninstall-finished', { removed: false });
    }
  }
  killRecordedPid(owned.sentinelPid, ['node.exe']);
  progress('cleanup-finished');
}

async function main() {
  if (process.platform !== 'win32') {
    report.status = 'NOT_RUN';
    report.reason = 'Packaged installation is verified on Windows only.';
    writeReport();
    process.exit(2);
  }

  fs.mkdirSync(artifactDir, { recursive: true });
  const installer = findInstaller();
  report.installer = path.basename(installer);
  report.installerBytes = fs.statSync(installer).size;
  progress('install-start', {
    installer: report.installer,
    pathHasSpace: installDir.includes(' '),
  });
  await runInstaller(installer);
  const installedExe = path.join(installDir, 'ChordMini.exe');
  record('install', fs.existsSync(installedExe), {
    installDir,
    pathHasSpace: installDir.includes(' '),
  });
  progress('install-finished', { installed: fs.existsSync(installedExe) });
  if (!fs.existsSync(installedExe)) {
    throw new Error('The installer did not produce ChordMini.exe.');
  }

  const sentinel = startProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  owned.sentinelPid = sentinel.pid ?? null;
  const pidFile = path.join(artifactDir, 'owned-server.pid');
  const diagnosticFile = path.join(artifactDir, 'startup-failure.txt');
  const launchEnv = {
    ...process.env,
    CHORDMINI_DESKTOP_ACCEPTANCE: '1',
    CHORDMINI_DESKTOP_PID_FILE: pidFile,
    CHORDMINI_DESKTOP_DIAGNOSTIC_FILE: diagnosticFile,
    CHORDMINI_SKIP_ERROR_DIALOG: '1',
  };
  delete launchEnv.PYTHON_API_URL;
  const { _electron: electron } = require('playwright-core');
  progress('launch-start');
  owned.electronApp = await withTimeout('electron-launch', 120000, () => electron.launch({
    executablePath: installedExe,
    cwd: installDir,
    env: launchEnv,
    timeout: 90000,
  }));
  owned.electronPid = owned.electronApp.process().pid;
  progress('launch-finished', { electronPid: owned.electronPid });

  progress('window-wait');
  const window = await owned.electronApp.firstWindow({ timeout: 120000 });
  await window.waitForSelector('text=Open source chord & beat detection application.', { timeout: 45000 });
  await window.waitForSelector('text=Piano Visualizer', { timeout: 20000 });
  await window.waitForSelector('text=Beat & Chord Analysis & Lyrics', { timeout: 20000 });
  const pageUrl = new URL(window.url());
  progress('window-ready', { origin: pageUrl.origin });
  await withTimeout('homepage-screenshot', 20000, () => window.screenshot({
    path: path.join(artifactDir, 'packaged-homepage.png'),
  }));

  progress('assets-start');
  const assets = await withTimeout('static-assets', 20000, () => window.evaluate(async () => {
    const logo = await fetch('/chordMiniLogo.webp', { signal: AbortSignal.timeout(8000) });
    const script = [...document.scripts].map((item) => item.src).find((src) => src.includes('/_next/static/'));
    const staticResponse = script ? await fetch(script, { signal: AbortSignal.timeout(8000) }) : null;
    return {
      logoStatus: logo.status,
      staticStatus: staticResponse ? staticResponse.status : 0,
      pianoText: document.body.innerText.includes('Piano Visualizer'),
      chordGridText: document.body.innerText.includes('Beat & Chord Analysis & Lyrics'),
    };
  }));
  record('windowRender', pageUrl.hostname === '127.0.0.1', { origin: pageUrl.origin });
  record('staticAssets', assets.logoStatus === 200 && assets.staticStatus === 200, assets);
  record('musicUi', assets.pianoText && assets.chordGridText, {
    pianoVisualizer: assets.pianoText,
    chordGrid: assets.chordGridText,
    analysisInvoked: false,
  });
  progress('assets-finished', {
    logoStatus: assets.logoStatus,
    staticStatus: assets.staticStatus,
  });

  progress('server-check');
  const port = Number(pageUrl.port);
  const ready = await httpRequest({ hostname: '127.0.0.1', port, path: '/api/desktop/ready', method: 'GET' }, {
    'x-chordmini-nonce': 'packaged-acceptance',
  });
  const readyBody = JSON.parse(ready.body);
  record('serverStartup', ready.status === 200 && readyBody.role === 'next-standalone', {
    status: ready.status,
    role: readyBody.role,
    hostname: pageUrl.hostname,
  });
  progress('server-ready', { status: ready.status, role: readyBody.role });

  progress('security-check');
  const security = await withTimeout('security-preferences', 20000, () => owned.electronApp.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const readPrefs = win.webContents.getLastWebPreferences;
    const prefs = typeof readPrefs === 'function' ? readPrefs.call(win.webContents) : null;
    return prefs ? {
      nodeIntegration: prefs.nodeIntegration === true,
      contextIsolation: prefs.contextIsolation === true,
      sandbox: prefs.sandbox === true,
      webSecurity: prefs.webSecurity !== false,
      preload: Boolean(prefs.preload),
    } : null;
  }));
  record('security', Boolean(security) && security.nodeIntegration === false && security.contextIsolation && security.sandbox && security.webSecurity && security.preload === false, {
    prefs: security,
  });
  progress('security-finished', { pass: report.checks.security.pass });

  progress('audio-start');
  await withTimeout('analyze-navigation', 30000, () => window.goto(`${pageUrl.origin}/analyze`, { timeout: 30000 }));
  await window.waitForSelector('text=Choose Audio File', { timeout: 30000 });
  const audioFile = path.join(artifactDir, 'acceptance-tone.wav');
  writeWav(audioFile);
  await withTimeout('audio-file-selection', 20000, () => window.locator('input[type="file"]').setInputFiles(audioFile));
  await window.waitForSelector('text=acceptance-tone.wav', { timeout: 10000 });
  await withTimeout('audio-screenshot', 20000, () => window.screenshot({
    path: path.join(artifactDir, 'packaged-audio.png'),
  }));
  record('audioInput', true, { filename: 'acceptance-tone.wav', analysisInvoked: false });
  progress('audio-finished');

  owned.serverPid = Number(fs.readFileSync(pidFile, 'utf8'));
  progress('single-instance-start', { serverPid: owned.serverPid });
  const second = startProcess(installedExe, [], { cwd: installDir, env: launchEnv });
  owned.secondPid = second.pid ?? null;
  const secondCode = await waitForExit(second, 30000, 'second-instance');
  owned.secondPid = null;
  const windowCount = await withTimeout('window-count', 20000, () => owned.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length));
  record('singleInstance', secondCode === 0 && windowCount === 1, { secondExitCode: secondCode, windowCount });
  progress('single-instance-finished', { secondExitCode: secondCode, windowCount });

  progress('shutdown-start', { electronPid: owned.electronPid, serverPid: owned.serverPid });
  const app = owned.electronApp;
  owned.electronApp = null;
  if (app) {
    try {
      await withTimeout('electron-shutdown', 20000, () => app.close());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/target closed|has been closed|application exited/i.test(message)) {
        report.shutdownError = redact(message);
        killOwnedPid(owned.electronPid);
        killOwnedPid(owned.serverPid);
      }
    }
  }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && (isAlive(owned.electronPid) || isAlive(owned.serverPid))) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  record('processCleanup', !isAlive(owned.electronPid) && !isAlive(owned.serverPid) && isAlive(owned.sentinelPid) && !report.shutdownError, {
    electronPid: owned.electronPid,
    electronAlive: isAlive(owned.electronPid),
    serverPid: owned.serverPid,
    serverAlive: isAlive(owned.serverPid),
    sentinelPid: owned.sentinelPid,
    sentinelAlive: isAlive(owned.sentinelPid),
    forcedShutdown: Boolean(report.shutdownError),
  });
  progress('shutdown-finished', {
    serverAlive: isAlive(owned.serverPid),
    sentinelAlive: isAlive(owned.sentinelPid),
  });
  if (isAlive(owned.electronPid) || isAlive(owned.serverPid)) {
    killOwnedPid(owned.electronPid);
    killOwnedPid(owned.serverPid);
  }

  progress('uninstall-start');
  const removed = await uninstall();
  record('uninstall', removed, { executableRemains: fs.existsSync(installedExe) });
  progress('uninstall-finished', { removed });
}

main().catch((error) => {
  report.error = redact(error && error.stack ? error.stack : error);
  progress('failed', { message: report.error.split('\n')[0] });
}).finally(async () => {
  if (report.status === 'NOT_RUN') {
    return;
  }
  try {
    await cleanupOwned();
  } catch (error) {
    report.cleanupError = redact(error instanceof Error ? error.message : error);
  }
  const passed = REQUIRED_CHECKS.every((name) => report.checks[name]?.pass === true);
  report.status = passed ? 'PASS' : 'FAIL';
  writeReport();
  progress('finished', { status: report.status });
  process.exit(report.status === 'PASS' ? 0 : 1);
});
