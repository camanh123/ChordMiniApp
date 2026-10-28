/**
 * @jest-environment node
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { analysisServiceGateResponse, desktopModelGateResponse } from '@/server/analysisServiceAvailability';
import { readAnalysisServiceFailure } from '@/utils/analysisServiceError';
import {
  backendInstanceProof,
  classifyOwnedHealth,
  consumeRetryRequest,
  createBackendStatus,
  isLegacyChordMiniRoot,
  isModelPreflightReady,
  modelsFromLegacyInfo,
  modelsFromReadiness,
  nextChildBackendEnv,
  pythonChildEnv,
  readBackendStatus,
  requestBackendRetry,
  resolveLocalBackendConfig,
  writeBackendStatus,
} from '@/desktop/localBackend';

const ROOT = process.cwd();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('local backend configuration', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'chordmini-backend-'));
  const pythonPath = path.join(temp, 'python');
  const backendDir = path.join(temp, 'python_backend');

  beforeAll(() => {
    fs.writeFileSync(pythonPath, '');
    fs.mkdirSync(backendDir);
    fs.writeFileSync(path.join(backendDir, 'app.py'), '# flask\n');
  });

  it('resolves an absolute Python executable and backend directory', () => {
    const resolved = resolveLocalBackendConfig({
      env: {
        CHORDMINI_PYTHON: pythonPath,
        CHORDMINI_BACKEND_DIR: backendDir,
      },
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.flaskEntry).toBe(path.join(backendDir, 'app.py'));
    }
  });

  it('reports a missing Python executable instead of a generic configuration code', () => {
    const resolved = resolveLocalBackendConfig({
      env: {
        CHORDMINI_PYTHON: path.join(temp, 'missing-python'),
        CHORDMINI_BACKEND_DIR: backendDir,
      },
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.code).toBe('PYTHON_MISSING');
      expect(resolved.message).toMatch(/Python executable is missing/);
    }
  });

  it('reports a missing backend directory', () => {
    const resolved = resolveLocalBackendConfig({
      env: {
        CHORDMINI_PYTHON: pythonPath,
        CHORDMINI_BACKEND_DIR: path.join(temp, 'missing-backend'),
      },
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.code).toBe('BACKEND_MISSING');
    }
  });

  it('reads the desktop config file and rejects relative paths', () => {
    const configFile = path.join(temp, 'local-backend.json');
    fs.writeFileSync(configFile, JSON.stringify({ pythonPath, backendDir }));
    const resolved = resolveLocalBackendConfig({
      env: { CHORDMINI_LOCAL_BACKEND_FILE: configFile },
    });
    expect(resolved.ok).toBe(true);

    const relative = resolveLocalBackendConfig({
      env: { CHORDMINI_PYTHON: 'python', CHORDMINI_BACKEND_DIR: backendDir },
    });
    expect(relative.ok).toBe(false);
    if (!relative.ok) {
      expect(relative.code).toBe('CONFIG_INVALID');
    }
  });

  it('does not hard-code a development machine path', () => {
    const sources = [
      'src/desktop/localBackend.ts',
      'src/desktop/ownedBackend.ts',
      'src/desktop/electronMain.ts',
    ].map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n');
    expect(sources).not.toMatch(/ChordMini-AI-venv|ChordMini-Backend-Ready|I:\\/);
  });

  it('puts the Beat-Transformer path only in the Python child environment', () => {
    const parent: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      PORT: '8080',
      FLASK_ENV: 'production',
      PYTHONPATH: '/unchanged',
      CHORDMINI_INFERENCE_AUTH: 'required',
      CHORDMINI_INFERENCE_SECRET: 'parent-secret-should-not-be-copied',
      CHORDMINI_HOSTED_GATEWAY_URL: 'https://gateway.example',
      PYTHON_API_URL: 'http://127.0.0.1:9',
      NODE_ENV: 'production',
    };
    const child = pythonChildEnv({
      parentEnv: parent,
      backendDir,
      port: 5001,
      nonce: 'nonce-value',
    });
    expect(child.PYTHONPATH).toBe(path.join(backendDir, 'models', 'Beat-Transformer', 'code'));
    expect(child.NODE_ENV).toBe('development');
    expect(child.FLASK_ENV).toBe('development');
    expect(child.CHORDMINI_INFERENCE_AUTH).toBe('local');
    expect(child.CHORDMINI_FLASK_PORT).toBe('5001');
    expect(child.PORT).toBeUndefined();
    expect(child.CHORDMINI_INFERENCE_SECRET).toBeUndefined();
    expect(child.CHORDMINI_HOSTED_GATEWAY_URL).toBeUndefined();
    expect(child.PYTHON_API_URL).toBeUndefined();
    expect(parent.PYTHONPATH).toBe('/unchanged');
    expect(parent.PORT).toBe('8080');
    expect(parent.FLASK_ENV).toBe('production');
    expect(parent.CHORDMINI_INFERENCE_AUTH).toBe('required');
  });

  it('gives the Next child the loopback origin without a public env key', () => {
    const env = nextChildBackendEnv({
      origin: 'http://127.0.0.1:5001',
      statusFile: path.join(temp, 'backend-status.json'),
      retryFile: path.join(temp, 'backend-retry.json'),
      nonce: 'secret-nonce',
      statusKey: 'status-key',
      retryToken: 'r'.repeat(32),
      allowLegacy: false,
      historyDir: path.join(temp, 'analysis-history'),
    });
    expect(env.PYTHON_API_URL).toBe('http://127.0.0.1:5001');
    expect(env.CHORDMINI_ANALYSIS_HISTORY_DIR).toBe(path.join(temp, 'analysis-history'));
    expect(env.NEXT_PUBLIC_ANALYSIS_HISTORY_DIR).toBeUndefined();
    expect(Object.keys(env).join(' ')).not.toMatch(/NEXT_PUBLIC_/);
    expect(env.CHORDMINI_INFERENCE_AUTH).toBe('local');
    expect(env.CHORDMINI_BACKEND_NONCE).toBe('secret-nonce');
    expect(env.CHORDMINI_BACKEND_SUPERVISED).toBe('1');
    expect(env.CHORDMINI_BACKEND_STATUS_KEY).toBe('status-key');
    expect(env.NODE_ENV).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(env, 'NODE_ENV')).toBe(false);
    expect(env.CHORDMINI_ALLOW_LEGACY_BACKEND).toBeUndefined();
    expect(env.NEXT_PUBLIC_PYTHON_API_URL).toBeUndefined();
    expect(Object.keys(env).join(' ')).not.toMatch(/NEXT_PUBLIC_PYTHON_API_URL/);
    const hidden = nextChildBackendEnv({
      origin: null,
      statusFile: path.join(temp, 'backend-status.json'),
      retryFile: path.join(temp, 'backend-retry.json'),
      nonce: null,
      statusKey: 'status-key',
      retryToken: 'r'.repeat(32),
      allowLegacy: false,
      historyDir: 'relative/history',
    });
    expect(hidden.CHORDMINI_ANALYSIS_HISTORY_DIR).toBeUndefined();
  });
});

describe('backend identity and model readiness', () => {
  const nonce = 'session-nonce';
  const challenge = 'ab'.repeat(16);
  const proof = backendInstanceProof(nonce, challenge);

  it('accepts only a fresh challenge proof as owned', () => {
    expect(classifyOwnedHealth({
      status: 'healthy',
      service: 'chordmini-flask',
      instance: proof,
    }, nonce, challenge)).toBe('owned');
    expect(classifyOwnedHealth({
      status: 'healthy',
      service: 'chordmini-flask',
      instance: proof,
    }, nonce, 'cd'.repeat(16))).toBe('mismatch');
    expect(classifyOwnedHealth({ status: 'healthy', service: 'chordmini-flask' }, nonce, challenge)).toBe('mismatch');
    expect(classifyOwnedHealth({ status: 'healthy' }, nonce, challenge)).toBe('mismatch');
    expect(classifyOwnedHealth({
      status: 'healthy',
      service: 'chordmini-flask',
      instance: proof,
    }, '', challenge)).toBe('mismatch');
  });

  it('recognizes a legacy ChordMini root without treating health alone as ready', () => {
    expect(isLegacyChordMiniRoot({
      status: 'healthy',
      message: 'Audio analysis API is running',
    })).toBe(true);
    expect(isLegacyChordMiniRoot({ status: 'healthy' })).toBe(false);
    expect(isLegacyChordMiniRoot({
      status: 'healthy',
      message: 'Audio analysis API is running',
      service: 'chordmini-flask',
    })).toBe(false);
    expect(isModelPreflightReady({ chordCnnLstm: null, beatTransformer: null, madmom: null })).toBe(false);
    expect(isModelPreflightReady({ chordCnnLstm: true, beatTransformer: false, madmom: true })).toBe(true);
    expect(isModelPreflightReady({ chordCnnLstm: false, beatTransformer: true, madmom: true })).toBe(false);
  });

  it('reads model flags from the readiness contract and the legacy info routes', () => {
    expect(modelsFromReadiness({
      service: 'chordmini-flask',
      proves: 'weight-files-and-imports',
      chordCnnLstm: true,
      beatTransformer: false,
      madmom: true,
    })).toEqual({ chordCnnLstm: true, beatTransformer: false, madmom: true });
    expect(modelsFromReadiness({ status: 'healthy' })).toBeNull();
    expect(modelsFromReadiness({
      service: 'chordmini-flask',
      proves: 'weight-files-and-imports',
      chordCnnLstm: true,
      beatTransformer: false,
      madmom: true,
      instance: proof,
    }, { nonce, challenge })).toEqual({ chordCnnLstm: true, beatTransformer: false, madmom: true });
    expect(modelsFromReadiness({
      service: 'chordmini-flask',
      proves: 'weight-files-and-imports',
      chordCnnLstm: true,
      beatTransformer: false,
      madmom: true,
      instance: proof,
    }, { nonce, challenge: 'cd'.repeat(16) })).toBeNull();
    expect(modelsFromLegacyInfo(
      {
        success: true,
        available_beat_models: ['madmom'],
        beat_transformer_available: false,
        madmom_available: true,
      },
      {
        success: true,
        chord_model_info: { 'chord-cnn-lstm': { available: true } },
      },
    )?.chordCnnLstm).toBe(true);
  });

  it('explains a supervised startup failure instead of the generic missing-service code', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chordmini-status-'));
    const statusFile = path.join(dir, 'backend-status.json');
    writeBackendStatus(statusFile, createBackendStatus({
      phase: 'failed',
      code: 'PYTHON_MISSING',
      message: 'The configured Python executable is missing. ChordMini did not start an analysis service.',
      serverReady: false,
      owned: false,
      identity: 'none',
    }));
    const env: NodeJS.ProcessEnv = {
      CHORDMINI_DESKTOP_MODE: '1',
      CHORDMINI_BACKEND_STATUS_FILE: statusFile,
    };
    const fetchImpl = jest.fn();
    const response = await analysisServiceGateResponse(env, fetchImpl, 50);
    const body = await response!.json() as { code: string; error: string; reason: string };
    expect(body.code).toBe('ANALYSIS_BACKEND_NOT_READY');
    expect(body.reason).toBe('PYTHON_MISSING');
    expect(body.error).toMatch(/Python executable is missing/);
    expect(body.error).not.toBe('Required service configuration missing');
    expect(JSON.stringify(body)).not.toMatch(/127\.0\.0\.1|localhost|https?:\/\//i);
    expect(fetchImpl).not.toHaveBeenCalled();
    const failure = readAnalysisServiceFailure(body);
    expect(failure?.code).toBe('ANALYSIS_BACKEND_NOT_READY');
    expect(failure?.message).toMatch(/Python executable is missing/);
  });

  it('does not treat a healthy port as analysis-ready when the owned identity does not match', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chordmini-status-'));
    const statusFile = path.join(dir, 'backend-status.json');
    writeBackendStatus(statusFile, createBackendStatus({
      phase: 'server-ready',
      code: 'READY',
      message: 'ready',
      serverReady: true,
      owned: true,
      identity: 'owned',
      models: { chordCnnLstm: true, beatTransformer: true, madmom: true },
    }));
    const env: NodeJS.ProcessEnv = {
      CHORDMINI_DESKTOP_MODE: '1',
      PYTHON_API_URL: 'http://127.0.0.1:5001',
      CHORDMINI_BACKEND_STATUS_FILE: statusFile,
      CHORDMINI_BACKEND_NONCE: nonce,
    };
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ status: 'healthy' }));
    const response = await analysisServiceGateResponse(env, fetchImpl, 50);
    const body = await response!.json() as { code: string; reason: string };
    expect(body.code).toBe('ANALYSIS_BACKEND_NOT_READY');
    expect(body.reason).toBe('PORT_IDENTITY_MISMATCH');
  });

  it('allows analysis only after server identity and model flags agree', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chordmini-status-'));
    const statusFile = path.join(dir, 'backend-status.json');
    writeBackendStatus(statusFile, createBackendStatus({
      phase: 'server-ready',
      code: 'READY',
      message: 'Chord-CNN-LSTM is available, and a beat detector is available.',
      serverReady: true,
      owned: true,
      identity: 'owned',
      models: { chordCnnLstm: true, beatTransformer: true, madmom: true },
    }));
    const env: NodeJS.ProcessEnv = {
      CHORDMINI_DESKTOP_MODE: '1',
      PYTHON_API_URL: 'http://127.0.0.1:5001',
      CHORDMINI_BACKEND_STATUS_FILE: statusFile,
      CHORDMINI_BACKEND_NONCE: nonce,
    };
    const fetchImpl = jest.fn(async (url: string) => {
      const challengeValue = new URL(String(url)).searchParams.get('challenge') ?? '';
      if (!challengeValue) {
        return jsonResponse({ status: 'healthy' });
      }
      return jsonResponse({
        status: 'healthy',
        service: 'chordmini-flask',
        instance: backendInstanceProof(nonce, challengeValue),
      });
    });
    await expect(analysisServiceGateResponse(env, fetchImpl as unknown as typeof fetch, 50)).resolves.toBeNull();
    expect(desktopModelGateResponse(env, 'beat', 'madmom')).toBeNull();
    expect(desktopModelGateResponse(env, 'chord', 'chord-cnn-lstm')).toBeNull();
    writeBackendStatus(statusFile, createBackendStatus({
      phase: 'failed',
      code: 'MODEL_UNAVAILABLE',
      message: 'The local analysis service is missing Chord-CNN-LSTM. No chords or beats were generated.',
      serverReady: true,
      owned: true,
      identity: 'owned',
      models: { chordCnnLstm: false, beatTransformer: true, madmom: true },
    }));
    const blocked = await analysisServiceGateResponse(env, jest.fn(async (url: string) => {
      const challengeValue = new URL(String(url)).searchParams.get('challenge') ?? '';
      if (!challengeValue) {
        return jsonResponse({ status: 'healthy' });
      }
      return jsonResponse({
        status: 'healthy',
        service: 'chordmini-flask',
        instance: backendInstanceProof(nonce, challengeValue),
      });
    }) as unknown as typeof fetch, 50);
    const blockedBody = await blocked!.json() as { code: string; error: string };
    expect(blockedBody.code).toBe('ANALYSIS_BACKEND_NOT_READY');
    expect(blockedBody.error).toMatch(/Chord-CNN-LSTM/);
    expect(JSON.stringify(blockedBody)).not.toMatch(/127\.0\.0\.1/);
  });

  it('blocks the selected detector when that model is unavailable', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chordmini-status-'));
    const statusFile = path.join(dir, 'backend-status.json');
    writeBackendStatus(statusFile, createBackendStatus({
      phase: 'server-ready',
      code: 'READY',
      message: 'Beat-Transformer is available.',
      serverReady: true,
      owned: true,
      identity: 'owned',
      models: { chordCnnLstm: true, beatTransformer: true, madmom: false },
    }));
    const env: NodeJS.ProcessEnv = {
      CHORDMINI_DESKTOP_MODE: '1',
      CHORDMINI_BACKEND_STATUS_FILE: statusFile,
    };
    const blocked = desktopModelGateResponse(env, 'beat', 'madmom');
    const body = await blocked!.json() as { error: string; code: string };
    expect(body.code).toBe('ANALYSIS_BACKEND_NOT_READY');
    expect(body.error).toMatch(/selected detector is not available/);
    expect(JSON.stringify(body)).not.toMatch(/127\.0\.0\.1/);
    expect(desktopModelGateResponse(env, 'beat', 'beat-transformer')).toBeNull();
    const untracked = desktopModelGateResponse(env, 'chord', 'btc-sl');
    const untrackedBody = await untracked!.json() as { error: string; code: string };
    expect(untrackedBody.code).toBe('ANALYSIS_BACKEND_NOT_READY');
    expect(untrackedBody.error).toMatch(/not part of startup preflight/);
  });

  it('writes a retry request the renderer cannot use to choose a command', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chordmini-retry-'));
    const file = path.join(dir, 'backend-retry.json');
    const token = 't'.repeat(32);
    expect(requestBackendRetry('relative.json', token)).toBe(false);
    expect(requestBackendRetry(file, 'short')).toBe(false);
    expect(requestBackendRetry(file, token)).toBe(true);
    expect(consumeRetryRequest(file, 'u'.repeat(32))).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
    expect(requestBackendRetry(file, token)).toBe(true);
    expect(consumeRetryRequest(file, token)).toBe(true);
    expect(consumeRetryRequest(file, token)).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('rejects a forged status file and does not treat preflight as inference', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chordmini-mac-'));
    const file = path.join(dir, 'backend-status.json');
    const key = 'k'.repeat(32);
    const status = createBackendStatus({
      phase: 'server-ready',
      code: 'MODEL_PREFLIGHT_READY',
      message: 'preflight only',
      serverReady: true,
      owned: true,
      identity: 'owned',
      models: { chordCnnLstm: true, beatTransformer: false, madmom: true },
    });
    writeBackendStatus(file, status, key);
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    } else {
      expect(fs.statSync(file).isFile()).toBe(true);
    }
    const forged = JSON.parse(fs.readFileSync(file, 'utf8')) as { mac: string };
    forged.mac = '0'.repeat(forged.mac.length);
    fs.writeFileSync(file, JSON.stringify(forged));
    expect(readBackendStatus({
      CHORDMINI_BACKEND_STATUS_FILE: file,
      CHORDMINI_BACKEND_STATUS_KEY: key,
    })).toBeNull();

    fs.writeFileSync(file, JSON.stringify({
      ...status,
      modelReady: true,
      modelPreflightReady: false,
      inferenceVerified: true,
      analysisReady: true,
    }));
    const unsigned = readBackendStatus({ CHORDMINI_BACKEND_STATUS_FILE: file });
    expect(unsigned?.inferenceVerified).toBe(false);
    expect(unsigned?.analysisReady).toBe(false);
    expect(unsigned?.modelPreflightReady).toBe(false);
    expect(readBackendStatus({
      CHORDMINI_BACKEND_STATUS_FILE: file,
      CHORDMINI_BACKEND_STATUS_KEY: key,
    })).toBeNull();
  });

  it('refuses to write the status file through a symlink', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chordmini-link-'));
    const real = path.join(dir, 'real.json');
    const link = path.join(dir, 'link.json');
    fs.writeFileSync(real, '{}');
    try {
      fs.symlinkSync(real, link);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code)
        : '';
      if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EACCES') {
        expect(fs.readFileSync(path.join(ROOT, 'src/desktop/localBackend.ts'), 'utf8'))
          .toMatch(/Refusing to write backend status through a symlink/);
        return;
      }
      throw error;
    }
    expect(() => writeBackendStatus(link, createBackendStatus({
      phase: 'failed',
      code: 'STATUS_UNVERIFIED',
      message: 'no',
      serverReady: false,
      owned: false,
      identity: 'none',
    }))).toThrow(/symlink/);
  });

  it('fails closed when supervision is on and the status file is missing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chordmini-missing-'));
    const env: NodeJS.ProcessEnv = {
      CHORDMINI_DESKTOP_MODE: '1',
      CHORDMINI_BACKEND_SUPERVISED: '1',
      PYTHON_API_URL: 'http://127.0.0.1:5001',
      CHORDMINI_BACKEND_STATUS_FILE: path.join(dir, 'missing.json'),
      CHORDMINI_BACKEND_STATUS_KEY: 'k'.repeat(32),
    };
    const fetchImpl = jest.fn();
    const response = await analysisServiceGateResponse(env, fetchImpl, 50);
    const body = await response!.json() as { code: string; reason: string };
    expect(body.code).toBe('ANALYSIS_BACKEND_NOT_READY');
    expect(body.reason).toBe('STATUS_UNVERIFIED');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('requires the legacy test flag and the root contract, not /health alone', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chordmini-legacy-'));
    const statusFile = path.join(dir, 'backend-status.json');
    writeBackendStatus(statusFile, createBackendStatus({
      phase: 'server-ready',
      code: 'MODEL_PREFLIGHT_READY',
      message: 'legacy preflight',
      serverReady: true,
      owned: false,
      identity: 'legacy',
      models: { chordCnnLstm: true, beatTransformer: true, madmom: true },
    }));
    const env: NodeJS.ProcessEnv = {
      CHORDMINI_DESKTOP_MODE: '1',
      PYTHON_API_URL: 'http://127.0.0.1:5001',
      CHORDMINI_BACKEND_STATUS_FILE: statusFile,
    };
    const fetchImpl = jest.fn();
    const blocked = await analysisServiceGateResponse(env, fetchImpl, 50);
    const blockedBody = await blocked!.json() as { reason: string };
    expect(blockedBody.reason).toBe('PORT_IDENTITY_MISMATCH');
    expect(fetchImpl).not.toHaveBeenCalled();

    env.CHORDMINI_ALLOW_LEGACY_BACKEND = '1';
    const healthOnly = jest.fn(async (url: string) => {
      if (String(url).endsWith('/health')) {
        return jsonResponse({ status: 'healthy' });
      }
      return jsonResponse({ status: 'healthy', message: 'not the contract' });
    });
    const stillBlocked = await analysisServiceGateResponse(env, healthOnly as unknown as typeof fetch, 50);
    const stillBody = await stillBlocked!.json() as { reason: string; error: string };
    expect(stillBody.reason).toBe('PORT_IDENTITY_MISMATCH');
    expect(stillBody.error).toMatch(/health response is not identity/i);

    const allowed = jest.fn(async (url: string) => {
      if (String(url).endsWith('/health')) {
        return jsonResponse({ status: 'healthy' });
      }
      return jsonResponse({ status: 'healthy', message: 'Audio analysis API is running' });
    });
    await expect(analysisServiceGateResponse(env, allowed as unknown as typeof fetch, 50)).resolves.toBeNull();
  });
});
