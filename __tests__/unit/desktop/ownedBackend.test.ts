/**
 * @jest-environment node
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { backendInstanceProof, readBackendStatus } from '@/desktop/localBackend';
import { prepareOwnedBackend } from '@/desktop/ownedBackend';
import { singleInstanceDecision } from '@/desktop/windowPolicy';
import type { OwnedChild } from '@/desktop/ownedServer';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeChild(pid: number, stderrText = ''): OwnedChild {
  return {
    pid,
    exitCode: null,
    killed: false,
    stderr: {
      on(event: string, listener: (chunk: Buffer) => void) {
        if (event === 'data' && stderrText) {
          listener(Buffer.from(stderrText));
        }
      },
    } as OwnedChild['stderr'],
    stdout: { on() { return undefined; } } as unknown as OwnedChild['stdout'],
    kill() {
      this.killed = true;
      return true;
    },
    on() {
      return undefined;
    },
    unref() {
      return undefined;
    },
  };
}

describe('owned local backend startup', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'chordmini-owned-'));
  const pythonPath = path.join(temp, 'python');
  const backendDir = path.join(temp, 'python_backend');
  const userDataDir = path.join(temp, 'user-data');

  beforeAll(() => {
    fs.writeFileSync(pythonPath, '');
    fs.mkdirSync(backendDir);
    fs.mkdirSync(userDataDir);
    fs.writeFileSync(path.join(backendDir, 'app.py'), 'print("flask")\n');
  });

  const baseEnv: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    CHORDMINI_PYTHON: pythonPath,
    CHORDMINI_BACKEND_DIR: backendDir,
    CHORDMINI_INFERENCE_SECRET: 'do-not-copy',
  };

  function harness(options?: {
    health?: (nonce: string, alive: boolean, challenge: string) => Response | null;
    readiness?: (challenge: string, nonce: string) => Response;
    root?: () => Response;
    modelInfo?: () => Response;
    chordInfo?: () => Response;
    exitCode?: number | null;
    stderrText?: string;
  }) {
    let nonce = '';
    let alive = false;
    let spawns = 0;
    const killed: number[] = [];
    const commands: string[][] = [];
    const childEnv: NodeJS.ProcessEnv[] = [];
    const fetchImpl = jest.fn(async (url: string) => {
      const target = String(url);
      const challenge = new URL(target).searchParams.get('challenge') ?? '';
      if (target.includes('/api/model-info')) {
        return options?.modelInfo?.() ?? jsonResponse({ success: false }, 404);
      }
      if (target.includes('/api/chord-model-info')) {
        return options?.chordInfo?.() ?? jsonResponse({ success: false }, 404);
      }
      if (target.includes('/api/desktop/readiness')) {
        return options?.readiness?.(challenge, nonce) ?? jsonResponse({
          service: 'chordmini-flask',
          proves: 'weight-files-and-imports',
          status: 'healthy',
          chordCnnLstm: true,
          beatTransformer: true,
          madmom: true,
          instance: nonce ? backendInstanceProof(nonce, challenge) : undefined,
        });
      }
      if (target.includes('/health')) {
        const custom = options?.health?.(nonce, alive, challenge);
        if (custom) {
          return custom;
        }
        if (!alive) {
          throw new Error('connect ECONNREFUSED');
        }
        return jsonResponse({
          status: 'healthy',
          service: 'chordmini-flask',
          instance: backendInstanceProof(nonce, challenge),
        });
      }
      const pathOnly = new URL(target).pathname;
      if (pathOnly === '/') {
        return options?.root?.() ?? (() => {
          throw new Error('no root');
        })();
      }
      throw new Error(`unexpected ${target}`);
    });
    const spawnImpl = jest.fn((_command: string, args: readonly string[], spawnOptions: { cwd: string; env: NodeJS.ProcessEnv }) => {
      spawns += 1;
      nonce = spawnOptions.env.CHORDMINI_BACKEND_NONCE ?? '';
      alive = true;
      commands.push([_command, ...args]);
      childEnv.push(spawnOptions.env);
      const child = makeChild(4100 + spawns, options?.stderrText ?? '');
      if (options?.exitCode != null) {
        child.exitCode = options.exitCode;
      }
      return child;
    });
    const killImpl = jest.fn((pid: number) => {
      killed.push(pid);
      alive = false;
    });
    return {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      spawnImpl: spawnImpl as unknown as typeof import('child_process').spawn,
      killImpl,
      get spawns() {
        return spawns;
      },
      killed,
      commands,
      childEnv,
      markDead() {
        alive = false;
      },
    };
  }

  function readStatus(handle: { statusFile: string; statusKey: string }) {
    return readBackendStatus({
      CHORDMINI_BACKEND_STATUS_FILE: handle.statusFile,
      CHORDMINI_BACKEND_STATUS_KEY: handle.statusKey,
    });
  }

  async function start(
    extra?: Parameters<typeof harness>[0],
    attempts = 2,
    env: NodeJS.ProcessEnv = baseEnv,
  ) {
    const tools = harness(extra);
    const handle = await prepareOwnedBackend({
      env,
      userDataDir,
      platform: 'linux',
      fetchImpl: tools.fetchImpl,
      spawnImpl: tools.spawnImpl,
      killImpl: tools.killImpl,
      timeoutMs: 250,
      probeTimeoutMs: 20,
      modelTimeoutMs: 20,
      intervalMs: 5,
      graceMs: 0,
      maxAttempts: attempts,
      port: 5001,
    });
    await handle.whenSettled;
    return { handle, tools };
  }

  it('starts Flask on a cold port and configures the Next child from the main process', async () => {
    const { handle, tools } = await start();
    const status = readStatus(handle);
    expect(tools.spawns).toBe(1);
    expect(tools.commands[0][0]).toBe(pythonPath);
    expect(tools.commands[0][1]).toBe(path.join(backendDir, 'app.py'));
    expect(tools.childEnv[0].PYTHONPATH).toContain(`${path.sep}Beat-Transformer${path.sep}code`);
    expect(tools.childEnv[0].CHORDMINI_INFERENCE_SECRET).toBeUndefined();
    expect(tools.childEnv[0].NODE_ENV).toBe('development');
    expect(tools.childEnv[0].FLASK_ENV).toBe('development');
    expect(tools.childEnv[0].PORT).toBeUndefined();
    expect(tools.childEnv[0].CHORDMINI_INFERENCE_AUTH).toBe('local');
    expect(handle.nextEnv.PYTHON_API_URL).toBe('http://127.0.0.1:5001');
    expect(handle.nextEnv.CHORDMINI_ANALYSIS_HISTORY_DIR).toBe(path.join(userDataDir, 'analysis-history'));
    expect(handle.nextEnv.NEXT_PUBLIC_ANALYSIS_HISTORY_DIR).toBeUndefined();
    expect(handle.nextEnv.CHORDMINI_BACKEND_SUPERVISED).toBe('1');
    expect(handle.nextEnv.CHORDMINI_BACKEND_STATUS_KEY).toBe(handle.statusKey);
    expect(handle.nextEnv.NEXT_PUBLIC_PYTHON_API_URL).toBeUndefined();
    expect(status?.serverReady).toBe(true);
    expect(status?.modelPreflightReady).toBe(true);
    expect(status?.inferenceVerified).toBe(false);
    expect(status?.analysisReady).toBe(false);
    expect(status?.identity).toBe('owned');
    await handle.stop();
    expect(tools.killed).toContain(-4101);
  });

  it('does not adopt a public ChordMini health body and does not kill that process', async () => {
    const { handle, tools } = await start({
      health: () => jsonResponse({
        status: 'healthy',
        service: 'chordmini-flask',
        instance: 'a'.repeat(64),
      }),
    });
    const status = readStatus(handle);
    expect(tools.spawns).toBe(0);
    expect(tools.killed).toEqual([]);
    expect(handle.nextEnv.PYTHON_API_URL).toBeUndefined();
    expect(handle.nextEnv.CHORDMINI_BACKEND_NONCE).toBeUndefined();
    expect(status?.code).toBe('PORT_IDENTITY_MISMATCH');
    expect(status?.serverReady).toBe(false);
    await handle.stop();
    expect(tools.killed).toEqual([]);
  });

  it('stops only its own child when the listener cannot prove this session', async () => {
    const { handle, tools } = await start({
      health: (_nonce, alive) => {
        if (!alive) {
          throw new Error('connect ECONNREFUSED');
        }
        return jsonResponse({ status: 'healthy', service: 'chordmini-flask' });
      },
    });
    const status = readStatus(handle);
    expect(tools.spawns).toBe(1);
    expect(status?.code).toBe('IDENTITY_NOT_PROVEN');
    expect(status?.serverReady).toBe(false);
    expect(status?.owned).toBe(false);
    expect(status?.message).toMatch(/healthy response is not identity/i);
    await handle.stop();
    expect(tools.killed).toEqual([-4101, -4101]);
    expect(tools.killed.every((pid) => pid === -4101)).toBe(true);
  });

  it('uses an already running legacy process only when the test flag is set', async () => {
    const legacy = {
      health: () => jsonResponse({ status: 'healthy' }),
      readiness: () => jsonResponse({ error: 'missing' }, 404),
      root: () => jsonResponse({
        status: 'healthy',
        message: 'Audio analysis API is running',
      }),
      modelInfo: () => jsonResponse({
        success: true,
        available_beat_models: ['madmom', 'beat-transformer'],
        beat_transformer_available: true,
        madmom_available: true,
      }),
      chordInfo: () => jsonResponse({
        success: true,
        chord_model_info: { 'chord-cnn-lstm': { available: true } },
      }),
    };
    const blocked = await start(legacy);
    const blockedStatus = readStatus(blocked.handle);
    expect(blocked.tools.spawns).toBe(0);
    expect(blocked.tools.killed).toEqual([]);
    expect(blocked.handle.nextEnv.PYTHON_API_URL).toBeUndefined();
    expect(blockedStatus?.code).toBe('PORT_IDENTITY_MISMATCH');
    await blocked.handle.stop();

    const { handle, tools } = await start(legacy, 2, {
      ...baseEnv,
      CHORDMINI_ALLOW_LEGACY_BACKEND: '1',
    });
    const status = readStatus(handle);
    expect(tools.spawns).toBe(0);
    expect(tools.killed).toEqual([]);
    expect(status?.identity).toBe('legacy');
    expect(status?.owned).toBe(false);
    expect(status?.modelPreflightReady).toBe(true);
    expect(status?.inferenceVerified).toBe(false);
    expect(status?.analysisReady).toBe(false);
    expect(status?.models.chordCnnLstm).toBe(true);
    expect(handle.nextEnv.PYTHON_API_URL).toBe('http://127.0.0.1:5001');
    expect(handle.nextEnv.CHORDMINI_BACKEND_NONCE).toBeUndefined();
    expect(handle.nextEnv.CHORDMINI_ALLOW_LEGACY_BACKEND).toBe('1');
    expect(status?.message).toMatch(/explicit local testing/i);
    await handle.stop();
    expect(tools.killed).toEqual([]);
  });

  it('leaves an unrelated process on the analysis port running', async () => {
    const { handle, tools } = await start({
      health: () => jsonResponse({ status: 'ok', service: 'other' }),
    });
    const status = readStatus(handle);
    expect(tools.spawns).toBe(0);
    expect(tools.killed).toEqual([]);
    expect(handle.nextEnv.PYTHON_API_URL).toBeUndefined();
    expect(status?.code).toBe('PORT_IDENTITY_MISMATCH');
    expect(status?.message).toMatch(/left running/);
    expect(status?.message).not.toMatch(/127\.0\.0\.1|https?:\/\//);
    await handle.stop();
  });

  it('does not spawn a second backend while this session still owns one', async () => {
    const { handle, tools } = await start();
    await handle.retry();
    expect(tools.spawns).toBe(1);
    await handle.stop();
  });

  it('starts again after the owned process is stopped', async () => {
    const tools = harness();
    const first = await prepareOwnedBackend({
      env: baseEnv,
      userDataDir,
      platform: 'linux',
      fetchImpl: tools.fetchImpl,
      spawnImpl: tools.spawnImpl,
      killImpl: tools.killImpl,
      timeoutMs: 80,
      probeTimeoutMs: 20,
      modelTimeoutMs: 20,
      intervalMs: 5,
      graceMs: 0,
      port: 5001,
    });
    await first.whenSettled;
    await first.stop();
    const second = await prepareOwnedBackend({
      env: baseEnv,
      userDataDir,
      platform: 'linux',
      fetchImpl: tools.fetchImpl,
      spawnImpl: tools.spawnImpl,
      killImpl: tools.killImpl,
      timeoutMs: 80,
      probeTimeoutMs: 20,
      modelTimeoutMs: 20,
      intervalMs: 5,
      graceMs: 0,
      port: 5001,
    });
    await second.whenSettled;
    expect(tools.spawns).toBe(2);
    expect(tools.killed).toContain(-4101);
    await second.stop();
  });

  it('stops a timed-out child and reports the timeout', async () => {
    const { handle, tools } = await start({
      health: () => {
        throw new Error('timed out');
      },
    }, 2);
    const status = readStatus(handle);
    expect(tools.spawns).toBe(2);
    expect(status?.code).toBe('TIMEOUT');
    expect(status?.serverReady).toBe(false);
    expect(status?.analysisReady).toBe(false);
    expect(tools.killed.length).toBeGreaterThan(0);
    await handle.stop();
  });

  it('reports an import failure and does not keep retrying it', async () => {
    const { handle, tools } = await start({
      exitCode: 1,
      stderrText: 'ImportError: No module named flask',
    }, 2);
    const status = readStatus(handle);
    expect(tools.spawns).toBe(1);
    expect(status?.code).toBe('FLASK_IMPORT');
    expect(status?.message).toMatch(/import its Python dependencies/);
    await handle.stop();
  });

  it('reports a crashed backend without signaling an unrelated pid', async () => {
    const { handle, tools } = await start({
      exitCode: 1,
      stderrText: 'process exited',
    }, 2);
    const status = readStatus(handle);
    expect(status?.code).toBe('BACKEND_CRASH');
    expect(tools.killed.every((pid) => pid === -4101 || pid === -4102)).toBe(true);
    expect(tools.killed).not.toContain(1);
    expect(tools.killed).not.toContain(process.pid);
    await handle.stop();
  });

  it('reports missing model weights after the server identifies itself', async () => {
    const { handle, tools } = await start({
      readiness: (challenge, ownedNonce) => jsonResponse({
        service: 'chordmini-flask',
        proves: 'weight-files-and-imports',
        status: 'healthy',
        chordCnnLstm: false,
        beatTransformer: true,
        madmom: true,
        instance: backendInstanceProof(ownedNonce, challenge),
      }),
    });
    const status = readStatus(handle);
    expect(tools.spawns).toBe(1);
    expect(status?.serverReady).toBe(true);
    expect(status?.modelPreflightReady).toBe(false);
    expect(status?.inferenceVerified).toBe(false);
    expect(status?.analysisReady).toBe(false);
    expect(status?.code).toBe('MODEL_UNAVAILABLE');
    expect(status?.message).toMatch(/Chord-CNN-LSTM/);
    await handle.stop();
  });

  it('reports a missing Python executable before any spawn', async () => {
    const tools = harness();
    const handle = await prepareOwnedBackend({
      env: {
        ...baseEnv,
        CHORDMINI_PYTHON: path.join(temp, 'absent-python'),
      },
      userDataDir,
      fetchImpl: tools.fetchImpl,
      spawnImpl: tools.spawnImpl,
      port: 5001,
    });
    await handle.whenSettled;
    const status = readStatus(handle);
    expect(tools.spawns).toBe(0);
    expect(handle.nextEnv.PYTHON_API_URL).toBeUndefined();
    expect(status?.code).toBe('PYTHON_MISSING');
    expect(status?.message).toMatch(/Python executable is missing/);
  });

  it('checks the owned server again after resume and can start a replacement', async () => {
    const { handle, tools } = await start();
    await handle.onResume();
    expect(tools.spawns).toBe(1);
    tools.markDead();
    await handle.onResume();
    expect(tools.spawns).toBe(2);
    await handle.stop();
  });

  it('keeps a second Electron launch from owning startup', () => {
    expect(singleInstanceDecision(false)).toBe('quit');
    expect(singleInstanceDecision(true)).toBe('continue');
  });
});
