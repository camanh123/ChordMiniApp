/**
 * @jest-environment node
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { GET } from '@/app/api/desktop/backend-status/route';
import { createBackendStatus, writeBackendStatus } from '@/desktop/localBackend';

describe('desktop backend status route', () => {
  const previous = {
    mode: process.env.CHORDMINI_DESKTOP_MODE,
    file: process.env.CHORDMINI_BACKEND_STATUS_FILE,
    key: process.env.CHORDMINI_BACKEND_STATUS_KEY,
  };

  afterEach(() => {
    if (previous.mode === undefined) delete process.env.CHORDMINI_DESKTOP_MODE;
    else process.env.CHORDMINI_DESKTOP_MODE = previous.mode;
    if (previous.file === undefined) delete process.env.CHORDMINI_BACKEND_STATUS_FILE;
    else process.env.CHORDMINI_BACKEND_STATUS_FILE = previous.file;
    if (previous.key === undefined) delete process.env.CHORDMINI_BACKEND_STATUS_KEY;
    else process.env.CHORDMINI_BACKEND_STATUS_KEY = previous.key;
  });

  it('stays hidden outside desktop mode', async () => {
    delete process.env.CHORDMINI_DESKTOP_MODE;
    const response = await GET();
    const body = await response.json() as { verified: boolean; code: string; inferenceVerified: boolean };
    expect(response.status).toBe(404);
    expect(body.verified).toBe(false);
    expect(body.code).toBe('NOT_DESKTOP');
    expect(body.inferenceVerified).toBe(false);
  });

  it('returns server and model flags without paths, secrets, or verified inference', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chordmini-status-route-'));
    const file = path.join(dir, 'backend-status.json');
    process.env.CHORDMINI_DESKTOP_MODE = '1';
    process.env.CHORDMINI_BACKEND_STATUS_FILE = file;
    delete process.env.CHORDMINI_BACKEND_STATUS_KEY;
    writeBackendStatus(file, createBackendStatus({
      phase: 'server-ready',
      code: 'MODEL_PREFLIGHT_READY',
      message: 'preflight C:\\Users\\private\\weights.pt cookie=sekret http://127.0.0.1:5001/health',
      serverReady: true,
      owned: true,
      identity: 'owned',
      models: { chordCnnLstm: true, beatTransformer: false, madmom: true },
    }));

    const response = await GET();
    const body = await response.json() as {
      serverReady: boolean;
      modelPreflightReady: boolean;
      inferenceVerified: boolean;
      reason: string;
      models: { chordCnnLstm: boolean; beatTransformer: boolean; madmom: boolean };
    };
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body.serverReady).toBe(true);
    expect(body.modelPreflightReady).toBe(true);
    expect(body.inferenceVerified).toBe(false);
    expect(body.models).toEqual({ chordCnnLstm: true, beatTransformer: false, madmom: true });
    expect(body.reason).toContain('[redacted-path]');
    expect(serialized).not.toMatch(/weights\.pt|Users\\|127\.0\.0\.1|sekret|cookie=/i);
    expect(serialized).not.toContain(file);
  });

  it('does not invent readiness when the supervisor record is missing', async () => {
    process.env.CHORDMINI_DESKTOP_MODE = '1';
    process.env.CHORDMINI_BACKEND_STATUS_FILE = path.join(os.tmpdir(), 'chordmini-missing-backend-status.json');
    delete process.env.CHORDMINI_BACKEND_STATUS_KEY;
    const response = await GET();
    const body = await response.json() as {
      verified: boolean;
      serverReady: boolean;
      code: string;
      inferenceVerified: boolean;
    };
    expect(response.status).toBe(200);
    expect(body.verified).toBe(false);
    expect(body.serverReady).toBe(false);
    expect(body.code).toBe('STATUS_UNVERIFIED');
    expect(body.inferenceVerified).toBe(false);
  });
});
