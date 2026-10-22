/**
 * Install and launch the unsigned NSIS package on Windows.
 * Exits 2 on any other operating system.
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

const report = {
  status: 'FAIL',
  mockedElectron: false,
  platform: process.platform,
  installDir,
  checks: {},
};

function redact(value) {
  return String(value).replace(/(PYTHON_API_URL|SONGFORMER_API_URL|SHEETSAGE_API_URL|CHORDMINI_READY_TOKEN|CHORDMINI_DESKTOP_COOKIE|FIREBASE_SERVICE_ACCOUNT_KEY|GEMINI_API_KEY|GENIUS_API_KEY|MUSIC_AI_API_KEY|CRON_SECRET)=([^\s]+)/gi, '$1=[redacted]');
}

function writeReport() {
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, 'packaged-report.json'), `${JSON.stringify(report, null, 2)}\n`);
}

function record(name, pass, detail) {
  report.checks[name] = { pass, ...detail };
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runCommand(command) {
  const result = spawnSync(command, {
    shell: true,
    stdio: 'inherit',
    windowsHide: true,
    timeout: 180000,
  });
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status}): ${command}`);
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
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    request.setTimeout(5000, () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    request.end();
  });
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`process did not exit within ${timeoutMs}ms`));
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

function findInstaller() {
  const output = path.join(repoRoot, 'desktop-dist');
  const matches = fs.readdirSync(output).filter((name) => name.endsWith('-x64.exe') && name.includes('Setup'));
  if (matches.length !== 1) {
    throw new Error(`Expected one NSIS installer in desktop-dist, found ${matches.join(', ') || 'none'}.`);
  }
  return path.join(output, matches[0]);
}

function uninstall() {
  const uninstaller = path.join(installDir, 'Uninstall ChordMini.exe');
  if (!fs.existsSync(uninstaller)) {
    return !fs.existsSync(path.join(installDir, 'ChordMini.exe'));
  }
  const result = spawnSync(`"${uninstaller}" /S`, {
    shell: true,
    stdio: 'inherit',
    windowsHide: true,
    timeout: 180000,
  });
  return result.status === 0 && !fs.existsSync(path.join(installDir, 'ChordMini.exe'));
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
  runCommand(`"${installer}" /S /D=${installDir}`);
  const installedExe = path.join(installDir, 'ChordMini.exe');
  record('install', fs.existsSync(installedExe), {
    installDir,
    pathHasSpace: installDir.includes(' '),
  });
  if (!fs.existsSync(installedExe)) {
    throw new Error('The installer did not produce ChordMini.exe.');
  }

  const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  const pidFile = path.join(artifactDir, 'owned-server.pid');
  const launchEnv = {
    ...process.env,
    CHORDMINI_DESKTOP_ACCEPTANCE: '1',
    CHORDMINI_DESKTOP_PID_FILE: pidFile,
  };
  delete launchEnv.PYTHON_API_URL;
  const { _electron: electron } = require('playwright-core');
  let electronApp = null;
  try {
    electronApp = await electron.launch({
      executablePath: installedExe,
      cwd: installDir,
      env: launchEnv,
      timeout: 120000,
    });
    const window = await electronApp.firstWindow({ timeout: 120000 });
    await window.waitForSelector('text=Open source chord & beat detection application.', { timeout: 45000 });
    await window.waitForSelector('text=Piano Visualizer', { timeout: 20000 });
    await window.waitForSelector('text=Beat & Chord Analysis & Lyrics', { timeout: 20000 });
    const pageUrl = new URL(window.url());
    await window.screenshot({ path: path.join(artifactDir, 'packaged-homepage.png') });
    const assets = await window.evaluate(async () => {
      const logo = await fetch('/chordMiniLogo.webp');
      const script = [...document.scripts].map((item) => item.src).find((src) => src.includes('/_next/static/'));
      const staticResponse = script ? await fetch(script) : null;
      return {
        logoStatus: logo.status,
        staticStatus: staticResponse ? staticResponse.status : 0,
        pianoText: document.body.innerText.includes('Piano Visualizer'),
        chordGridText: document.body.innerText.includes('Beat & Chord Analysis & Lyrics'),
      };
    });
    record('windowRender', pageUrl.hostname === '127.0.0.1', { origin: pageUrl.origin });
    record('staticAssets', assets.logoStatus === 200 && assets.staticStatus === 200, assets);
    record('musicUi', assets.pianoText && assets.chordGridText, {
      pianoVisualizer: assets.pianoText,
      chordGrid: assets.chordGridText,
      analysisInvoked: false,
    });

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

    const security = await electronApp.evaluate(async ({ BrowserWindow }) => {
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
    });
    record('security', Boolean(security) && security.nodeIntegration === false && security.contextIsolation && security.sandbox && security.webSecurity && security.preload === false, {
      prefs: security,
    });

    await window.goto(`${pageUrl.origin}/analyze`);
    await window.waitForSelector('text=Choose Audio File', { timeout: 30000 });
    const audioFile = path.join(artifactDir, 'acceptance-tone.wav');
    writeWav(audioFile);
    await window.locator('input[type="file"]').setInputFiles(audioFile);
    await window.waitForSelector('text=acceptance-tone.wav', { timeout: 10000 });
    await window.screenshot({ path: path.join(artifactDir, 'packaged-audio.png') });
    record('audioInput', true, { filename: 'acceptance-tone.wav', analysisInvoked: false });

    const serverPid = Number(fs.readFileSync(pidFile, 'utf8'));
    const second = spawn(installedExe, [], {
      cwd: installDir,
      env: launchEnv,
      windowsHide: true,
      stdio: 'ignore',
    });
    const secondCode = await waitForExit(second, 30000);
    const windowCount = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    record('singleInstance', secondCode === 0 && windowCount === 1, { secondExitCode: secondCode, windowCount });

    const electronPid = electronApp.process().pid;
    await electronApp.close();
    electronApp = null;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && (isAlive(electronPid) || isAlive(serverPid))) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    record('processCleanup', !isAlive(serverPid) && isAlive(sentinel.pid), {
      serverPid,
      serverAlive: isAlive(serverPid),
      sentinelPid: sentinel.pid,
      sentinelAlive: isAlive(sentinel.pid),
    });
  } finally {
    if (electronApp) {
      await electronApp.close().catch(() => undefined);
    }
    if (sentinel.pid && isAlive(sentinel.pid)) {
      spawnSync('taskkill', ['/PID', String(sentinel.pid), '/T', '/F'], { windowsHide: true });
    }
    const removed = uninstall();
    record('uninstall', removed, { executableRemains: fs.existsSync(installedExe) });
    const failed = Object.values(report.checks).some((check) => check.pass === false);
    report.status = failed ? 'FAIL' : 'PASS';
    writeReport();
  }
}

main().catch((error) => {
  report.status = report.status === 'NOT_RUN' ? report.status : 'FAIL';
  report.error = redact(error && error.stack ? error.stack : error);
  try {
    uninstall();
  } catch {
    // The report still records the launch failure.
  }
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
