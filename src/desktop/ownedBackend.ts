/**
 * Owned local Flask process for the existing Electron startup path.
 *
 * This does not start Next.js and does not replace the owned Next server.
 * Electron main calls it once, then passes the approved loopback origin into
 * that Next child. A listener is accepted only when it answers a fresh
 * challenge with this session's nonce, or when explicit legacy test mode
 * matches the old root contract. Any other occupant is left running.
 */

import { spawn } from 'child_process';
import path from 'path';
import { analysisHistoryDir } from './analysisHistory/location';
import { signalOwnedPid, type OwnedChild } from './ownedServer';
import { createDesktopSecret } from './readyProof';
import {
  BACKEND_RETRY_FILE_NAME,
  BACKEND_STATUS_FILE_NAME,
  allowLegacyBackend,
  createBackendStatus,
  createIdentityChallenge,
  classifyOwnedHealth,
  identityRequestUrl,
  isLegacyChordMiniRoot,
  isModelPreflightReady,
  loopbackOrigin,
  modelStatusMessage,
  modelsFromLegacyInfo,
  modelsFromReadiness,
  nextChildBackendEnv,
  preferredFlaskPort,
  publicBackendMessage,
  pythonChildEnv,
  resolveLocalBackendConfig,
  writeBackendStatus,
  type BackendModels,
  type BackendStatus,
} from './localBackend';

const STARTUP_TIMEOUT_MS = 45000;
const PROBE_TIMEOUT_MS = 1500;
const MODEL_PROBE_TIMEOUT_MS = 20000;
const INTERVAL_MS = 300;
const MAX_ATTEMPTS = 2;

export interface OwnedBackendHandle {
  nextEnv: NodeJS.ProcessEnv;
  retryFile: string;
  retryToken: string;
  statusFile: string;
  statusKey: string;
  stop: () => Promise<void>;
  retry: () => Promise<void>;
  onResume: () => Promise<void>;
  whenSettled: Promise<void>;
}

interface SupervisorOptions {
  env: NodeJS.ProcessEnv;
  userDataDir: string;
  historyDir?: string;
  platform?: NodeJS.Platform;
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof spawn;
  timeoutMs?: number;
  probeTimeoutMs?: number;
  modelTimeoutMs?: number;
  intervalMs?: number;
  maxAttempts?: number;
  port?: number;
  execFileImpl?: (command: string, args: string[]) => Promise<unknown>;
  killImpl?: (pid: number, signal: NodeJS.Signals) => void;
  graceMs?: number;
  log?: (line: string) => void;
}

type Occupant = 'free' | 'legacy' | 'mismatch';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function readJson(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<{ status: number; body: unknown } | null> {
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status >= 300 && response.status < 400) {
      return { status: response.status, body: null };
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body };
  } catch {
    return null;
  }
}

async function loadModels(
  origin: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  ownedNonce?: string,
): Promise<BackendModels | null> {
  const challenge = createIdentityChallenge();
  const readiness = await readJson(
    fetchImpl,
    identityRequestUrl(`${origin}/api/desktop/readiness`, challenge),
    timeoutMs,
  );
  const direct = readiness && readiness.status === 200
    ? modelsFromReadiness(
      readiness.body,
      ownedNonce ? { nonce: ownedNonce, challenge } : undefined,
    )
    : null;
  if (direct) {
    return direct;
  }
  if (ownedNonce) {
    return null;
  }
  const beat = await readJson(fetchImpl, `${origin}/api/model-info`, timeoutMs);
  const chord = await readJson(fetchImpl, `${origin}/api/chord-model-info`, timeoutMs);
  if (!beat || beat.status !== 200 || !chord || chord.status !== 200) {
    return null;
  }
  return modelsFromLegacyInfo(beat.body, chord.body);
}

function importFailure(stderr: string): boolean {
  return /ImportError|ModuleNotFoundError|No module named|cannot import/i.test(stderr);
}

function attachOutput(child: OwnedChild, sink: { text: string }): void {
  const collect = (chunk: Buffer | string) => {
    sink.text = `${sink.text}${chunk.toString()}`.slice(-4000);
  };
  child.stderr?.on('data', collect);
  child.stdout?.on('data', collect);
}

export async function prepareOwnedBackend(options: SupervisorOptions): Promise<OwnedBackendHandle> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const spawnImpl = options.spawnImpl ?? spawn;
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? STARTUP_TIMEOUT_MS;
  const probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const modelTimeoutMs = options.modelTimeoutMs ?? MODEL_PROBE_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? INTERVAL_MS;
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  const port = options.port ?? preferredFlaskPort(options.env);
  const origin = loopbackOrigin(port);
  const statusFile = path.join(options.userDataDir, BACKEND_STATUS_FILE_NAME);
  const retryFile = path.join(options.userDataDir, BACKEND_RETRY_FILE_NAME);
  const derivedHistoryDir = analysisHistoryDir(options.userDataDir);
  const historyDir = options.historyDir === derivedHistoryDir ? options.historyDir : derivedHistoryDir;
  const resolved = resolveLocalBackendConfig({
    env: options.env,
    userDataDir: options.userDataDir,
  });
  const sessionNonce = createDesktopSecret();

  let stopped = false;
  let working = false;
  let ownedChild: OwnedChild | null = null;
  let ownedPid: number | undefined;
  const allowLegacy = allowLegacyBackend(options.env);
  const statusKey = createDesktopSecret();
  const retryToken = createDesktopSecret();
  let identity: 'none' | 'owned' | 'legacy' = 'none';
  let settle = () => {};
  let settled = false;
  const whenSettled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const finish = () => {
    if (!settled) {
      settled = true;
      settle();
    }
  };

  const publish = (status: BackendStatus) => {
    try {
      writeBackendStatus(statusFile, status, statusKey);
    } catch (error) {
      options.log?.(error instanceof Error ? error.message : String(error));
    }
  };

  const fail = (code: string, message: string) => {
    identity = 'none';
    publish(createBackendStatus({
      phase: 'failed',
      code,
      message,
      serverReady: false,
      owned: false,
      identity: 'none',
    }));
  };

  const publishModels = async (kind: 'owned' | 'legacy') => {
    const models = await loadModels(
      origin,
      fetchImpl,
      modelTimeoutMs,
      kind === 'owned' ? sessionNonce : undefined,
    );
    if (stopped) {
      return;
    }
    if (!models) {
      fail(
        'MODEL_UNCONFIRMED',
        'The analysis service responded, but detector preflight could not be confirmed. A health response is not an analysis result.',
      );
      return;
    }
    const preflight = isModelPreflightReady(models);
    identity = kind;
    const legacyNote = kind === 'legacy'
      ? ' Legacy mode is explicit local testing and does not authenticate the process.'
      : '';
    publish(createBackendStatus({
      phase: preflight ? 'server-ready' : 'failed',
      code: preflight ? 'MODEL_PREFLIGHT_READY' : 'MODEL_UNAVAILABLE',
      message: `${modelStatusMessage(models)}${legacyNote}`,
      serverReady: true,
      owned: kind === 'owned',
      identity: kind,
      models,
    }));
  };

  const classifyOccupant = async (): Promise<Occupant> => {
    const health = await readJson(fetchImpl, `${origin}/health`, probeTimeoutMs);
    if (!health) {
      return 'free';
    }
    // A listener that exists before this session spawns is not ours, even when
    // its public body names ChordMini. A hash seen on /health is not proof.
    if (!allowLegacy || health.status !== 200) {
      return 'mismatch';
    }
    const record = health.body && typeof health.body === 'object'
      ? health.body as { status?: unknown }
      : null;
    if (record?.status !== 'healthy') {
      return 'mismatch';
    }
    const root = await readJson(fetchImpl, `${origin}/`, probeTimeoutMs);
    if (root && root.status === 200 && isLegacyChordMiniRoot(root.body)) {
      return 'legacy';
    }
    return 'mismatch';
  };

  const readOwnedProof = async (): Promise<'owned' | 'unproven' | 'down'> => {
    const challenge = createIdentityChallenge();
    const health = await readJson(
      fetchImpl,
      identityRequestUrl(`${origin}/health`, challenge),
      probeTimeoutMs,
    );
    if (!health || health.status !== 200) {
      return 'down';
    }
    return classifyOwnedHealth(health.body, sessionNonce, challenge) === 'owned' ? 'owned' : 'unproven';
  };

  const stopChild = async () => {
    const pid = ownedPid;
    const child = ownedChild;
    ownedChild = null;
    ownedPid = undefined;
    if (pid === undefined) {
      return;
    }
    try {
      await signalOwnedPid(pid, {
        platform,
        execFileImpl: options.execFileImpl,
        killImpl: options.killImpl,
        graceMs: options.graceMs,
      });
    } catch (error) {
      options.log?.(error instanceof Error ? error.message : String(error));
    } finally {
      child?.unref?.();
    }
  };

  const waitForOwned = async (
    child: OwnedChild,
    stderr: { text: string },
  ): Promise<'ready' | 'import' | 'timeout' | 'crash' | 'stopped' | 'unproven'> => {
    const deadline = Date.now() + timeoutMs;
    let unprovenResponses = 0;
    while (Date.now() < deadline) {
      if (stopped) {
        return 'stopped';
      }
      if (child.exitCode !== null) {
        return importFailure(stderr.text) ? 'import' : 'crash';
      }
      const proof = await readOwnedProof();
      if (proof === 'owned') {
        return 'ready';
      }
      // The child being alive does not prove it owns the socket. Two responses
      // that are not this session's challenge proof are enough to fail closed
      // without waiting out the full startup timeout.
      if (proof === 'unproven') {
        unprovenResponses += 1;
        if (unprovenResponses >= 2) {
          return 'unproven';
        }
      }
      await delay(intervalMs);
    }
    return child.exitCode !== null ? 'crash' : 'timeout';
  };

  const spawnAndWait = async (): Promise<void> => {
    if (!resolved.ok) {
      fail(resolved.code, resolved.message);
      return;
    }
    publish(createBackendStatus({
      phase: 'starting',
      code: 'STARTING',
      message: 'ChordMini is starting the local analysis service.',
      serverReady: false,
      owned: true,
      identity: 'none',
    }));

    let lastCode = 'TIMEOUT';
    let lastMessage = 'The analysis service did not become ready before the startup timeout. ChordMini stopped the process it had started.';
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (stopped) {
        return;
      }
      const stderr = { text: '' };
      let child: OwnedChild;
      try {
        child = spawnImpl(resolved.pythonPath, [resolved.flaskEntry], {
          cwd: resolved.backendDir,
          env: pythonChildEnv({
            parentEnv: options.env,
            backendDir: resolved.backendDir,
            port,
            nonce: sessionNonce,
          }),
          detached: platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        }) as unknown as OwnedChild;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fail('PYTHON_SPAWN_FAILED', `The configured Python executable could not be started. ${publicBackendMessage(message)}`);
        return;
      }
      ownedChild = child;
      ownedPid = child.pid;
      if (ownedPid === undefined) {
        fail('PYTHON_SPAWN_FAILED', 'The configured Python executable did not start. ChordMini did not keep an untracked process.');
        return;
      }
      attachOutput(child, stderr);
      child.on?.('error', (spawnError: unknown) => {
        stderr.text += spawnError instanceof Error ? spawnError.message : String(spawnError);
      });
      const outcome = await waitForOwned(child, stderr);
      if (outcome === 'stopped') {
        return;
      }
      if (outcome === 'ready') {
        await publishModels('owned');
        return;
      }
      await stopChild();
      if (outcome === 'unproven') {
        fail(
          'IDENTITY_NOT_PROVEN',
          'The analysis port answered, but it did not prove this session started it. A healthy response is not identity. ChordMini stopped only the process it had started.',
        );
        return;
      }
      if (outcome === 'import' || importFailure(stderr.text)) {
        lastCode = 'FLASK_IMPORT';
        lastMessage = 'The analysis service failed to import its Python dependencies. ChordMini stopped the process it had started.';
        break;
      }
      if (outcome === 'crash') {
        lastCode = 'BACKEND_CRASH';
        lastMessage = 'The analysis service stopped unexpectedly. ChordMini did not stop any unrelated Python process.';
      }
      if (outcome === 'timeout') {
        lastCode = 'TIMEOUT';
        lastMessage = 'The analysis service did not become ready before the startup timeout. ChordMini stopped the process it had started.';
      }
    }
    fail(lastCode, lastMessage);
  };

  const ensureStarted = async () => {
    if (stopped || working) {
      return;
    }
    if (ownedChild && ownedChild.exitCode === null) {
      return;
    }
    working = true;
    try {
      if (!resolved.ok) {
        fail(resolved.code, resolved.message);
        return;
      }
      const occupant = await classifyOccupant();
      if (occupant === 'mismatch') {
        fail(
          'PORT_IDENTITY_MISMATCH',
          'Another program is using the analysis port and did not identify as ChordMini. It was left running. No chords or beats were generated.',
        );
        return;
      }
      if (occupant === 'legacy') {
        await publishModels('legacy');
        options.log?.('Using an already running ChordMini service in explicit legacy test mode.');
        return;
      }
      await spawnAndWait();
    } finally {
      working = false;
      finish();
    }
  };

  let originForNext: string | null = null;
  let nonceForNext: string | null = null;
  if (!resolved.ok) {
    fail(resolved.code, resolved.message);
    finish();
  } else {
    const occupant = await classifyOccupant();
    if (occupant === 'mismatch') {
      fail(
        'PORT_IDENTITY_MISMATCH',
        'Another program is using the analysis port and did not identify as ChordMini. It was left running. No chords or beats were generated.',
      );
      finish();
    } else if (occupant === 'legacy') {
      originForNext = origin;
      identity = 'legacy';
      publish(createBackendStatus({
        phase: 'starting',
        code: 'CONFIRMING_MODELS',
        message: 'ChordMini found a local analysis service in explicit legacy test mode and is confirming the required detectors.',
        serverReady: false,
        owned: false,
        identity: 'legacy',
      }));
      void ensureStarted().catch((error: unknown) => {
        options.log?.(error instanceof Error ? error.message : String(error));
        fail('BACKEND_START_FAILED', 'The local analysis service could not be confirmed.');
        finish();
      });
    } else {
      originForNext = origin;
      nonceForNext = sessionNonce;
      publish(createBackendStatus({
        phase: 'starting',
        code: 'STARTING',
        message: 'ChordMini is starting the local analysis service.',
        serverReady: false,
        owned: true,
        identity: 'none',
      }));
      void ensureStarted().catch((error: unknown) => {
        options.log?.(error instanceof Error ? error.message : String(error));
        fail('BACKEND_START_FAILED', 'The local analysis service could not be started.');
        finish();
      });
    }
  }

  return {
    nextEnv: nextChildBackendEnv({
      origin: originForNext,
      statusFile,
      retryFile,
      nonce: nonceForNext,
      statusKey,
      retryToken,
      allowLegacy,
      historyDir,
    }),
    retryFile,
    retryToken,
    statusFile,
    statusKey,
    whenSettled,
    stop: async () => {
      stopped = true;
      await whenSettled.catch(() => undefined);
      await stopChild();
    },
    retry: async () => {
      if (stopped) {
        return;
      }
      await whenSettled.catch(() => undefined);
      settled = false;
      await ensureStarted();
    },
    onResume: async () => {
      if (stopped) {
        return;
      }
      await whenSettled.catch(() => undefined);
      if (ownedChild && ownedChild.exitCode === null) {
        if (await readOwnedProof() === 'owned') {
          await publishModels('owned');
          return;
        }
        await stopChild();
      }
      if (identity === 'legacy' && allowLegacy) {
        const root = await readJson(fetchImpl, `${origin}/`, probeTimeoutMs);
        if (root && root.status === 200 && isLegacyChordMiniRoot(root.body)) {
          await publishModels('legacy');
          return;
        }
      }
      settled = false;
      await ensureStarted();
    },
  };
}
