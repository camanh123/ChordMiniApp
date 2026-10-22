import { execFile, spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { promisify } from 'util';
import { sanitizeDiagnostic } from './diagnostics';
import { createDesktopSecret, createReadyNonce, readyProofMatches } from './readyProof';

const execFileAsync = promisify(execFile);
const LOOPBACK_HOST = '127.0.0.1';

export interface OwnedChild {
  pid?: number;
  exitCode: number | null;
  killed: boolean;
  stderr: NodeJS.ReadableStream | null;
  stdout: NodeJS.ReadableStream | null;
  kill: (signal?: NodeJS.Signals) => boolean;
  unref?: () => void;
  on?: (event: string, listener: (error: unknown) => void) => void;
}

export interface OwnedServer {
  child: OwnedChild;
  port: number;
  origin: string;
  readyToken: string;
  cookieToken: string;
  stderrTail: string;
  stopped: boolean;
}

export interface StartOwnedServerOptions {
  serverEntry: string;
  command?: string;
  extraEnv?: NodeJS.ProcessEnv;
  parentEnv?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  intervalMs?: number;
  maxAttempts?: number;
  platform?: NodeJS.Platform;
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof spawn;
  allocatePort?: () => Promise<number>;
  graceMs?: number;
}

export type TerminationPlan =
  | { kind: 'taskkill'; command: 'taskkill'; args: string[] }
  | { kind: 'process-group'; signal: 'SIGTERM' };

export function terminationPlan(pid: number, platform: NodeJS.Platform): TerminationPlan {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) {
    throw new Error('Refusing to signal a process this shell does not own.');
  }

  if (platform === 'win32') {
    return {
      kind: 'taskkill',
      command: 'taskkill',
      args: ['/PID', String(pid), '/T', '/F'],
    };
  }

  return { kind: 'process-group', signal: 'SIGTERM' };
}

export function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ port: 0, host: LOOPBACK_HOST, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === 'string' || address.address !== LOOPBACK_HOST || address.port <= 0) {
        server.close(() => reject(new Error('Refused to allocate a non-loopback port.')));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const DIAGNOSTIC_SECRET_KEYS = [
  'PYTHON_API_URL',
  'SONGFORMER_API_URL',
  'SHEETSAGE_API_URL',
  'FIREBASE_SERVICE_ACCOUNT_KEY',
  'GEMINI_API_KEY',
  'GENIUS_API_KEY',
  'MUSIC_AI_API_KEY',
  'CRON_SECRET',
  'CHORDMINI_READY_TOKEN',
  'CHORDMINI_DESKTOP_COOKIE',
] as const;

function diagnosticSecrets(env: NodeJS.ProcessEnv, tokens: readonly string[]): string[] {
  const values = DIAGNOSTIC_SECRET_KEYS.flatMap((key) => {
    const value = env[key];
    return value ? [value] : [];
  });
  return [...tokens, ...values];
}

function buildChildEnv(
  port: number,
  readyToken: string,
  cookieToken: string,
  parentEnv: NodeJS.ProcessEnv,
  extraEnv: NodeJS.ProcessEnv | undefined,
  runningInElectron: boolean,
): NodeJS.ProcessEnv {
  return {
    ...parentEnv,
    ...extraEnv,
    HOSTNAME: LOOPBACK_HOST,
    PORT: String(port),
    NEXT_PUBLIC_APP_RUNTIME: 'electron',
    CHORDMINI_DESKTOP_MODE: '1',
    CHORDMINI_READY_TOKEN: readyToken,
    CHORDMINI_DESKTOP_COOKIE: cookieToken,
    ...(runningInElectron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
  };
}

async function waitForOwnedReady(
  owned: OwnedServer,
  options: Required<Pick<StartOwnedServerOptions, 'timeoutMs' | 'intervalMs' | 'fetchImpl'>>,
): Promise<'ready' | 'retry' | 'fatal'> {
  const deadline = Date.now() + options.timeoutMs;
  const collect = (chunk: Buffer | string) => {
    owned.stderrTail = `${owned.stderrTail}${chunk.toString()}`.slice(-8000);
  };
  let spawnFailed = false;
  owned.child.stderr?.on('data', collect);
  owned.child.stdout?.on('data', () => undefined);
  owned.child.on?.('error', (error: unknown) => {
    spawnFailed = true;
    collect(error instanceof Error ? error.message : String(error));
  });

  while (Date.now() < deadline) {
    if (spawnFailed) {
      return 'fatal';
    }
    if (owned.child.exitCode !== null) {
      return /EADDRINUSE/i.test(owned.stderrTail) ? 'retry' : 'fatal';
    }

    const nonce = createReadyNonce();
    try {
      const response = await options.fetchImpl(`${owned.origin}${readyPath()}`, {
        method: 'GET',
        redirect: 'error',
        headers: { 'x-chordmini-nonce': nonce },
        signal: AbortSignal.timeout(1000),
      });
      const proof = response.headers.get('x-chordmini-proof');
      if (response.status === 200 && readyProofMatches(owned.readyToken, nonce, proof)) {
        const body = await response.json() as { ok?: boolean; role?: string };
        if (body.ok === true && body.role === 'next-standalone') {
          return 'ready';
        }
      }
    } catch {
      // The child is still binding the port, or a different process answered.
    }

    await delay(options.intervalMs);
  }

  return 'fatal';
}

function readyPath(): string {
  return '/api/desktop/ready';
}

export async function startOwnedServer(options: StartOwnedServerOptions): Promise<OwnedServer> {
  if (!path.isAbsolute(options.serverEntry) || !fs.existsSync(options.serverEntry)) {
    throw new Error('Next.js standalone server is missing. Run npm run build before starting the desktop shell.');
  }

  const timeoutMs = options.timeoutMs ?? 30000;
  const intervalMs = options.intervalMs ?? 200;
  const maxAttempts = options.maxAttempts ?? 5;
  const fetchImpl = options.fetchImpl ?? fetch;
  const spawnImpl = options.spawnImpl ?? spawn;
  const allocatePort = options.allocatePort ?? allocateLoopbackPort;
  const platform = options.platform ?? process.platform;
  const parentEnv = options.parentEnv ?? process.env;
  const readyToken = createDesktopSecret();
  const cookieToken = createDesktopSecret();
  let lastStderr = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const port = await allocatePort();
    const child = spawnImpl(options.command ?? process.execPath, [options.serverEntry], {
      cwd: path.dirname(options.serverEntry),
      env: buildChildEnv(
        port,
        readyToken,
        cookieToken,
        parentEnv,
        options.extraEnv,
        Boolean(process.versions.electron),
      ),
      detached: platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }) as OwnedChild;

    const owned: OwnedServer = {
      child,
      port,
      origin: `http://${LOOPBACK_HOST}:${port}`,
      readyToken,
      cookieToken,
      stderrTail: '',
      stopped: false,
    };

    const result = await waitForOwnedReady(owned, { timeoutMs, intervalMs, fetchImpl });
    if (result === 'ready') {
      return owned;
    }

    lastStderr = owned.stderrTail;
    await stopOwnedServer(owned, { platform, graceMs: options.graceMs });
    if (result !== 'retry' || attempt === maxAttempts) {
      break;
    }
  }

  const sanitized = sanitizeDiagnostic(lastStderr, diagnosticSecrets(
    { ...parentEnv, ...options.extraEnv },
    [readyToken, cookieToken],
  ));
  throw new Error(`The local ChordMini server did not become ready. ${sanitized}`.trim());
}

export async function stopOwnedServer(
  owned: OwnedServer | null,
  options: {
    platform?: NodeJS.Platform;
    execFileImpl?: (command: string, args: string[]) => Promise<unknown>;
    killImpl?: (pid: number, signal: NodeJS.Signals) => void;
    graceMs?: number;
  } = {},
): Promise<void> {
  if (!owned || owned.stopped) {
    return;
  }
  owned.stopped = true;

  const pid = owned.child.pid;
  if (pid === undefined) {
    return;
  }

  const platform = options.platform ?? process.platform;
  const plan = terminationPlan(pid, platform);
  try {
    if (plan.kind === 'taskkill') {
      const execFileImpl = options.execFileImpl ?? ((command, args) => execFileAsync(command, args));
      await execFileImpl(plan.command, plan.args);
      return;
    }

    const killImpl = options.killImpl ?? ((target, signal) => {
      process.kill(target, signal);
    });
    try {
      killImpl(-pid, 'SIGTERM');
    } catch {
      try {
        killImpl(pid, 'SIGTERM');
      } catch {
        return;
      }
    }
    await delay(options.graceMs ?? 500);
    try {
      killImpl(-pid, 'SIGKILL');
    } catch {
      // The process group has already exited.
    }
  } finally {
    owned.child.unref?.();
  }
}
