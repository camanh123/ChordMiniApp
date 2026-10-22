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
import { fetch as undiciFetch } from 'undici';
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
const realFetch = undiciFetch as typeof fetch;

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
});
