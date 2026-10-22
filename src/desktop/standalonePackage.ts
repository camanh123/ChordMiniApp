import { spawn, spawnSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { shouldCopyAsset } from './prepareStandalone';

/**
 * Modules server.js loads before it can listen. Transitive imports are checked
 * by actually loading these two entry points.
 */
export const STANDALONE_RUNTIME_MODULES = [
  'next',
  'next/dist/server/lib/start-server',
] as const;

export interface RuntimeModuleResolution {
  id: string;
  relativePath: string;
}

const RESOLVE_SCRIPT = `
const { createRequire } = require('module');
const path = require('path');
const server = process.argv[2];
const root = path.resolve(path.dirname(server));
const req = createRequire(server);
const ids = ${JSON.stringify(STANDALONE_RUNTIME_MODULES)};
for (const id of ids) {
  let resolved;
  try {
    resolved = path.resolve(req.resolve(id));
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    process.stderr.write('MODULE_NOT_FOUND ' + id + '\\n' + message + '\\n');
    process.exit(1);
  }
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    process.stderr.write('RESOLVED_OUTSIDE ' + id + ' ' + resolved + '\\n');
    process.exit(2);
  }
  try {
    req(id);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    process.stderr.write('MODULE_LOAD_FAILED ' + id + '\\n' + message + '\\n');
    process.exit(3);
  }
  process.stdout.write('OK\\t' + id + '\\t' + relative.split(path.sep).join('/') + '\\n');
}
`;

export function pathIsInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Copy a Next standalone directory as real files. Symlinks and Windows
 * junctions are followed so the package does not point back at the checkout.
 */
export function materializeStandaloneDirectory(sourceDir: string, destinationDir: string): void {
  fs.rmSync(destinationDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destinationDir), { recursive: true });
  fs.cpSync(sourceDir, destinationDir, {
    recursive: true,
    force: true,
    dereference: true,
    filter: (source) => shouldCopyAsset(source, sourceDir),
  });
}

export function findExternalModuleLinks(standaloneDir: string): Array<{ path: string; target: string }> {
  const modulesDir = path.join(standaloneDir, 'node_modules');
  if (!fs.existsSync(modulesDir)) {
    return [];
  }
  const found: Array<{ path: string; target: string }> = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        let target = '';
        try {
          target = fs.realpathSync(fullPath);
        } catch {
          target = fs.readlinkSync(fullPath);
        }
        if (!pathIsInside(standaloneDir, target)) {
          found.push({ path: path.relative(standaloneDir, fullPath), target });
        }
        continue;
      }
      if (entry.isDirectory()) {
        visit(fullPath);
      }
    }
  };
  visit(modulesDir);
  return found;
}

function runtimeChildEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
  for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'PATHEXT', 'ComSpec', 'COMSPEC']) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

function missingNextMessage(standaloneDir: string): string {
  const nextDir = path.join(standaloneDir, 'node_modules', 'next');
  let detail = 'node_modules/next/package.json is not a real file in this tree.';
  try {
    const stat = fs.lstatSync(nextDir);
    if (stat.isSymbolicLink()) {
      detail = `node_modules/next is a link to ${fs.readlinkSync(nextDir)}, outside the packaged tree.`;
    }
  } catch {
    detail = 'node_modules/next is absent. electron-builder drops a node_modules directory that is the root of an extraResources source, so the standalone tree must be copied from its parent directory.';
  }
  return `Packaged Next.js runtime is missing from ${standaloneDir}. ${detail}`;
}

/**
 * Resolve and load the standalone server's runtime from a temporary copy whose
 * parents cannot supply the repository node_modules.
 */
export function verifyStandaloneResolution(standaloneDir: string): RuntimeModuleResolution[] {
  const serverEntry = path.join(standaloneDir, 'server.js');
  if (!fs.existsSync(serverEntry)) {
    throw new Error(`Standalone server.js is missing in ${standaloneDir}.`);
  }
  const nextPackage = path.join(standaloneDir, 'node_modules', 'next', 'package.json');
  let nextStat: fs.Stats | null = null;
  try {
    nextStat = fs.lstatSync(nextPackage);
  } catch {
    nextStat = null;
  }
  if (!nextStat || !nextStat.isFile()) {
    throw new Error(missingNextMessage(standaloneDir));
  }

  const external = findExternalModuleLinks(standaloneDir);
  if (external.length > 0) {
    const sample = external.slice(0, 5).map((entry) => `${entry.path} -> ${entry.target}`).join('; ');
    throw new Error(`Standalone node_modules contains ${external.length} link(s) outside the package (${sample}). Dereference those links while staging.`);
  }

  const isolatedParent = fs.mkdtempSync(path.join(os.tmpdir(), 'chordmini-runtime-'));
  const isolated = path.join(isolatedParent, 'standalone');
  try {
    fs.mkdirSync(isolated, { recursive: true });
    fs.copyFileSync(serverEntry, path.join(isolated, 'server.js'));
    const packageJson = path.join(standaloneDir, 'package.json');
    if (fs.existsSync(packageJson)) {
      fs.copyFileSync(packageJson, path.join(isolated, 'package.json'));
    }
    fs.cpSync(path.join(standaloneDir, 'node_modules'), path.join(isolated, 'node_modules'), {
      recursive: true,
      dereference: true,
    });
    const scriptPath = path.join(isolatedParent, 'resolve-standalone.cjs');
    fs.writeFileSync(scriptPath, RESOLVE_SCRIPT);
    const result = spawnSync(process.execPath, [scriptPath, path.join(isolated, 'server.js')], {
      cwd: isolatedParent,
      env: runtimeChildEnv(),
      encoding: 'utf8',
      timeout: 120000,
      windowsHide: true,
    });
    if (result.status !== 0) {
      const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim().slice(0, 2000);
      throw new Error(`Standalone module resolution failed for ${standaloneDir}. ${output || `exit ${result.status}`}`);
    }
    const resolutions: RuntimeModuleResolution[] = [];
    for (const line of String(result.stdout || '').split(/\r?\n/)) {
      const match = /^OK\t([^\t]+)\t([^\t]+)$/.exec(line.trim());
      if (match) {
        resolutions.push({ id: match[1], relativePath: match[2] });
      }
    }
    for (const id of STANDALONE_RUNTIME_MODULES) {
      if (!resolutions.some((entry) => entry.id === id)) {
        throw new Error(`Standalone module resolution did not report ${id} inside ${standaloneDir}.`);
      }
    }
    return resolutions;
  } finally {
    fs.rmSync(isolatedParent, { recursive: true, force: true });
  }
}

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function stopChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (!child.pid || child.exitCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      if (process.platform === 'win32' && child.pid) {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        try {
          child.kill('SIGKILL');
        } catch {
          // The process already exited.
        }
      }
    }, 2000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill();
    } catch {
      clearTimeout(timer);
      resolve();
      return;
    }
    if (child.exitCode !== null) {
      clearTimeout(timer);
      resolve();
    }
  });
}

export interface StandaloneBootResult {
  port: number;
  loopback: true;
}

/**
 * Start server.js from an isolated copy and accept only a loopback listener.
 * MODULE_NOT_FOUND fails immediately. The child is stopped before returning.
 */
export async function bootStandaloneServer(standaloneDir: string, timeoutMs = 90000): Promise<StandaloneBootResult> {
  const isolatedParent = fs.mkdtempSync(path.join(os.tmpdir(), 'chordmini-boot-'));
  const isolated = path.join(isolatedParent, 'standalone');
  let child: ChildProcess | null = null;
  try {
    materializeStandaloneDirectory(standaloneDir, isolated);
    const port = await freeLoopbackPort();
    const stderr: Buffer[] = [];
    child = spawn(process.execPath, [path.join(isolated, 'server.js')], {
      cwd: isolated,
      env: runtimeChildEnv({
        PORT: String(port),
        HOSTNAME: '127.0.0.1',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.stdout?.on('data', () => {
      // Next.js startup logs are not required for the listen check.
    });
    const started = Date.now();
    let exitCode: number | null = null;
    child.once('exit', (code) => {
      exitCode = code;
    });
    while (Date.now() - started < timeoutMs) {
      const errorText = Buffer.concat(stderr).toString('utf8');
      if (errorText.includes('MODULE_NOT_FOUND') || errorText.includes("Cannot find module")) {
        throw new Error(`Standalone server.js could not start from ${standaloneDir}. ${errorText.slice(0, 2000)}`);
      }
      if (exitCode !== null) {
        throw new Error(`Standalone server.js exited ${exitCode} before listening. ${errorText.slice(0, 2000)}`);
      }
      const open = await new Promise<boolean>((resolve) => {
        const socket = net.connect({ host: '127.0.0.1', port }, () => {
          socket.end();
          resolve(true);
        });
        socket.once('error', () => resolve(false));
      });
      if (open) {
        return { port, loopback: true };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Standalone server.js did not listen on 127.0.0.1 within ${timeoutMs}ms. ${Buffer.concat(stderr).toString('utf8').slice(0, 2000)}`);
  } finally {
    if (child) {
      await stopChild(child);
    }
    fs.rmSync(isolatedParent, { recursive: true, force: true });
  }
}
