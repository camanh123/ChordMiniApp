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
  'packagedDependencies',
  'windowRender',
  'staticAssets',
  'musicUi',
  'serverStartup',
  'security',
  'audioInput',
  'localPlayback',
  'analysisService',
  'settingsPersistence',
  'localePersistence',
  'localGame',
  'singleInstance',
  'processCleanup',
  'uninstall',
  'applicationLaunch',
  'playwrightConnection',
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
    const names = fs.existsSync(installDir) ? fs.readdirSync(installDir) : [];
    return {
      removed: !fs.existsSync(installedExe),
      exitCode: null,
      uninstallerFound: false,
      executables: names.filter((name) => name.toLowerCase().endsWith('.exe')).slice(0, 20),
    };
  }
  assertNoShellMeta(uninstaller, 'Uninstaller path');
  assertNoShellMeta(installDir, 'Install directory');
  // NSIS copies the uninstaller to %TEMP% and the process we spawn exits before
  // files are deleted. _?= disables that copy and must stay last and unquoted,
  // including the space in the install directory.
  const command = `"${uninstaller.replace(/"/g, '')}" /S _?=${installDir}`;
  const child = spawn(command, { shell: true, stdio: 'inherit', windowsHide: true });
  owned.uninstallerPid = child.pid ?? null;
  try {
    const code = await waitForExit(child, 180000, 'uninstall');
    owned.uninstallerPid = null;
    let remains = fs.existsSync(installedExe);
    const deadline = Date.now() + (code === 0 && remains ? 10000 : 0);
    while (remains && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      remains = fs.existsSync(installedExe);
    }
    return {
      removed: code === 0 && !remains,
      exitCode: code,
      uninstallerFound: true,
      executableRemains: remains,
    };
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
          headers: response.headers,
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
  const samples = sampleRate * 2;
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
      record('uninstall', removed.removed, {
        ...removed,
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

function runPowershell(script, timeoutMs = 20000) {
  fs.mkdirSync(artifactDir, { recursive: true });
  const file = path.join(artifactDir, `probe-${process.pid}-${Date.now()}.ps1`);
  fs.writeFileSync(file, script);
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', file], {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(redact(result.stderr || 'PowerShell failed').slice(0, 500));
    }
    return result.stdout || '';
  } finally {
    fs.rmSync(file, { force: true });
  }
}

function descendantPids(rootPid, processes) {
  const children = new Map();
  for (const entry of processes) {
    const parent = Number(entry.ParentProcessId);
    const pid = Number(entry.ProcessId);
    if (!Number.isInteger(parent) || !Number.isInteger(pid)) {
      continue;
    }
    const list = children.get(parent) || [];
    list.push(pid);
    children.set(parent, list);
  }
  const found = new Set([rootPid]);
  const stack = [...(children.get(rootPid) || [])];
  while (stack.length > 0) {
    const pid = stack.pop();
    if (!Number.isInteger(pid) || found.has(pid)) {
      continue;
    }
    found.add(pid);
    stack.push(...(children.get(pid) || []));
  }
  return found;
}

function readProcessTable() {
  const stdout = runPowershell('Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress');
  const parsed = JSON.parse(stdout || '[]');
  return Array.isArray(parsed) ? parsed : [parsed];
}

function visibleWindows() {
  const stdout = runPowershell(`
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ChordMiniWin {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  public static string Dump() {
    var sb = new StringBuilder();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      var title = new StringBuilder(512);
      GetWindowText(h, title, title.Capacity);
      if (title.Length == 0) return true;
      sb.Append(pid).Append('\\t').Append(h.ToInt64()).Append('\\t').Append(title.ToString().Replace('\\r', ' ').Replace('\\n', ' ')).Append('\\n');
      return true;
    }, IntPtr.Zero);
    return sb.ToString();
  }
}
"@
[ChordMiniWin]::Dump()
`);
  return stdout.split(/\r?\n/).map((line) => {
    const [pid, hwnd, ...title] = line.split('\t');
    return {
      pid: Number(pid),
      hwnd: String(hwnd || ''),
      title: title.join('\t'),
    };
  }).filter((entry) => Number.isInteger(entry.pid) && /^[0-9]+$/.test(entry.hwnd) && entry.title);
}

function listeningSockets(pids) {
  const result = spawnSync('netstat', ['-ano', '-p', 'tcp'], {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
  const ports = [];
  const other = [];
  for (const line of String(result.stdout || '').split(/\r?\n/)) {
    const match = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line.trim());
    if (!match || !pids.has(Number(match[3]))) {
      continue;
    }
    if (match[1] === '127.0.0.1') {
      ports.push(Number(match[2]));
    } else {
      other.push(`${match[1]}:${match[2]}`);
    }
  }
  return { ports: [...new Set(ports)], other: [...new Set(other)] };
}

function cookieHeader(headers) {
  const raw = headers && headers['set-cookie'];
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return values.map((value) => String(value).split(';')[0]).join('; ');
}

async function probeLoopback(ports) {
  for (const port of ports) {
    try {
      const ready = await httpRequest({ hostname: '127.0.0.1', port, path: '/api/desktop/ready', method: 'GET' }, {
        'x-chordmini-nonce': 'packaged-direct',
      });
      let body = {};
      try {
        body = JSON.parse(ready.body);
      } catch {
        body = {};
      }
      if (ready.status !== 200 || body.role !== 'next-standalone') {
        continue;
      }
      const home = await httpRequest({ hostname: '127.0.0.1', port, path: '/', method: 'GET' }, {
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Site': 'none',
      });
      const cookie = cookieHeader(home.headers);
      const logo = await httpRequest({ hostname: '127.0.0.1', port, path: '/chordMiniLogo.webp', method: 'GET' }, {
        Cookie: cookie,
      });
      const analyze = await httpRequest({ hostname: '127.0.0.1', port, path: '/analyze', method: 'GET' }, {
        Cookie: cookie,
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Site': 'same-origin',
      });
      return {
        port,
        readyStatus: ready.status,
        role: body.role,
        homeStatus: home.status,
        pianoText: home.body.includes('Piano trực quan'),
        chordGridText: home.body.includes('Phân tích nhịp, hợp âm và lời'),
        logoStatus: logo.status,
        analyzeStatus: analyze.status,
        analyzeFileInput: analyze.body.includes('Chọn tệp âm thanh'),
      };
    } catch {
      // Another owned listener is not the Next server.
    }
  }
  return null;
}

function readRedacted(file, max = 4000) {
  if (!fs.existsSync(file)) {
    return '';
  }
  const text = redact(fs.readFileSync(file, 'utf8')).slice(0, max);
  fs.writeFileSync(file, text);
  return text;
}

async function observeUserLaunch(child, pidFile, diagnosticFile, logFile) {
  const deadline = Date.now() + 60000;
  let snapshot = {
    processAlive: isAlive(child.pid),
    windows: [],
    ports: [],
    otherBinds: [],
    server: null,
    serverPid: null,
    diagnostic: '',
  };
  while (Date.now() < deadline) {
    snapshot.processAlive = isAlive(child.pid);
    try {
      const processes = readProcessTable();
      const ownedPids = descendantPids(child.pid, processes);
      const windows = visibleWindows().filter((entry) => ownedPids.has(entry.pid));
      const sockets = listeningSockets(ownedPids);
      const server = await probeLoopback(sockets.ports);
      snapshot = {
        processAlive: snapshot.processAlive,
        windows,
        ports: sockets.ports,
        otherBinds: sockets.other,
        server,
        serverPid: fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : null,
        diagnostic: readRedacted(diagnosticFile, 1000),
      };
    } catch (error) {
      snapshot.observeError = redact(error instanceof Error ? error.message : error).slice(0, 400);
    }
    const titleReady = snapshot.windows.some((entry) => /chordmini/i.test(entry.title));
    if ((titleReady && snapshot.server) || snapshot.diagnostic || !snapshot.processAlive) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  snapshot.logExcerpt = readRedacted(logFile, 2500);
  return snapshot;
}

function packagedRuntimeProbe(installedExe) {
  const standalone = path.join(installDir, 'resources', 'standalone');
  const serverJs = path.join(standalone, 'server.js');
  const nextPackage = path.join(standalone, 'node_modules', 'next', 'package.json');
  const detail = {
    serverExists: fs.existsSync(serverJs),
    nextPackage,
  };
  if (!detail.serverExists || !fs.existsSync(nextPackage)) {
    return { pass: false, reason: 'missing-file', ...detail };
  }
  const nextStat = fs.lstatSync(nextPackage);
  if (!nextStat.isFile()) {
    return { pass: false, reason: 'next-package-json-not-a-file', ...detail };
  }
  const probe = path.join(artifactDir, 'resolve-packaged-next.cjs');
  fs.writeFileSync(probe, `
const { createRequire } = require('module');
const path = require('path');
const server = process.argv[2];
const root = path.resolve(path.dirname(server));
const req = createRequire(server);
for (const id of ['next', 'next/dist/server/lib/start-server']) {
  let resolved;
  try {
    resolved = path.resolve(req.resolve(id));
  } catch (error) {
    process.stderr.write('MODULE_NOT_FOUND ' + id + '\\n' + (error && error.message ? error.message : error) + '\\n');
    process.exit(1);
  }
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    process.stderr.write('RESOLVED_OUTSIDE ' + id + ' ' + resolved + '\\n');
    process.exit(2);
  }
  req(id);
  process.stdout.write('OK\\t' + id + '\\t' + relative + '\\n');
}
`);
  const env = { ELECTRON_RUN_AS_NODE: '1' };
  for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'PATHEXT', 'ComSpec', 'COMSPEC']) {
    if (process.env[key]) {
      env[key] = process.env[key];
    }
  }
  const result = spawnSync(installedExe, [probe, serverJs], {
    cwd: artifactDir,
    env,
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim().slice(0, 1500);
  return {
    pass: result.status === 0 && output.includes('OK\tnext'),
    status: result.status,
    output,
    ...detail,
  };
}

function closeOwnedWindows(hwnds) {
  const handles = hwnds.filter((value) => /^[0-9]+$/.test(String(value)));
  if (handles.length === 0) {
    return;
  }
  runPowershell(`
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class ChordMiniClose {
  [DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr hWnd, uint msg, System.IntPtr wParam, System.IntPtr lParam);
  public static void Close(long[] hwnds) {
    foreach (var value in hwnds) PostMessage(new System.IntPtr(value), 0x0010, System.IntPtr.Zero, System.IntPtr.Zero);
  }
}
"@
[ChordMiniClose]::Close(@(${handles.join(',')}))
`);
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
  progress('packaged-dependencies-start');
  const dependencies = packagedRuntimeProbe(installedExe);
  record('packagedDependencies', dependencies.pass, dependencies);
  progress('packaged-dependencies-finished', { pass: dependencies.pass });
  if (!dependencies.pass) {
    throw new Error(`Installed standalone cannot resolve next. ${dependencies.output || dependencies.reason || ''}`);
  }

  const sentinel = startProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  owned.sentinelPid = sentinel.pid ?? null;
  const pidFile = path.join(artifactDir, 'owned-server.pid');
  const diagnosticFile = path.join(artifactDir, 'startup-failure.txt');
  const launchLog = path.join(artifactDir, 'packaged-process.log');
  const launchEnv = {
    ...process.env,
    CHORDMINI_DESKTOP_ACCEPTANCE: '1',
    CHORDMINI_DESKTOP_PID_FILE: pidFile,
    CHORDMINI_DESKTOP_DIAGNOSTIC_FILE: diagnosticFile,
    CHORDMINI_SKIP_ERROR_DIALOG: '1',
  };
  delete launchEnv.PYTHON_API_URL;
  delete launchEnv.NODE_OPTIONS;
  delete launchEnv.ELECTRON_RUN_AS_NODE;
  report.installedExe = installedExe;
  progress('direct-launch-start', { executable: installedExe });
  const logFd = fs.openSync(launchLog, 'w');
  const directChild = spawn(installedExe, [], {
    cwd: installDir,
    env: launchEnv,
    stdio: ['ignore', logFd, logFd],
    windowsHide: false,
  });
  fs.closeSync(logFd);
  owned.electronPid = directChild.pid ?? null;
  const direct = await observeUserLaunch(directChild, pidFile, diagnosticFile, launchLog);
  owned.serverPid = Number.isInteger(direct.serverPid) ? direct.serverPid : null;
  report.directLaunch = {
    electronPid: owned.electronPid,
    processAlive: direct.processAlive,
    windows: direct.windows.map((entry) => ({ pid: entry.pid, title: entry.title })),
    ports: direct.ports,
    serverPid: direct.serverPid,
    server: direct.server ? {
      port: direct.server.port,
      readyStatus: direct.server.readyStatus,
      role: direct.server.role,
      homeStatus: direct.server.homeStatus,
      logoStatus: direct.server.logoStatus,
      pianoText: direct.server.pianoText,
      chordGridText: direct.server.chordGridText,
      analyzeStatus: direct.server.analyzeStatus,
      analyzeFileInput: direct.server.analyzeFileInput,
    } : null,
    diagnostic: direct.diagnostic,
    logExcerpt: direct.logExcerpt,
    observeError: direct.observeError || '',
  };
  const windowSeen = direct.windows.some((entry) => /chordmini/i.test(entry.title));
  record('applicationLaunch', direct.processAlive && (windowSeen || Boolean(direct.server)), {
    processAlive: direct.processAlive,
    windowCount: direct.windows.length,
    serverReady: Boolean(direct.server),
  });
  record('windowRender', windowSeen, {
    source: 'win32',
    titles: direct.windows.map((entry) => entry.title),
  });
  record('serverStartup', Boolean(direct.server) && direct.otherBinds.length === 0, direct.server ? {
    status: direct.server.readyStatus,
    role: direct.server.role,
    port: direct.server.port,
    otherBinds: direct.otherBinds,
    analyzeStatus: direct.server.analyzeStatus,
    analyzeFileInput: direct.server.analyzeFileInput,
    source: 'loopback-listen',
  } : { source: 'loopback-listen', otherBinds: direct.otherBinds });
  if (direct.server) {
    record('staticAssets', direct.server.homeStatus === 200 && direct.server.logoStatus === 200, {
      homeStatus: direct.server.homeStatus,
      logoStatus: direct.server.logoStatus,
      source: 'loopback-http',
    });
    record('musicUi', direct.server.pianoText && direct.server.chordGridText, {
      pianoVisualizer: direct.server.pianoText,
      chordGrid: direct.server.chordGridText,
      analysisInvoked: false,
      source: 'server-html',
    });
  }
  progress('direct-launch-finished', {
    processAlive: direct.processAlive,
    windows: direct.windows.length,
    server: Boolean(direct.server),
  });

  if (direct.processAlive) {
    progress('single-instance-start', { serverPid: owned.serverPid });
    const second = startProcess(installedExe, [], { cwd: installDir, env: launchEnv });
    owned.secondPid = second.pid ?? null;
    try {
      const secondCode = await waitForExit(second, 20000, 'second-instance');
      owned.secondPid = null;
      const after = visibleWindows().filter((entry) => entry.pid === owned.electronPid || (owned.serverPid && entry.pid === owned.serverPid));
      record('singleInstance', secondCode === 0 && direct.windows.length >= 1 && after.length <= direct.windows.length, {
        secondExitCode: secondCode,
        windowTitles: after.map((entry) => entry.title),
      });
    } catch (error) {
      killOwnedPid(owned.secondPid);
      owned.secondPid = null;
      record('singleInstance', false, { error: redact(error instanceof Error ? error.message : error) });
    }
    progress('single-instance-finished', { pass: report.checks.singleInstance?.pass === true });
  }

  progress('shutdown-start', { electronPid: owned.electronPid, serverPid: owned.serverPid });
  try {
    closeOwnedWindows(direct.windows.map((entry) => entry.hwnd));
  } catch (error) {
    report.shutdownError = redact(error instanceof Error ? error.message : error);
  }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && (isAlive(owned.electronPid) || isAlive(owned.serverPid))) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (isAlive(owned.electronPid) || isAlive(owned.serverPid)) {
    report.shutdownError = report.shutdownError || 'WM_CLOSE did not stop the owned processes';
    killOwnedPid(owned.electronPid);
    killOwnedPid(owned.serverPid);
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

  const directReady = windowSeen && Boolean(direct.server);
  report.launchClassification = !direct.processAlive || direct.diagnostic
    ? 'A'
    : directReady
      ? 'DIRECT_OK'
      : 'C';
  if (!directReady) {
    record('playwrightConnection', false, {
      skipped: true,
      reason: 'The installed executable did not show a ChordMini window and a loopback Next server.',
    });
    progress('playwright-launch-finished', { connected: false, skipped: true });
  } else {
    const { _electron: electron } = require('playwright-core');
    progress('playwright-launch-start');
    try {
      owned.electronApp = await withTimeout('electron-launch', 70000, () => electron.launch({
        executablePath: installedExe,
        cwd: installDir,
        env: launchEnv,
        timeout: 45000,
      }));
      owned.electronPid = owned.electronApp.process().pid;
      owned.serverPid = null;
      record('playwrightConnection', true, { electronPid: owned.electronPid });
      report.launchClassification = 'APP_AND_PLAYWRIGHT_OK';
      progress('launch-finished', { electronPid: owned.electronPid });
    } catch (error) {
      report.launchClassification = 'B';
      record('playwrightConnection', false, {
        error: redact(error instanceof Error ? error.message : error).slice(0, 800),
      });
      progress('playwright-launch-finished', { connected: false });
    }
  }
  if (owned.electronApp) {
    const directCleanupPassed = report.checks.processCleanup?.pass === true;
    try {
      progress('window-wait');
      const window = await owned.electronApp.firstWindow({ timeout: 30000 });
      await window.waitForSelector('text=Ứng dụng mã nguồn mở nhận diện hợp âm và nhịp.', { timeout: 45000 });
      await window.waitForSelector('text=Piano trực quan', { timeout: 20000 });
      await window.waitForSelector('text=Phân tích nhịp, hợp âm và lời', { timeout: 20000 });
      const freshLocale = await window.evaluate(() => document.documentElement.lang);
      const pageUrl = new URL(window.url());
      progress('window-ready', { origin: pageUrl.origin });
      await withTimeout('homepage-screenshot', 20000, () => window.screenshot({
        path: path.join(artifactDir, 'packaged-homepage.png'),
      }));
      await withTimeout('homepage-vi-screenshot', 20000, () => window.screenshot({
        path: path.join(artifactDir, 'packaged-homepage-vi.png'),
      }));

      progress('assets-start');
      const assets = await withTimeout('static-assets', 20000, () => window.evaluate(async () => {
        const logo = await fetch('/chordMiniLogo.webp', { signal: AbortSignal.timeout(8000) });
        const script = [...document.scripts].map((item) => item.src).find((src) => src.includes('/_next/static/'));
        const staticResponse = script ? await fetch(script, { signal: AbortSignal.timeout(8000) }) : null;
        return {
          logoStatus: logo.status,
          staticStatus: staticResponse ? staticResponse.status : 0,
          pianoText: document.body.innerText.includes('Piano trực quan'),
          chordGridText: document.body.innerText.includes('Phân tích nhịp, hợp âm và lời'),
          locale: document.documentElement.lang,
        };
      }));
      record('windowRender', pageUrl.hostname === '127.0.0.1', {
        source: 'playwright',
        origin: pageUrl.origin,
        win32Titles: direct.windows.map((entry) => entry.title),
      });
      record('staticAssets', assets.logoStatus === 200 && assets.staticStatus === 200, assets);
      record('musicUi', assets.pianoText && assets.chordGridText && freshLocale === 'vi-VN' && assets.locale === 'vi-VN', {
        pianoVisualizer: assets.pianoText,
        chordGrid: assets.chordGridText,
        analysisInvoked: false,
        source: 'playwright',
      });
      progress('assets-finished', {
        logoStatus: assets.logoStatus,
        staticStatus: assets.staticStatus,
      });

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
      await window.waitForSelector('text=Chọn tệp âm thanh', { timeout: 30000 });
      const audioFile = path.join(artifactDir, 'acceptance-tone.wav');
      writeWav(audioFile);
      await withTimeout('audio-file-selection', 20000, () => window.locator('input[type="file"]').setInputFiles(audioFile));
      await window.waitForSelector('text=acceptance-tone.wav', { timeout: 10000 });
      record('audioInput', true, { filename: 'acceptance-tone.wav', decodedBy: 'file-input' });
      progress('audio-finished');

      try {
        progress('local-playback-start');
        await window.waitForSelector('button[aria-label="Phát"]', { timeout: 15000 });
        await window.locator('button[aria-label="Phát"]').click();
        await window.waitForFunction(() => {
          const audio = document.querySelector('audio');
          return Boolean(audio && Number.isFinite(audio.duration) && audio.duration > 1 && audio.currentTime > 0.3);
        }, undefined, { timeout: 8000 });
        await window.locator('[data-testid="playback-speed"]').click();
        const faster = window.locator('[data-playback-rate="1.5"]');
        await faster.waitFor({ state: 'visible', timeout: 5000 });
        await faster.click();
        const rateApplied = await window.waitForFunction(() => {
          const audio = document.querySelector('audio');
          return Boolean(audio && Math.abs(audio.playbackRate - 1.5) < 0.01);
        }, undefined, { timeout: 2500 }).then(() => true).catch(() => false);
        if (!rateApplied) {
          await faster.evaluate((node) => node.click());
          await window.waitForFunction(() => {
            const audio = document.querySelector('audio');
            return Boolean(audio && Math.abs(audio.playbackRate - 1.5) < 0.01);
          }, undefined, { timeout: 5000 });
        }
        const beforeSeek = await window.evaluate(() => document.querySelector('audio')?.currentTime ?? 0);
        await window.getByRole('slider', { name: 'Vị trí phát' }).focus();
        await window.keyboard.press('Home');
        await window.waitForFunction((previous) => {
          const audio = document.querySelector('audio');
          return Boolean(audio && audio.currentTime + 0.05 < previous);
        }, beforeSeek, { timeout: 5000 });
        const playback = await window.evaluate(() => {
          const audio = document.querySelector('audio');
          return {
            currentTime: audio?.currentTime ?? null,
            duration: audio?.duration ?? null,
            playbackRate: audio?.playbackRate ?? null,
            paused: audio?.paused ?? null,
          };
        });
        await window.screenshot({ path: path.join(artifactDir, 'packaged-playback.png') });
        record('localPlayback', playback.currentTime > 0 && playback.duration > 1 && Math.abs(playback.playbackRate - 1.5) < 0.01 && playback.currentTime + 0.05 < beforeSeek, playback);
      } catch (error) {
        record('localPlayback', false, { error: redact(error instanceof Error ? error.message : error).slice(0, 500) });
      }
      progress('local-playback-finished', { pass: report.checks.localPlayback?.pass === true });

      try {
        progress('analysis-service-start');
        // The navigation link has the same accessible name and renders as role=button.
        await window.locator('button').filter({ hasText: 'Phân tích âm thanh' }).click();
        await window.waitForSelector('text=/Thiếu cấu hình dịch vụ bắt buộc|Dịch vụ phân tích không khả dụng/', { timeout: 20000 });
        const analysis = await window.evaluate(() => {
          const diagnostics = document.querySelector('[data-testid="analysis-diagnostics"]')?.textContent || '';
          const error = document.querySelector('[data-testid="analysis-diagnostics"]')?.parentElement?.innerText || '';
          return { error, diagnostics };
        });
        const leaked = /localhost:\d+|127\.0\.0\.1:\d+|https?:\/\//i.test(`${analysis.error}\n${analysis.diagnostics}`);
        await window.screenshot({ path: path.join(artifactDir, 'packaged-audio.png') });
        record('analysisService', !leaked && /Thiếu cấu hình dịch vụ bắt buộc|Dịch vụ phân tích không khả dụng/.test(analysis.error), {
          leakedAddress: leaked,
          diagnostics: analysis.diagnostics.slice(0, 400),
          mockedInference: false,
        });
      } catch (error) {
        record('analysisService', false, { error: redact(error instanceof Error ? error.message : error).slice(0, 500) });
      }
      progress('analysis-service-finished', { pass: report.checks.analysisService?.pass === true });

      try {
        progress('settings-start');
        await window.goto(`${pageUrl.origin}/settings`, { timeout: 30000 });
        await window.waitForSelector('text=Chế độ tối', { timeout: 20000 });
        const beforeTheme = await window.evaluate(() => localStorage.getItem('theme'));
        await window.getByRole('switch', { name: 'Chế độ tối' }).click();
        await window.waitForFunction((previous) => localStorage.getItem('theme') !== previous, beforeTheme, { timeout: 5000 });
        const nextTheme = await window.evaluate(() => localStorage.getItem('theme'));
        await window.getByRole('radio', { name: 'English' }).click();
        await window.waitForSelector('text=Dark Mode', { timeout: 10000 });
        await window.reload({ timeout: 30000 });
        await window.waitForSelector('text=Settings', { timeout: 20000 });
        const reloadedTheme = await window.evaluate(() => localStorage.getItem('theme'));
        const { _electron: electronAgain } = require('playwright-core');
        await withTimeout('settings-close', 20000, () => owned.electronApp.close());
        owned.electronApp = await withTimeout('settings-reopen', 70000, () => electronAgain.launch({
          executablePath: installedExe,
          cwd: installDir,
          env: launchEnv,
          timeout: 45000,
        }));
        owned.electronPid = owned.electronApp.process().pid;
        const reopened = await owned.electronApp.firstWindow({ timeout: 30000 });
        await reopened.waitForSelector('text=Open source chord & beat detection application.', { timeout: 45000 });
        const reopenedLocale = await reopened.evaluate(() => ({
          lang: document.documentElement.lang,
          cookie: document.cookie,
        }));
        record('localePersistence', reopenedLocale.lang === 'en-US' && reopenedLocale.cookie.includes('chordmini_locale=en-US'), {
          freshLocale,
          reopenedLocale,
          offlineDictionaries: true,
        });
        const reopenedOrigin = new URL(reopened.url()).origin;
        await reopened.goto(`${reopenedOrigin}/settings`, { timeout: 30000 });
        await reopened.waitForSelector('text=Settings', { timeout: 20000 });
        const reopenedTheme = await reopened.evaluate(() => localStorage.getItem('theme'));
        // Theme stays in localStorage, which Chromium scopes to the origin port.
        // A relaunch often binds a new 127.0.0.1 port, so the language cookie is
        // the cross-restart assertion. Theme is asserted on the same origin.
        record('settingsPersistence', Boolean(nextTheme) && reloadedTheme === nextTheme, {
          beforeTheme,
          nextTheme,
          reloadedTheme,
          reopenedTheme,
          themeSurvivesReload: reloadedTheme === nextTheme,
          themeSurvivesNewPort: reopenedTheme === nextTheme,
        });
        await reopened.goto(`${reopenedOrigin}/games`, { timeout: 30000 });
        await reopened.waitForSelector('text=Mini Games', { timeout: 20000 });
        await reopened.getByRole('button', { name: 'X/O' }).click();
        await reopened.waitForSelector('button[aria-label="Cell 1"]', { timeout: 10000 });
        await reopened.waitForFunction(() => (
          [...document.querySelectorAll('button[aria-label^="Cell "]')].some((button) => (
            button.getAttribute('aria-disabled') !== 'true' && !button.hasAttribute('disabled')
          ))
        ), undefined, { timeout: 8000 });
        const cells = reopened.locator('button[aria-label^="Cell "]');
        const cellCount = await cells.count();
        let clicked = false;
        for (let index = 0; index < cellCount; index += 1) {
          if (await cells.nth(index).isEnabled()) {
            await cells.nth(index).click();
            clicked = true;
            break;
          }
        }
        await reopened.waitForFunction(() => (
          [...document.querySelectorAll('button[aria-label^="Cell "]')]
            .some((button) => (button.textContent || '').includes('X'))
        ), undefined, { timeout: 8000 });
        record('localGame', clicked, { cellCount });
      } catch (error) {
        if (!report.checks.settingsPersistence) {
          record('settingsPersistence', false, { error: redact(error instanceof Error ? error.message : error).slice(0, 500) });
        }
        if (!report.checks.localePersistence) {
          record('localePersistence', false, { error: redact(error instanceof Error ? error.message : error).slice(0, 500) });
        }
        if (!report.checks.localGame) {
          record('localGame', false, { error: redact(error instanceof Error ? error.message : error).slice(0, 500) });
        }
      }
      progress('settings-finished', {
        settings: report.checks.settingsPersistence?.pass === true,
        game: report.checks.localGame?.pass === true,
      });
    } catch (error) {
      report.playwrightUiError = redact(error instanceof Error ? error.message : error).slice(0, 800);
      progress('playwright-ui-failed', { message: report.playwrightUiError.split('\n')[0] });
    }

    progress('playwright-shutdown-start', { electronPid: owned.electronPid });
    const app = owned.electronApp;
    owned.electronApp = null;
    if (fs.existsSync(pidFile)) {
      owned.serverPid = Number(fs.readFileSync(pidFile, 'utf8'));
    }
    if (app) {
      try {
        await withTimeout('electron-shutdown', 20000, () => app.close());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/target closed|has been closed|application exited/i.test(message)) {
          report.playwrightShutdownError = redact(message);
          killOwnedPid(owned.electronPid);
          killOwnedPid(owned.serverPid);
        }
      }
    }
    const playwrightDeadline = Date.now() + 15000;
    while (Date.now() < playwrightDeadline && (isAlive(owned.electronPid) || isAlive(owned.serverPid))) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (isAlive(owned.electronPid) || isAlive(owned.serverPid)) {
      report.playwrightShutdownError = report.playwrightShutdownError || 'Playwright close left an owned process';
      killOwnedPid(owned.electronPid);
      killOwnedPid(owned.serverPid);
    }
    record('processCleanup', directCleanupPassed && !isAlive(owned.electronPid) && !isAlive(owned.serverPid) && isAlive(owned.sentinelPid) && !report.playwrightShutdownError, {
      directCleanupPassed,
      electronAlive: isAlive(owned.electronPid),
      serverAlive: isAlive(owned.serverPid),
      sentinelAlive: isAlive(owned.sentinelPid),
      playwrightShutdownError: report.playwrightShutdownError || '',
    });
  }

  progress('uninstall-start');
  const removed = await uninstall();
  record('uninstall', removed.removed, {
    ...removed,
    executableRemains: fs.existsSync(installedExe),
  });
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
