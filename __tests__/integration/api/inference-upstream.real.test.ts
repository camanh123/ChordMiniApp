/**
 * @jest-environment node
 *
 * GENUINE inference: Next.js route handlers call loopback Flask.
 * Madmom and Chord-CNN-LSTM run when the isolated model environment is present.
 * This file does not mock model responses. It skips only when those assets are absent.
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';
jest.mock('@/utils/environmentUtils', () => ({
  createSafeTimeoutSignal: () => new AbortController().signal,
}));

const mockVerifyIdToken = jest.fn();

jest.mock('@/utils/firebaseAdmin', () => ({
  getFirebaseAdminAuth: jest.fn(async () => ({
    verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args),
  })),
}));

import undici from 'undici';
import { gatewayAdmissionSnapshot, resetGatewayAdmissionForTests } from '@/server/gatewayAdmission';
import { inspectHostedAudio } from '@/server/gatewayAudioGuard';
import { readMp3Duration } from '@/server/mp3FrameDuration';
import { POST as postBeats } from '@/app/api/detect-beats/route';
import { POST as postChords } from '@/app/api/recognize-chords/route';

const ROOT = process.cwd();
const PYTHON = '/tmp/chordmini-bt02-venv/bin/python';
const WEIGHT = path.join(
  ROOT,
  'python_backend/models/Chord-CNN-LSTM/cache_data/joint_chord_net_ismir_naive_v1.0_reweight(0.0,10.0)_s0.best.sdict',
);
const EVIDENCE = path.join(ROOT, 'python_backend/research/backend_02_inference_evidence.json');
const READY = fs.existsSync(PYTHON) && fs.existsSync(WEIGHT) && fs.existsSync(EVIDENCE);

/**
 * Jest replaces the process fetch. The bundled undici copy only serializes
 * its own FormData, so a Node FormData would be sent as the text
 * "[object FormData]". Convert it before forwarding. This is the same
 * multipart body Node's native fetch produces.
 */
const realFetch: typeof fetch = async (input, init) => {
  if (init?.body instanceof FormData) {
    const converted = new undici.FormData();
    for (const [key, value] of init.body.entries()) {
      if (typeof value === 'string') {
        converted.append(key, value);
      } else {
        converted.append(key, value, value.name);
      }
    }
    return undici.fetch(input, { ...init, body: converted }) as Promise<Response>;
  }
  return undici.fetch(input, init) as Promise<Response>;
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('no loopback port'));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function requestWith(fields: Record<string, string>, file: File) {
  const formData = new FormData();
  formData.append('file', file);
  for (const [key, value] of Object.entries(fields)) {
    formData.append(key, value);
  }
  return { formData: async () => formData, headers: new Headers() } as never;
}

function closeEnough(actual: number[], expected: number[], tolerance: number): boolean {
  return actual.length === expected.length
    && actual.every((value, index) => Math.abs(value - expected[index]) <= tolerance);
}

async function waitForHealth(origin: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 120000;
  let last = 'not started';
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`Flask exited before health (${child.exitCode})`);
    }
    try {
      const response = await realFetch(`${origin}/health`);
      if (response.ok) {
        return;
      }
      last = `status ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`Flask health timed out: ${last}`);
}

(READY ? describe : describe.skip)('GENUINE Next.js to Flask inference', () => {
  const originalFetch = global.fetch;
  const original = {
    auth: process.env.CHORDMINI_INFERENCE_AUTH,
    secret: process.env.CHORDMINI_INFERENCE_SECRET,
    desktop: process.env.CHORDMINI_DESKTOP_MODE,
    python: process.env.PYTHON_API_URL,
  };
  let child: ChildProcess | null = null;
  let secret = '';
  let logs = '';

  beforeAll(async () => {
    secret = randomBytes(32).toString('hex');
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    process.env.CHORDMINI_INFERENCE_AUTH = 'required';
    process.env.CHORDMINI_INFERENCE_SECRET = secret;
    process.env.PYTHON_API_URL = origin;
    delete process.env.CHORDMINI_DESKTOP_MODE;
    delete process.env.CHORDMINI_HOSTED_STAGING_AUTH;
    delete process.env.CHORDMINI_STAGING_ALLOWED_UIDS;
    delete process.env.CHORDMINI_HOSTED_GATEWAY_URL;
    delete process.env.CHORDMINI_HOSTED_GATEWAY_TEST_LOOPBACK;
    delete process.env.CHORDMINI_GATEWAY_ADMISSION;
    delete process.env.CHORDMINI_GATEWAY_INSTANCES;
    global.fetch = realFetch;

    child = spawn(PYTHON, [
      path.join(ROOT, 'python_backend/research/serve_localhost_inference.py'),
      String(port),
    ], {
      cwd: path.join(ROOT, 'python_backend'),
      env: {
        ...process.env,
        TESTING: '1',
        CHORDMINI_INFERENCE_AUTH: 'required',
        CHORDMINI_INFERENCE_SECRET: secret,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk) => {
      logs += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      logs += chunk.toString();
    });
    try {
      await waitForHealth(origin, child);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : error}\n${logs.split(secret).join('[redacted]').slice(-2000)}`);
    }
  }, 150000);

  afterAll(async () => {
    if (child && child.exitCode == null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (child.exitCode == null) {
        child.kill('SIGKILL');
      }
    }
    global.fetch = originalFetch;
    if (original.auth === undefined) delete process.env.CHORDMINI_INFERENCE_AUTH;
    else process.env.CHORDMINI_INFERENCE_AUTH = original.auth;
    if (original.secret === undefined) delete process.env.CHORDMINI_INFERENCE_SECRET;
    else process.env.CHORDMINI_INFERENCE_SECRET = original.secret;
    if (original.desktop === undefined) delete process.env.CHORDMINI_DESKTOP_MODE;
    else process.env.CHORDMINI_DESKTOP_MODE = original.desktop;
    if (original.python === undefined) delete process.env.PYTHON_API_URL;
    else process.env.PYTHON_API_URL = original.python;
  });

  it('rejects a direct unauthenticated Flask upload and returns genuine model output through Next.js', async () => {
    const evidence = JSON.parse(fs.readFileSync(EVIDENCE, 'utf8')) as {
      fixture: { sha256: string };
      beats: {
        beats: number[];
        downbeats: number[];
        bpm: number;
        model_used: string;
        success: boolean;
      };
      chords: {
        chords: Array<{ chord: string; start: number; end: number }>;
        chord_dict: string;
        model_used: string;
        success: boolean;
      };
    };
    const generated = spawnSync(PYTHON, ['-c', [
      'import importlib.util, json',
      'from pathlib import Path',
      'path = Path("python_backend/research/run_minimum_inference.py")',
      'spec = importlib.util.spec_from_file_location("backend_02_runner", path)',
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'info = module.write_fixture(module.FIXTURE_PATH)',
      'print(json.dumps({"path": str(info["path"]), "sha256": info["sha256"]}))',
    ].join('\n')], { cwd: ROOT, encoding: 'utf8' });
    if (generated.status !== 0) {
      throw new Error(String(generated.stderr || generated.stdout || 'fixture generation failed').split(secret).join('[redacted]'));
    }
    const fixture = JSON.parse(generated.stdout.trim()) as { path: string; sha256: string };
    expect(fixture.sha256).toBe(evidence.fixture.sha256);
    const bytes = fs.readFileSync(fixture.path);
    const audio = new File([bytes], 'fixture.wav', { type: 'audio/wav' });

    const origin = process.env.PYTHON_API_URL as string;
    const deniedForm = new FormData();
    deniedForm.append('detector', 'madmom');
    deniedForm.append('file', new File([bytes], 'fixture.wav', { type: 'audio/wav' }));
    const denied = await realFetch(`${origin}/api/detect-beats`, { method: 'POST', body: deniedForm });
    const deniedText = await denied.text();
    expect(denied.status).toBe(401);
    expect(deniedText).toContain('AUTH_REQUIRED');
    expect(deniedText).not.toContain(secret);

    const beatsResponse = await postBeats(requestWith({ detector: 'madmom' }, audio));
    const beats = await beatsResponse.json() as {
      success: boolean;
      beats: number[];
      downbeats: number[];
      bpm: number;
      model_used: string;
    };
    const beatsText = JSON.stringify(beats);
    expect(beatsResponse.status).toBe(200);
    expect(beatsText).not.toContain(secret);
    expect(beats.success).toBe(true);
    expect(beats.model_used).toBe(evidence.beats.model_used);
    expect(beats.bpm).toBeCloseTo(evidence.beats.bpm, 2);
    expect(closeEnough(beats.beats, evidence.beats.beats, 1e-3)).toBe(true);
    expect(closeEnough(beats.downbeats, evidence.beats.downbeats, 1e-3)).toBe(true);

    const chordFile = new File([bytes], 'fixture.wav', { type: 'audio/wav' });
    const chordsResponse = await postChords(requestWith({
      detector: 'chord-cnn-lstm',
      model: 'chord-cnn-lstm',
      chord_dict: 'submission',
    }, chordFile));
    const chords = await chordsResponse.json() as {
      success: boolean;
      model_used: string;
      chord_dict: string;
      chords: Array<{ chord: string; start: number; end: number; confidence?: number }>;
    };
    const chordsText = JSON.stringify(chords);
    expect(chordsResponse.status).toBe(200);
    expect(chordsText).not.toContain(secret);
    expect(chords.success).toBe(true);
    expect(chords.model_used).toBe('chord-cnn-lstm');
    expect(chords.chord_dict).toBe('submission');
    expect(chords.chords).toHaveLength(evidence.chords.chords.length);
    chords.chords.forEach((row, index) => {
      const expected = evidence.chords.chords[index];
      expect(row.chord).toBe(expected.chord);
      expect(Math.abs(row.start - expected.start)).toBeLessThanOrEqual(1e-3);
      expect(Math.abs(row.end - expected.end)).toBeLessThanOrEqual(1e-3);
    });
    expect(logs).not.toContain(secret);
  }, 480000);

  it('forwards a desktop bearer token through a MOCKED-identity gateway to real models', async () => {
    const evidence = JSON.parse(fs.readFileSync(EVIDENCE, 'utf8')) as {
      beats: { beats: number[]; downbeats: number[]; bpm: number; model_used: string };
      chords: { chords: Array<{ chord: string; start: number; end: number }> };
    };
    const generated = spawnSync(PYTHON, ['-c', [
      'import importlib.util, json',
      'from pathlib import Path',
      'path = Path("python_backend/research/run_minimum_inference.py")',
      'spec = importlib.util.spec_from_file_location("backend_02_runner", path)',
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'info = module.write_fixture(module.FIXTURE_PATH)',
      'print(json.dumps({"path": str(info["path"])}))',
    ].join('\n')], { cwd: ROOT, encoding: 'utf8' });
    if (generated.status !== 0) {
      throw new Error(String(generated.stderr || generated.stdout || 'fixture generation failed').split(secret).join('[redacted]'));
    }
    const fixture = JSON.parse(generated.stdout.trim()) as { path: string };
    const bytes = fs.readFileSync(fixture.path);
    const flaskOrigin = process.env.PYTHON_API_URL as string;
    const gatewayOrigin = 'http://localhost:9';
    const userToken = 'eyJhbGciOiJub25lIn0.eyJ1aWQiOiJhbGxvd2VkIn0.signature';
    const allowedUid = 'allowed-staging-uid';
    mockVerifyIdToken.mockReset();
    mockVerifyIdToken.mockResolvedValue({ uid: allowedUid });

    const saved = {
      desktop: process.env.CHORDMINI_DESKTOP_MODE,
      gateway: process.env.CHORDMINI_HOSTED_GATEWAY_URL,
      loopback: process.env.CHORDMINI_HOSTED_GATEWAY_TEST_LOOPBACK,
      auth: process.env.CHORDMINI_INFERENCE_AUTH,
      inferenceSecret: process.env.CHORDMINI_INFERENCE_SECRET,
      staging: process.env.CHORDMINI_HOSTED_STAGING_AUTH,
      allow: process.env.CHORDMINI_STAGING_ALLOWED_UIDS,
      admin: process.env.FIREBASE_SERVICE_ACCOUNT_KEY,
      python: process.env.PYTHON_API_URL,
    };
    const restore = () => {
      const write = (key: string, value: string | undefined) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      };
      write('CHORDMINI_DESKTOP_MODE', saved.desktop);
      write('CHORDMINI_HOSTED_GATEWAY_URL', saved.gateway);
      write('CHORDMINI_HOSTED_GATEWAY_TEST_LOOPBACK', saved.loopback);
      write('CHORDMINI_INFERENCE_AUTH', saved.auth);
      write('CHORDMINI_INFERENCE_SECRET', saved.inferenceSecret);
      write('CHORDMINI_HOSTED_STAGING_AUTH', saved.staging);
      write('CHORDMINI_STAGING_ALLOWED_UIDS', saved.allow);
      write('FIREBASE_SERVICE_ACCOUNT_KEY', saved.admin);
      write('PYTHON_API_URL', saved.python);
    };

    const emulateHosted = async (url: string, init: RequestInit | undefined) => {
      const snapshot = { ...process.env };
      delete process.env.CHORDMINI_DESKTOP_MODE;
      delete process.env.CHORDMINI_HOSTED_GATEWAY_URL;
      delete process.env.CHORDMINI_HOSTED_GATEWAY_TEST_LOOPBACK;
      process.env.CHORDMINI_HOSTED_STAGING_AUTH = 'required';
      process.env.CHORDMINI_STAGING_ALLOWED_UIDS = allowedUid;
      process.env.CHORDMINI_INFERENCE_AUTH = 'required';
      process.env.CHORDMINI_INFERENCE_SECRET = secret;
      process.env.PYTHON_API_URL = flaskOrigin;
      process.env.FIREBASE_SERVICE_ACCOUNT_KEY = JSON.stringify({
        project_id: 'staging-test',
        private_key: 'test-only-not-a-credential',
        client_email: 'staging-test@example.invalid',
      });
      process.env.CHORDMINI_GATEWAY_ADMISSION = 'process';
      process.env.CHORDMINI_GATEWAY_INSTANCES = '1';
      try {
        const headers = new Headers(init?.headers);
        const request = {
          formData: async () => init?.body as FormData,
          headers,
          signal: init?.signal ?? undefined,
        } as never;
        const hosted = url.endsWith('/api/recognize-chords')
          ? await postChords(request)
          : await postBeats(request);
        const text = await hosted.text();
        return new Response(text, { status: hosted.status });
      } finally {
        for (const key of Object.keys(process.env)) {
          if (!(key in snapshot)) delete process.env[key];
        }
        Object.assign(process.env, snapshot);
      }
    };

    process.env.CHORDMINI_DESKTOP_MODE = '1';
    process.env.CHORDMINI_HOSTED_GATEWAY_URL = gatewayOrigin;
    process.env.CHORDMINI_HOSTED_GATEWAY_TEST_LOOPBACK = '1';
    delete process.env.CHORDMINI_INFERENCE_SECRET;
    delete process.env.CHORDMINI_INFERENCE_AUTH;
    delete process.env.CHORDMINI_HOSTED_STAGING_AUTH;
    global.fetch = async (input, init) => {
      const url = String(input);
      if (url.startsWith(gatewayOrigin)) {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        expect(headers.Authorization).toBe(`Bearer ${userToken}`);
        expect(JSON.stringify(headers)).not.toContain(secret);
        expect(headers['X-ChordMini-Inference-Token']).toBeUndefined();
        return emulateHosted(url, init);
      }
      if (url.includes('/api/detect-beats') || url.includes('/api/recognize-chords')) {
        const flaskHeaders = new Headers(init?.headers);
        expect(flaskHeaders.get('x-chordmini-inference-token')).toBe(secret);
      }
      return realFetch(input, init);
    };

    resetGatewayAdmissionForTests();
    try {
      const audio = new File([bytes], 'fixture.wav', { type: 'audio/wav' });
      const beatsResponse = await postBeats({
        ...requestWith({ detector: 'madmom' }, audio),
        headers: new Headers({ authorization: `Bearer ${userToken}` }),
      } as never);
      const beats = await beatsResponse.json() as {
        success: boolean;
        beats: number[];
        downbeats: number[];
        bpm: number;
        model_used: string;
      };
      const beatsText = JSON.stringify(beats);
      expect(beatsResponse.status).toBe(200);
      expect(beats.success).toBe(true);
      expect(beats.model_used).toBe(evidence.beats.model_used);
      expect(beats.bpm).toBeCloseTo(evidence.beats.bpm, 2);
      expect(closeEnough(beats.beats, evidence.beats.beats, 1e-3)).toBe(true);
      expect(closeEnough(beats.downbeats, evidence.beats.downbeats, 1e-3)).toBe(true);
      expect(beatsText).not.toContain(secret);
      expect(beatsText).not.toContain(flaskOrigin);
      expect(beatsText).not.toContain(userToken);
      expect(mockVerifyIdToken).toHaveBeenCalledWith(userToken, true);

      const chordsResponse = await postChords({
        ...requestWith({
          detector: 'chord-cnn-lstm',
          model: 'chord-cnn-lstm',
          chord_dict: 'submission',
        }, new File([bytes], 'fixture.wav', { type: 'audio/wav' })),
        headers: new Headers({ authorization: `Bearer ${userToken}` }),
      } as never);
      const chords = await chordsResponse.json() as {
        success: boolean;
        model_used: string;
        chord_dict: string;
        chords: Array<{ chord: string; start: number; end: number }>;
      };
      expect(chordsResponse.status).toBe(200);
      expect(chords.success).toBe(true);
      expect(chords.model_used).toBe('chord-cnn-lstm');
      expect(chords.chord_dict).toBe('submission');
      expect(chords.chords).toHaveLength(evidence.chords.chords.length);
      chords.chords.forEach((row, index) => {
        const expected = evidence.chords.chords[index];
        expect(row.chord).toBe(expected.chord);
        expect(Math.abs(row.start - expected.start)).toBeLessThanOrEqual(1e-3);
        expect(Math.abs(row.end - expected.end)).toBeLessThanOrEqual(1e-3);
      });
      expect(JSON.stringify(chords)).not.toContain(secret);
      expect(logs).not.toContain(secret);
    } finally {
      global.fetch = realFetch;
      restore();
    }
  }, 480000);

  it('analyzes PCM WAV, LAME MP3, and large-ID3 MP3 through a MOCKED-identity gateway', async () => {
    const evidencePath = path.join(ROOT, 'python_backend/research/backend_04g_decode_evidence.json');
    const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8')) as {
      fixtures: Record<string, { sha256: string; path: string }>;
      results: Record<string, {
        beats: { beats: number[]; downbeats: number[]; bpm: number; model_used: string; success: boolean };
        chords: { chords: Array<{ chord: string; start: number; end: number }>; model_used: string; success: boolean };
      }>;
    };
    const generated = spawnSync(PYTHON, [
      '-c',
      [
        'import json, sys',
        'sys.path.insert(0, "python_backend")',
        'from research.backend_04g_decode_inference import write_fixtures',
        'fixtures = write_fixtures()',
        'print(json.dumps({name: {"path": item["path"], "sha256": item["sha256"]} for name, item in fixtures.items() if name != "ground_truth"}))',
      ].join('\n'),
    ], { cwd: ROOT, encoding: 'utf8' });
    if (generated.status !== 0) {
      throw new Error(String(generated.stderr || generated.stdout || 'fixture generation failed').split(secret).join('[redacted]'));
    }
    const fixtures = JSON.parse(generated.stdout.trim()) as Record<string, { path: string; sha256: string }>;
    for (const name of ['wav', 'mp3', 'large_id3']) {
      expect(fixtures[name].sha256).toBe(evidence.fixtures[name].sha256);
    }

    const flaskOrigin = process.env.PYTHON_API_URL as string;
    const userToken = 'eyJhbGciOiJub25lIn0.eyJ1aWQiOiJhbGxvd2VkIn0.signature';
    const allowedUid = 'allowed-staging-uid';
    mockVerifyIdToken.mockReset();
    mockVerifyIdToken.mockResolvedValue({ uid: allowedUid });
    const savedStaging = {
      staging: process.env.CHORDMINI_HOSTED_STAGING_AUTH,
      allow: process.env.CHORDMINI_STAGING_ALLOWED_UIDS,
      admin: process.env.FIREBASE_SERVICE_ACCOUNT_KEY,
      admission: process.env.CHORDMINI_GATEWAY_ADMISSION,
      instances: process.env.CHORDMINI_GATEWAY_INSTANCES,
      desktop: process.env.CHORDMINI_DESKTOP_MODE,
    };
    delete process.env.CHORDMINI_DESKTOP_MODE;
    process.env.CHORDMINI_HOSTED_STAGING_AUTH = 'required';
    process.env.CHORDMINI_STAGING_ALLOWED_UIDS = allowedUid;
    process.env.FIREBASE_SERVICE_ACCOUNT_KEY = JSON.stringify({
      project_id: 'staging-test',
      private_key: 'test-only-not-a-credential',
      client_email: 'staging-test@example.invalid',
    });
    process.env.CHORDMINI_GATEWAY_ADMISSION = 'process';
    process.env.CHORDMINI_GATEWAY_INSTANCES = '1';
    const timings: Record<string, { beatsMs: number; chordsMs: number }> = {};
    global.fetch = async (input, init) => {
      const url = String(input);
      if (url.startsWith(flaskOrigin)) {
        const headers = new Headers(init?.headers);
        expect(headers.get('x-chordmini-inference-token')).toBe(secret);
        expect(headers.get('authorization')).toBeNull();
      }
      return realFetch(input, init);
    };

    try {
      const denied = await realFetch(`${flaskOrigin}/api/detect-beats`, {
        method: 'POST',
        body: (() => {
          const form = new FormData();
          form.append('detector', 'madmom');
          form.append('file', new File([fs.readFileSync(fixtures.large_id3.path)], 'tagged.mp3', { type: 'audio/mpeg' }));
          return form;
        })(),
      });
      expect(denied.status).toBe(401);

      for (const name of ['wav', 'mp3', 'large_id3'] as const) {
        const bytes = new Uint8Array(fs.readFileSync(fixtures[name].path));
        const type = name === 'wav' ? 'audio/wav' : 'audio/mpeg';
        const filename = name === 'wav' ? 'master.wav' : 'lame.mp3';
        resetGatewayAdmissionForTests();
        const hostedFile = new File([bytes], filename, { type });
        const guard = await inspectHostedAudio(hostedFile, process.env);
        expect(guard).toEqual({ ok: true });
        if (name !== 'wav') {
          const duration = readMp3Duration(bytes, 300);
          expect(duration.ok).toBe(true);
          if (duration.ok) {
            expect(duration.seconds).toBeGreaterThan(11);
            expect(duration.seconds).toBeLessThanOrEqual(300);
          }
        }

        const directBeats = await realFetch(`${flaskOrigin}/api/detect-beats`, {
          method: 'POST',
          headers: { 'X-ChordMini-Inference-Token': secret },
          body: (() => {
            const form = new FormData();
            form.append('detector', 'madmom');
            form.append('file', new File([bytes], filename, { type }));
            return form;
          })(),
        });
        const directBeatBody = await directBeats.json() as { success: boolean; model_used: string; bpm: number };
        expect(directBeats.status).toBe(200);
        expect(directBeatBody.success).toBe(true);
        expect(directBeatBody.model_used).toBe('madmom');
        expect(JSON.stringify(directBeatBody)).not.toContain(secret);

        const startedBeats = Date.now();
        const beatsResponse = await postBeats({
          ...requestWith({ detector: 'madmom' }, new File([bytes], filename, { type })),
          headers: new Headers({ authorization: `Bearer ${userToken}` }),
        } as never);
        const beatsMs = Date.now() - startedBeats;
        const beats = await beatsResponse.json() as {
          success: boolean;
          beats: number[];
          downbeats: number[];
          bpm: number;
          model_used: string;
        };
        expect(beatsResponse.status).toBe(200);
        expect(beats.success).toBe(true);
        expect(beats.model_used).toBe('madmom');
        expect(beats.bpm).toBeCloseTo(evidence.results[name].beats.bpm, 2);
        expect(closeEnough(beats.beats, evidence.results[name].beats.beats, 1e-3)).toBe(true);
        expect(closeEnough(beats.downbeats, evidence.results[name].beats.downbeats, 1e-3)).toBe(true);
        expect(JSON.stringify(beats)).not.toContain(secret);
        expect(gatewayAdmissionSnapshot(allowedUid)).toEqual({ globalActive: 0, uidActive: 0 });

        const startedChords = Date.now();
        const chordsResponse = await postChords({
          ...requestWith({
            detector: 'chord-cnn-lstm',
            model: 'chord-cnn-lstm',
            chord_dict: 'submission',
          }, new File([bytes], filename, { type })),
          headers: new Headers({ authorization: `Bearer ${userToken}` }),
        } as never);
        const chordsMs = Date.now() - startedChords;
        const chords = await chordsResponse.json() as {
          success: boolean;
          model_used: string;
          chord_dict: string;
          chords: Array<{ chord: string; start: number; end: number; confidence?: number }>;
        };
        expect(chordsResponse.status).toBe(200);
        expect(chords.success).toBe(true);
        expect(chords.model_used).toBe('chord-cnn-lstm');
        expect(chords.chord_dict).toBe('submission');
        expect(chords.chords.map((row) => row.chord)).toEqual(
          evidence.results[name].chords.chords.map((row) => row.chord),
        );
        chords.chords.forEach((row, index) => {
          const expected = evidence.results[name].chords.chords[index];
          expect(Math.abs(row.start - expected.start)).toBeLessThanOrEqual(1e-3);
          expect(Math.abs(row.end - expected.end)).toBeLessThanOrEqual(1e-3);
          expect(row.confidence).toBe(1);
        });
        expect(JSON.stringify(chords)).not.toContain(secret);
        expect(gatewayAdmissionSnapshot(allowedUid)).toEqual({ globalActive: 0, uidActive: 0 });
        timings[name] = { beatsMs, chordsMs };
      }
      expect(mockVerifyIdToken).toHaveBeenCalledWith(userToken, true);
      expect(logs).not.toContain(secret);
      const statusPath = `/proc/${child?.pid}/status`;
      const status = child?.pid && fs.existsSync(statusPath) ? fs.readFileSync(statusPath, 'utf8') : '';
      const peak = status.match(/VmHWM:\s+(\d+)/);
      fs.writeFileSync('/tmp/chordmini-04g-gateway-timings.json', JSON.stringify({
        timings,
        flaskVmHwmKb: peak ? Number(peak[1]) : null,
        firebaseIdentity: 'MOCKED',
      }));
    } finally {
      global.fetch = realFetch;
      resetGatewayAdmissionForTests();
      const restoreKey = (key: string, value: string | undefined) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      };
      restoreKey('CHORDMINI_HOSTED_STAGING_AUTH', savedStaging.staging);
      restoreKey('CHORDMINI_STAGING_ALLOWED_UIDS', savedStaging.allow);
      restoreKey('FIREBASE_SERVICE_ACCOUNT_KEY', savedStaging.admin);
      restoreKey('CHORDMINI_GATEWAY_ADMISSION', savedStaging.admission);
      restoreKey('CHORDMINI_GATEWAY_INSTANCES', savedStaging.instances);
      restoreKey('CHORDMINI_DESKTOP_MODE', savedStaging.desktop);
    }
  }, 480000);

  it('analyzes a longer synthetic WAV and LAME MP3 through a MOCKED-identity gateway', async () => {
    // MOCKED verifyIdToken is not production Firebase. Generator agreement is
    // not real-music accuracy; the evidence file records that status.
    const evidencePath = path.join(ROOT, 'python_backend/research/backend_04h_benchmark_evidence.json');
    const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8')) as {
      real_music_accuracy_status: string;
      dataset: { real_performance_audio: boolean; independent_ground_truth: boolean };
      fixtures: Record<string, { sha256: string; bytes: number; duration_seconds_generated: number }>;
      results: Record<string, {
        beats: { beats: number[]; downbeats: number[]; bpm: number; model_used: string; success: boolean };
        chords: { chords: Array<{ chord: string; start: number; end: number; confidence?: number }>; model_used: string; success: boolean };
      }>;
    };
    expect(evidence.real_music_accuracy_status).toBe('BLOCKED');
    expect(evidence.dataset.real_performance_audio).toBe(false);
    expect(evidence.dataset.independent_ground_truth).toBe(false);
    expect(evidence.fixtures.long_wav.duration_seconds_generated).toBeGreaterThanOrEqual(60);
    expect(evidence.fixtures.long_wav.duration_seconds_generated).toBeLessThanOrEqual(180);
    expect(evidence.fixtures.long_wav.bytes).toBeLessThan(5 * 1024 * 1024);

    const generated = spawnSync(PYTHON, [
      '-c',
      [
        'import json, sys',
        'sys.path.insert(0, "python_backend")',
        'from research.backend_04h_benchmark import write_benchmark_fixtures',
        'fixtures = write_benchmark_fixtures()',
        'print(json.dumps({name: {"path": item["path"], "sha256": item["sha256"], "bytes": item["bytes"]} for name, item in fixtures.items()}))',
      ].join('\n'),
    ], { cwd: ROOT, encoding: 'utf8' });
    if (generated.status !== 0) {
      throw new Error(String(generated.stderr || generated.stdout || 'fixture generation failed').split(secret).join('[redacted]'));
    }
    const fixtures = JSON.parse(generated.stdout.trim()) as Record<string, { path: string; sha256: string; bytes: number }>;
    for (const name of ['reference_wav', 'long_wav', 'long_mp3']) {
      expect(fixtures[name].sha256).toBe(evidence.fixtures[name].sha256);
      expect(fixtures[name].bytes).toBeLessThan(5 * 1024 * 1024);
    }

    const flaskOrigin = process.env.PYTHON_API_URL as string;
    const userToken = 'eyJhbGciOiJub25lIn0.eyJ1aWQiOiJhbGxvd2VkIn0.signature';
    const allowedUid = 'allowed-staging-uid';
    mockVerifyIdToken.mockReset();
    mockVerifyIdToken.mockResolvedValue({ uid: allowedUid });
    const savedStaging = {
      staging: process.env.CHORDMINI_HOSTED_STAGING_AUTH,
      allow: process.env.CHORDMINI_STAGING_ALLOWED_UIDS,
      admin: process.env.FIREBASE_SERVICE_ACCOUNT_KEY,
      admission: process.env.CHORDMINI_GATEWAY_ADMISSION,
      instances: process.env.CHORDMINI_GATEWAY_INSTANCES,
      desktop: process.env.CHORDMINI_DESKTOP_MODE,
    };
    delete process.env.CHORDMINI_DESKTOP_MODE;
    process.env.CHORDMINI_HOSTED_STAGING_AUTH = 'required';
    process.env.CHORDMINI_STAGING_ALLOWED_UIDS = allowedUid;
    process.env.FIREBASE_SERVICE_ACCOUNT_KEY = JSON.stringify({
      project_id: 'staging-test',
      private_key: 'test-only-not-a-credential',
      client_email: 'staging-test@example.invalid',
    });
    process.env.CHORDMINI_GATEWAY_ADMISSION = 'process';
    process.env.CHORDMINI_GATEWAY_INSTANCES = '1';
    const durationSeconds = evidence.fixtures.long_wav.duration_seconds_generated;
    const timings: Record<string, { beatsMs: number; chordsMs: number; combinedRtf: number }> = {};
    global.fetch = async (input, init) => {
      const url = String(input);
      if (url.startsWith(flaskOrigin)) {
        const headers = new Headers(init?.headers);
        expect(headers.get('x-chordmini-inference-token')).toBe(secret);
        expect(headers.get('authorization')).toBeNull();
      }
      return realFetch(input, init);
    };

    try {
      const denied = await realFetch(`${flaskOrigin}/api/detect-beats`, {
        method: 'POST',
        body: (() => {
          const form = new FormData();
          form.append('detector', 'madmom');
          form.append('file', new File([fs.readFileSync(fixtures.long_mp3.path)], 'synthetic-96s.mp3', { type: 'audio/mpeg' }));
          return form;
        })(),
      });
      expect(denied.status).toBe(401);

      for (const name of ['long_wav', 'long_mp3'] as const) {
        const bytes = new Uint8Array(fs.readFileSync(fixtures[name].path));
        const type = name === 'long_wav' ? 'audio/wav' : 'audio/mpeg';
        const filename = name === 'long_wav' ? 'synthetic-96s.wav' : 'synthetic-96s.mp3';
        resetGatewayAdmissionForTests();
        const hostedFile = new File([bytes], filename, { type });
        const guard = await inspectHostedAudio(hostedFile, process.env);
        expect(guard).toEqual({ ok: true });
        if (name === 'long_mp3') {
          const duration = readMp3Duration(bytes, 300);
          expect(duration.ok).toBe(true);
          if (duration.ok) {
            expect(duration.seconds).toBeGreaterThan(60);
            expect(duration.seconds).toBeLessThanOrEqual(300);
          }
        }

        const startedBeats = Date.now();
        const beatsResponse = await postBeats({
          ...requestWith({ detector: 'madmom' }, new File([bytes], filename, { type })),
          headers: new Headers({ authorization: `Bearer ${userToken}` }),
        } as never);
        const beatsMs = Date.now() - startedBeats;
        const beats = await beatsResponse.json() as {
          success: boolean;
          beats: number[];
          downbeats: number[];
          bpm: number;
          model_used: string;
        };
        expect(beatsResponse.status).toBe(200);
        expect(beats.success).toBe(true);
        expect(beats.model_used).toBe('madmom');
        expect(beats.beats.length).toBeGreaterThan(24);
        expect(beats.bpm).toBeCloseTo(evidence.results[name].beats.bpm, 2);
        expect(closeEnough(beats.beats, evidence.results[name].beats.beats, 1e-3)).toBe(true);
        expect(closeEnough(beats.downbeats, evidence.results[name].beats.downbeats, 1e-3)).toBe(true);
        expect(JSON.stringify(beats)).not.toContain(secret);
        expect(gatewayAdmissionSnapshot(allowedUid)).toEqual({ globalActive: 0, uidActive: 0 });

        const startedChords = Date.now();
        const chordsResponse = await postChords({
          ...requestWith({
            detector: 'chord-cnn-lstm',
            model: 'chord-cnn-lstm',
            chord_dict: 'submission',
          }, new File([bytes], filename, { type })),
          headers: new Headers({ authorization: `Bearer ${userToken}` }),
        } as never);
        const chordsMs = Date.now() - startedChords;
        const chords = await chordsResponse.json() as {
          success: boolean;
          model_used: string;
          chord_dict: string;
          chords: Array<{ chord: string; start: number; end: number; confidence?: number }>;
        };
        expect(chordsResponse.status).toBe(200);
        expect(chords.success).toBe(true);
        expect(chords.model_used).toBe('chord-cnn-lstm');
        expect(chords.chord_dict).toBe('submission');
        expect(chords.chords.map((row) => row.chord)).toEqual(
          evidence.results[name].chords.chords.map((row) => row.chord),
        );
        chords.chords.forEach((row, index) => {
          const expected = evidence.results[name].chords.chords[index];
          expect(Math.abs(row.start - expected.start)).toBeLessThanOrEqual(1e-3);
          expect(Math.abs(row.end - expected.end)).toBeLessThanOrEqual(1e-3);
          expect(row.confidence).toBe(1);
        });
        const fabricatedEnds = [2, 4, 6, 8];
        expect(chords.chords.slice(0, 4).map((row) => row.end)).not.toEqual(fabricatedEnds);
        expect(JSON.stringify(chords)).not.toContain(secret);
        expect(gatewayAdmissionSnapshot(allowedUid)).toEqual({ globalActive: 0, uidActive: 0 });
        timings[name] = {
          beatsMs,
          chordsMs,
          combinedRtf: (beatsMs + chordsMs) / 1000 / durationSeconds,
        };
      }
      expect(mockVerifyIdToken).toHaveBeenCalledWith(userToken, true);
      expect(logs).not.toContain(secret);
      const statusPath = `/proc/${child?.pid}/status`;
      const status = child?.pid && fs.existsSync(statusPath) ? fs.readFileSync(statusPath, 'utf8') : '';
      const peak = status.match(/VmHWM:\s+(\d+)/);
      fs.writeFileSync('/tmp/chordmini-04h-gateway-timings.json', JSON.stringify({
        timings,
        audioDurationSeconds: durationSeconds,
        flaskVmHwmKb: peak ? Number(peak[1]) : null,
        firebaseIdentity: 'MOCKED_NOT_PRODUCTION_AUTH',
        realMusicAccuracy: 'BLOCKED',
      }));
    } finally {
      global.fetch = realFetch;
      resetGatewayAdmissionForTests();
      const restoreKey = (key: string, value: string | undefined) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      };
      restoreKey('CHORDMINI_HOSTED_STAGING_AUTH', savedStaging.staging);
      restoreKey('CHORDMINI_STAGING_ALLOWED_UIDS', savedStaging.allow);
      restoreKey('FIREBASE_SERVICE_ACCOUNT_KEY', savedStaging.admin);
      restoreKey('CHORDMINI_GATEWAY_ADMISSION', savedStaging.admission);
      restoreKey('CHORDMINI_GATEWAY_INSTANCES', savedStaging.instances);
      restoreKey('CHORDMINI_DESKTOP_MODE', savedStaging.desktop);
    }
  }, 480000);

  const guitarEvidencePath = path.join(ROOT, 'python_backend/research/backend_04i_guitarset_evidence.json');
  const guitarEvidence = fs.existsSync(guitarEvidencePath)
    ? JSON.parse(fs.readFileSync(guitarEvidencePath, 'utf8')) as {
      recordings: Array<{
        id: string;
        audio: { path: string; sha256: string; bytes: number };
        annotation: { scored_duration_seconds: number };
        beats: { beats: number[]; downbeats: number[]; bpm: number };
        chords: { chords: Array<{ chord: string; start: number; end: number; confidence?: number }> };
      }>;
    }
    : null;
  const guitarReady = Boolean(
    guitarEvidence
    && guitarEvidence.recordings.length >= 3
    && guitarEvidence.recordings.every((item) => fs.existsSync(item.audio.path)),
  );

  (guitarReady ? it : it.skip)('analyzes official GuitarSet mono recordings through a MOCKED-identity gateway', async () => {
    // verifyIdToken is mocked. This is not production Firebase authentication.
    const evidence = guitarEvidence;
    if (!evidence) {
      throw new Error('GuitarSet evidence is absent');
    }
    const flaskOrigin = process.env.PYTHON_API_URL as string;
    const userToken = 'eyJhbGciOiJub25lIn0.eyJ1aWQiOiJhbGxvd2VkIn0.signature';
    const allowedUid = 'allowed-staging-uid';
    mockVerifyIdToken.mockReset();
    mockVerifyIdToken.mockResolvedValue({ uid: allowedUid });
    const savedStaging = {
      staging: process.env.CHORDMINI_HOSTED_STAGING_AUTH,
      allow: process.env.CHORDMINI_STAGING_ALLOWED_UIDS,
      admin: process.env.FIREBASE_SERVICE_ACCOUNT_KEY,
      admission: process.env.CHORDMINI_GATEWAY_ADMISSION,
      instances: process.env.CHORDMINI_GATEWAY_INSTANCES,
      desktop: process.env.CHORDMINI_DESKTOP_MODE,
    };
    delete process.env.CHORDMINI_DESKTOP_MODE;
    process.env.CHORDMINI_HOSTED_STAGING_AUTH = 'required';
    process.env.CHORDMINI_STAGING_ALLOWED_UIDS = allowedUid;
    process.env.FIREBASE_SERVICE_ACCOUNT_KEY = JSON.stringify({
      project_id: 'staging-test',
      private_key: 'test-only-not-a-credential',
      client_email: 'staging-test@example.invalid',
    });
    process.env.CHORDMINI_GATEWAY_ADMISSION = 'process';
    process.env.CHORDMINI_GATEWAY_INSTANCES = '1';
    const timings: Record<string, { beatsMs: number; chordsMs: number; combinedRtf: number }> = {};
    global.fetch = async (input, init) => {
      const url = String(input);
      if (url.startsWith(flaskOrigin)) {
        const headers = new Headers(init?.headers);
        expect(headers.get('x-chordmini-inference-token')).toBe(secret);
        expect(headers.get('authorization')).toBeNull();
      }
      return realFetch(input, init);
    };
    try {
      const first = evidence.recordings[0];
      const denied = await realFetch(`${flaskOrigin}/api/detect-beats`, {
        method: 'POST',
        body: (() => {
          const form = new FormData();
          form.append('detector', 'madmom');
          form.append('file', new File([fs.readFileSync(first.audio.path)], `${first.id}_mic.wav`, { type: 'audio/wav' }));
          return form;
        })(),
      });
      expect(denied.status).toBe(401);

      for (const item of evidence.recordings) {
        const bytes = new Uint8Array(fs.readFileSync(item.audio.path));
        expect(bytes.byteLength).toBe(item.audio.bytes);
        expect(bytes.byteLength).toBeLessThan(5 * 1024 * 1024);
        const filename = `${item.id}_mic.wav`;
        resetGatewayAdmissionForTests();
        const guard = await inspectHostedAudio(new File([bytes], filename, { type: 'audio/wav' }), process.env);
        expect(guard).toEqual({ ok: true });

        const startedBeats = Date.now();
        const beatsResponse = await postBeats({
          ...requestWith({ detector: 'madmom' }, new File([bytes], filename, { type: 'audio/wav' })),
          headers: new Headers({ authorization: `Bearer ${userToken}` }),
        } as never);
        const beatsMs = Date.now() - startedBeats;
        const beats = await beatsResponse.json() as {
          success: boolean;
          beats: number[];
          downbeats: number[];
          bpm: number;
          model_used: string;
        };
        expect(beatsResponse.status).toBe(200);
        expect(beats.success).toBe(true);
        expect(beats.model_used).toBe('madmom');
        expect(beats.bpm).toBeCloseTo(item.beats.bpm, 2);
        expect(closeEnough(beats.beats, item.beats.beats, 1e-3)).toBe(true);
        expect(closeEnough(beats.downbeats, item.beats.downbeats, 1e-3)).toBe(true);
        expect(JSON.stringify(beats)).not.toContain(secret);
        expect(gatewayAdmissionSnapshot(allowedUid)).toEqual({ globalActive: 0, uidActive: 0 });

        const startedChords = Date.now();
        const chordsResponse = await postChords({
          ...requestWith({
            detector: 'chord-cnn-lstm',
            model: 'chord-cnn-lstm',
            chord_dict: 'submission',
          }, new File([bytes], filename, { type: 'audio/wav' })),
          headers: new Headers({ authorization: `Bearer ${userToken}` }),
        } as never);
        const chordsMs = Date.now() - startedChords;
        const chords = await chordsResponse.json() as {
          success: boolean;
          model_used: string;
          chord_dict: string;
          chords: Array<{ chord: string; start: number; end: number; confidence?: number }>;
        };
        expect(chordsResponse.status).toBe(200);
        expect(chords.success).toBe(true);
        expect(chords.model_used).toBe('chord-cnn-lstm');
        expect(chords.chord_dict).toBe('submission');
        expect(chords.chords.map((row) => row.chord)).toEqual(item.chords.chords.map((row) => row.chord));
        chords.chords.forEach((row, index) => {
          expect(Math.abs(row.start - item.chords.chords[index].start)).toBeLessThanOrEqual(1e-3);
          expect(Math.abs(row.end - item.chords.chords[index].end)).toBeLessThanOrEqual(1e-3);
          expect(row.confidence).toBe(1);
        });
        expect(JSON.stringify(chords)).not.toContain(secret);
        expect(gatewayAdmissionSnapshot(allowedUid)).toEqual({ globalActive: 0, uidActive: 0 });
        timings[item.id] = {
          beatsMs,
          chordsMs,
          combinedRtf: (beatsMs + chordsMs) / 1000 / item.annotation.scored_duration_seconds,
        };
      }
      expect(mockVerifyIdToken).toHaveBeenCalledWith(userToken, true);
      expect(logs).not.toContain(secret);
      const statusPath = `/proc/${child?.pid}/status`;
      const status = child?.pid && fs.existsSync(statusPath) ? fs.readFileSync(statusPath, 'utf8') : '';
      const peak = status.match(/VmHWM:\s+(\d+)/);
      fs.writeFileSync('/tmp/chordmini-04i-gateway-timings.json', JSON.stringify({
        timings,
        flaskVmHwmKb: peak ? Number(peak[1]) : null,
        firebaseIdentity: 'MOCKED_NOT_PRODUCTION_AUTH',
        realMusicAccuracy: 'MEASURED',
      }));
    } finally {
      global.fetch = realFetch;
      resetGatewayAdmissionForTests();
      const restoreKey = (key: string, value: string | undefined) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      };
      restoreKey('CHORDMINI_HOSTED_STAGING_AUTH', savedStaging.staging);
      restoreKey('CHORDMINI_STAGING_ALLOWED_UIDS', savedStaging.allow);
      restoreKey('FIREBASE_SERVICE_ACCOUNT_KEY', savedStaging.admin);
      restoreKey('CHORDMINI_GATEWAY_ADMISSION', savedStaging.admission);
      restoreKey('CHORDMINI_GATEWAY_INSTANCES', savedStaging.instances);
      restoreKey('CHORDMINI_DESKTOP_MODE', savedStaging.desktop);
    }
  }, 480000);
});
