/**
 * @jest-environment node
 */
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import {
  allocateLoopbackPort,
  startOwnedServer,
  stopOwnedServer,
  terminationPlan,
  type OwnedServer,
} from '@/desktop/ownedServer';

const FIXTURE = path.join(process.cwd(), '__tests__', 'fixtures', 'desktopReadyServer.cjs');
const BACKEND = 'https://analysis.example/private-token-value';

function fakeOwned(pid: number): OwnedServer {
  return {
    child: {
      pid,
      exitCode: null,
      killed: false,
      stderr: null,
      stdout: null,
      kill: () => true,
    },
    port: 4312,
    origin: 'http://127.0.0.1:4312',
    readyToken: 'ready-token',
    cookieToken: 'cookie-token',
    stderrTail: '',
    stopped: false,
  };
}

function loopbackFetch(url: string, init?: RequestInit): Promise<Response> {
  const parsed = new URL(url);
  const headers = new Headers(init?.headers);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(headers.entries()),
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) {
            value.forEach((entry) => responseHeaders.append(key, entry));
          } else if (value) {
            responseHeaders.set(key, value);
          }
        }
        resolve(new Response(Buffer.concat(chunks), {
          status: response.statusCode ?? 500,
          headers: responseHeaders,
        }));
      });
    });
    request.on('error', reject);
    request.setTimeout(1000, () => {
      request.destroy(new Error('timeout'));
    });
    request.end();
  });
}

async function waitUntilGone(pid: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  throw new Error(`Owned process ${pid} was still running.`);
}

async function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('squatter did not bind a loopback port'));
        return;
      }
      resolve(address.port);
    });
  });
}

describe('owned Next.js server lifecycle', () => {
  it('allocates a port on 127.0.0.1', async () => {
    const port = await allocateLoopbackPort();
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ port, host: '127.0.0.1', exclusive: true }, () => resolve());
    });
    expect(server.address()).toMatchObject({ address: '127.0.0.1', port });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('refuses to signal an unowned process and uses a Windows process tree', async () => {
    expect(terminationPlan(43210, 'win32')).toEqual({
      kind: 'taskkill',
      command: 'taskkill',
      args: ['/PID', '43210', '/T', '/F'],
    });
    expect(terminationPlan(43210, 'linux')).toEqual({ kind: 'process-group', signal: 'SIGTERM' });
    expect(() => terminationPlan(1, 'linux')).toThrow(/does not own/);
    expect(() => terminationPlan(process.pid, 'linux')).toThrow(/does not own/);

    const killImpl = jest.fn();
    await expect(stopOwnedServer(fakeOwned(1), { platform: 'linux', killImpl })).rejects.toThrow(/does not own/);
    expect(killImpl).not.toHaveBeenCalled();

    const taskkill: string[][] = [];
    await stopOwnedServer(fakeOwned(43210), {
      platform: 'win32',
      execFileImpl: async (_command, args) => {
        taskkill.push(args);
      },
    });
    expect(taskkill).toEqual([['/PID', '43210', '/T', '/F']]);
    await expect(stopOwnedServer(fakeOwned(43210), {
      platform: 'win32',
      execFileImpl: async () => {
        throw new Error('ERROR: The process "43210" not found.');
      },
    })).resolves.toBeUndefined();
    await expect(stopOwnedServer(fakeOwned(43211), {
      platform: 'win32',
      execFileImpl: async () => {
        throw new Error('Access is denied.');
      },
    })).rejects.toThrow(/Access is denied/);

    const signals: Array<[number, NodeJS.Signals]> = [];
    await stopOwnedServer(fakeOwned(43210), {
      platform: 'linux',
      graceMs: 0,
      killImpl: (pid, signal) => {
        signals.push([pid, signal]);
        if (pid < 0 && signal === 'SIGTERM') {
          throw new Error('group unavailable');
        }
      },
    });
    expect(signals).toEqual([
      [-43210, 'SIGTERM'],
      [43210, 'SIGTERM'],
      [-43210, 'SIGKILL'],
    ]);
  });

  it('starts the fixture on loopback, proves ownership, and kills descendants', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chordmini-owned-'));
    const pidFile = path.join(dir, 'grandchild.pid');
    const envFile = path.join(dir, 'env.json');
    const owned = await startOwnedServer({
      serverEntry: FIXTURE,
      parentEnv: { ...process.env, PYTHON_API_URL: BACKEND },
      extraEnv: {
        HOSTNAME: '0.0.0.0',
        CHORDMINI_TEST_GRANDCHILD: '1',
        CHORDMINI_TEST_PIDFILE: pidFile,
        CHORDMINI_TEST_ENVFILE: envFile,
      },
      timeoutMs: 8000,
      intervalMs: 40,
      fetchImpl: loopbackFetch,
    });

    try {
      const recorded = JSON.parse(fs.readFileSync(envFile, 'utf8')) as {
        hostname: string;
        runtime: string;
        desktopMode: string;
        electronRunAsNode: string;
        hasPythonUrl: boolean;
      };
      expect(recorded).toEqual({
        hostname: '127.0.0.1',
        runtime: 'electron',
        desktopMode: '1',
        electronRunAsNode: '',
        hasPythonUrl: true,
      });
      expect(JSON.stringify(recorded)).not.toContain(BACKEND);
      expect(owned.origin).toBe(`http://127.0.0.1:${owned.port}`);

      const grandchildPid = Number(fs.readFileSync(pidFile, 'utf8'));
      expect(process.kill(grandchildPid, 0)).toBe(true);
      await stopOwnedServer(owned, { graceMs: 100 });
      await waitUntilGone(grandchildPid);
      await waitUntilGone(owned.child.pid ?? 0);
    } finally {
      await stopOwnedServer(owned, { graceMs: 50 });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  it('does not accept another process that answers on the chosen port', async () => {
    const squatter = http.createServer((_request, response) => {
      response.writeHead(200, {
        'content-type': 'application/json',
        'x-chordmini-proof': 'forged',
      });
      response.end(JSON.stringify({ ok: true, role: 'next-standalone' }));
    });
    const squatterPort = await listen(squatter);
    const ports: number[] = [];

    try {
      const owned = await startOwnedServer({
        serverEntry: FIXTURE,
        timeoutMs: 2000,
        intervalMs: 30,
        maxAttempts: 3,
        fetchImpl: loopbackFetch,
        allocatePort: async () => {
          if (ports.length === 0) {
            ports.push(squatterPort);
            return squatterPort;
          }
          const port = await allocateLoopbackPort();
          ports.push(port);
          return port;
        },
      });
      expect(owned.port).not.toBe(squatterPort);
      expect(ports.length).toBeGreaterThan(1);
      await stopOwnedServer(owned, { graceMs: 50 });
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  }, 20000);

  it('retries a port conflict and redacts secrets from the startup error', async () => {
    const conflictPorts: number[] = [];
    await expect(startOwnedServer({
      serverEntry: FIXTURE,
      extraEnv: { CHORDMINI_TEST_FAIL: 'EADDRINUSE' },
      timeoutMs: 2000,
      intervalMs: 20,
      maxAttempts: 3,
      allocatePort: async () => {
        const port = await allocateLoopbackPort();
        conflictPorts.push(port);
        return port;
      },
    })).rejects.toThrow(/did not become ready/);
    expect(conflictPorts).toHaveLength(3);

    await expect(startOwnedServer({
      serverEntry: FIXTURE,
      parentEnv: { ...process.env, PYTHON_API_URL: BACKEND },
      extraEnv: { CHORDMINI_TEST_LEAK: '1' },
      timeoutMs: 2000,
      intervalMs: 20,
      maxAttempts: 1,
    })).rejects.toThrow(/PYTHON_API_URL=\[redacted\]/);

    try {
      await startOwnedServer({
        serverEntry: FIXTURE,
        parentEnv: { ...process.env, PYTHON_API_URL: BACKEND },
        extraEnv: { CHORDMINI_TEST_LEAK: '1' },
        timeoutMs: 2000,
        intervalMs: 20,
        maxAttempts: 1,
      });
      throw new Error('expected the leak fixture to fail readiness');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(BACKEND);
      expect(message).not.toContain('private-token-value');
      expect(message).not.toMatch(/CHORDMINI_READY_TOKEN=[0-9a-f]{16,}/);
    }
  }, 20000);

  it('rejects a ready body whose proof does not belong to this process', async () => {
    await expect(startOwnedServer({
      serverEntry: FIXTURE,
      extraEnv: { CHORDMINI_TEST_BAD_PROOF: '1' },
      timeoutMs: 700,
      intervalMs: 40,
      maxAttempts: 1,
      fetchImpl: loopbackFetch,
    })).rejects.toThrow(/did not become ready/);
  }, 15000);

  it('refuses a relative server path', async () => {
    await expect(startOwnedServer({ serverEntry: 'server.js' })).rejects.toThrow(/standalone server is missing/);
  });
});
