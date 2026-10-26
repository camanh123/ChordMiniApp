/**
 * Local Flask configuration and readiness classification for the desktop shell.
 *
 * Paths come from the machine's environment or from its user-data config.
 * Nothing in this module names a development drive, a virtualenv, or a model
 * checkpoint. The renderer never receives a spawn API or the backend nonce.
 *
 * SERVER_READY is a loopback identity check. The session nonce is a 32-byte
 * secret given only to the Flask child. Each check sends a fresh 16-byte
 * challenge. The responder returns HMAC-SHA256(nonce, challenge). A previous
 * response cannot be replayed, and /health without that proof is not identity.
 * This is proof the responder currently knows the nonce. It is not a channel
 * binding and it does not prove which PID owns the socket: a same-user process
 * that can read the child environment can answer a new challenge. A public
 * "healthy" body cannot.
 *
 * MODEL_PREFLIGHT_READY means weight files and imports were reported. It is
 * not INFERENCE_VERIFIED. This module never marks inference as verified.
 *
 * Legacy public responses are accepted only when CHORDMINI_ALLOW_LEGACY_BACKEND
 * is exactly "1". That mode is explicit local testing, not authentication.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import fs from 'fs';
import path from 'path';

export const ANALYSIS_BACKEND_NOT_READY = 'ANALYSIS_BACKEND_NOT_READY';
export const LOCAL_BACKEND_FILE_NAME = 'local-backend.json';
export const BACKEND_STATUS_FILE_NAME = 'backend-status.json';
export const BACKEND_RETRY_FILE_NAME = 'backend-retry.json';
export const DEFAULT_FLASK_PORT = 5001;
export const CHORDMINI_FLASK_SERVICE = 'chordmini-flask';
export const LEGACY_ROOT_MESSAGE = 'Audio analysis API is running';

export type BackendIdentity = 'none' | 'owned' | 'legacy';

export interface BackendModels {
  chordCnnLstm: boolean | null;
  beatTransformer: boolean | null;
  madmom: boolean | null;
}

export interface BackendStatus {
  phase: 'starting' | 'server-ready' | 'failed';
  code: string;
  message: string;
  serverReady: boolean;
  modelReady: boolean;
  modelPreflightReady: boolean;
  inferenceVerified: false;
  analysisReady: false;
  owned: boolean;
  identity: BackendIdentity;
  models: BackendModels;
  updatedAt: string;
}

export interface ResolvedBackend {
  ok: true;
  pythonPath: string;
  backendDir: string;
  flaskEntry: string;
}

export interface RejectedBackend {
  ok: false;
  code: 'BACKEND_NOT_CONFIGURED' | 'PYTHON_MISSING' | 'BACKEND_MISSING' | 'CONFIG_INVALID';
  message: string;
}

const EMPTY_MODELS: BackendModels = {
  chordCnnLstm: null,
  beatTransformer: null,
  madmom: null,
};

const IDENTITY_CHALLENGE = /^[0-9a-f]{32}$/;

export function createIdentityChallenge(): string {
  return randomBytes(16).toString('hex');
}

export function identityRequestUrl(url: string, challenge: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('challenge', challenge);
  return parsed.toString();
}

/** HMAC-SHA256(nonce, challenge). The nonce is the key and is not recoverable from the result. */
export function backendInstanceProof(nonce: string, challenge: string): string {
  return createHmac('sha256', nonce).update(challenge, 'utf8').digest('hex');
}

function sameProof(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string' || actual.length !== expected.length || expected.length === 0) {
    return false;
  }
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

export function publicBackendMessage(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\b(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

export function allowLegacyBackend(env: NodeJS.ProcessEnv): boolean {
  return env.CHORDMINI_ALLOW_LEGACY_BACKEND === '1';
}

export function isModelPreflightReady(models: BackendModels): boolean {
  return models.chordCnnLstm === true && (models.madmom === true || models.beatTransformer === true);
}

export function modelStatusMessage(models: BackendModels): string {
  if (models.chordCnnLstm === null && models.madmom === null && models.beatTransformer === null) {
    return 'Model readiness has not been confirmed. A healthy response is not enough to analyze audio.';
  }
  const missing: string[] = [];
  if (models.chordCnnLstm !== true) {
    missing.push('Chord-CNN-LSTM');
  }
  if (models.madmom !== true) {
    missing.push('Madmom');
  }
  if (models.beatTransformer !== true) {
    missing.push('Beat-Transformer');
  }
  if (missing.length === 0) {
    return 'Chord-CNN-LSTM and a beat detector passed file and import preflight. Inference has not been run.';
  }
  return `The local analysis service is missing ${missing.join(', ')}. No chords or beats were generated.`;
}

function absoluteFile(candidate: string | undefined, exists: (target: string) => boolean): string | null {
  if (!candidate || !path.isAbsolute(candidate)) {
    return null;
  }
  return exists(candidate) ? candidate : null;
}

function readConfigObject(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stringField(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

export function resolveLocalBackendConfig(input: {
  env: NodeJS.ProcessEnv;
  userDataDir?: string;
  exists?: (target: string) => boolean;
}): ResolvedBackend | RejectedBackend {
  const exists = input.exists ?? ((target: string) => fs.existsSync(target));
  const configuredFile = input.env.CHORDMINI_LOCAL_BACKEND_FILE?.trim();
  let pythonPath = input.env.CHORDMINI_PYTHON?.trim() ?? '';
  let backendDir = input.env.CHORDMINI_BACKEND_DIR?.trim() ?? '';
  let explicit = Boolean(pythonPath || backendDir);

  if (!pythonPath && !backendDir) {
    const file = configuredFile
      || (input.userDataDir && path.isAbsolute(input.userDataDir)
        ? path.join(input.userDataDir, LOCAL_BACKEND_FILE_NAME)
        : '');
    if (!file) {
      return {
        ok: false,
        code: 'BACKEND_NOT_CONFIGURED',
        message: 'No local analysis backend is configured. Set CHORDMINI_PYTHON and CHORDMINI_BACKEND_DIR, or add pythonPath and backendDir to the desktop local-backend file. ChordMini does not bundle a Python runtime.',
      };
    }
    if (!path.isAbsolute(file)) {
      return {
        ok: false,
        code: 'CONFIG_INVALID',
        message: 'The local backend config path must be absolute. ChordMini did not start Python.',
      };
    }
    if (!exists(file)) {
      return {
        ok: false,
        code: 'BACKEND_NOT_CONFIGURED',
        message: 'No local analysis backend is configured. Set CHORDMINI_PYTHON and CHORDMINI_BACKEND_DIR, or add pythonPath and backendDir to the desktop local-backend file. ChordMini does not bundle a Python runtime.',
      };
    }
    const record = readConfigObject(file);
    if (!record) {
      return {
        ok: false,
        code: 'CONFIG_INVALID',
        message: 'The local backend config file could not be read. Expected pythonPath and backendDir. ChordMini did not start Python.',
      };
    }
    pythonPath = stringField(record, ['pythonPath', 'python']);
    backendDir = stringField(record, ['backendDir', 'backend']);
    explicit = true;
  }

  if (!explicit || !pythonPath || !backendDir) {
    return {
      ok: false,
      code: 'CONFIG_INVALID',
      message: 'The local backend config needs both pythonPath and backendDir. ChordMini did not start Python.',
    };
  }
  if (!path.isAbsolute(pythonPath) || !path.isAbsolute(backendDir)) {
    return {
      ok: false,
      code: 'CONFIG_INVALID',
      message: 'The Python executable and backend directory must be absolute paths. ChordMini did not start Python.',
    };
  }
  if (!absoluteFile(pythonPath, exists)) {
    return {
      ok: false,
      code: 'PYTHON_MISSING',
      message: 'The configured Python executable is missing. ChordMini did not start an analysis service.',
    };
  }
  const flaskEntry = path.join(backendDir, 'app.py');
  if (!exists(backendDir) || !absoluteFile(flaskEntry, exists)) {
    return {
      ok: false,
      code: 'BACKEND_MISSING',
      message: 'The configured backend directory is missing or does not contain the Flask application. ChordMini did not start Python.',
    };
  }

  return { ok: true, pythonPath, backendDir, flaskEntry };
}

export function preferredFlaskPort(env: NodeJS.ProcessEnv): number {
  const raw = (env.CHORDMINI_FLASK_PORT ?? '').trim();
  if (!raw) {
    return DEFAULT_FLASK_PORT;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return DEFAULT_FLASK_PORT;
  }
  return port;
}

export function loopbackOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
}

const CHILD_ENV_KEYS = [
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'SYSTEMDRIVE',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'HOME',
  'APPDATA',
  'LOCALAPPDATA',
  'HOMEDRIVE',
  'HOMEPATH',
  'COMSPEC',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
] as const;

/**
 * Environment for the owned Python process only.
 * PORT is omitted so an inherited PORT cannot flip Flask into production auth.
 * CHORDMINI_INFERENCE_AUTH=local is the Flask compatibility mode: the two
 * inference routes still reject server paths and cap uploads, and they do not
 * require a token. It is not an authentication scheme. The Beat-Transformer
 * code directory is added to this process's PYTHONPATH and is not written back
 * to the Electron process.
 */
export function pythonChildEnv(input: {
  parentEnv: NodeJS.ProcessEnv;
  backendDir: string;
  port: number;
  nonce: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    // Local Flask stays in development even when Electron itself is packaged.
    NODE_ENV: 'development',
  };
  for (const key of CHILD_ENV_KEYS) {
    const value = input.parentEnv[key];
    if (value) {
      env[key] = value;
    }
  }
  const beatCode = path.join(input.backendDir, 'models', 'Beat-Transformer', 'code');
  env.PYTHONPATH = beatCode;
  env.PYTHONUNBUFFERED = '1';
  env.PYTHONIOENCODING = 'utf-8';
  env.FLASK_ENV = 'development';
  env.CHORDMINI_INFERENCE_AUTH = 'local';
  env.CHORDMINI_FLASK_PORT = String(input.port);
  env.CHORDMINI_BACKEND_NONCE = input.nonce;
  delete env.PORT;
  delete env.PYTHON_API_URL;
  delete env.CHORDMINI_INFERENCE_SECRET;
  delete env.NEXT_PUBLIC_CHORDMINI_INFERENCE_SECRET;
  delete env.CHORDMINI_HOSTED_GATEWAY_URL;
  delete env.CHORDMINI_HOSTED_STAGING_AUTH;
  return env;
}

export function nextChildBackendEnv(input: {
  origin: string | null;
  statusFile: string;
  retryFile: string;
  nonce: string | null;
  statusKey: string;
  retryToken: string;
  allowLegacy: boolean;
}): NodeJS.ProcessEnv {
  // NODE_ENV is intentionally absent. This object is spread over the Next
  // process, and a NODE_ENV key here would replace the server's own value.
  // Next's ProcessEnv type requires NODE_ENV, so the overlay is cast.
  const env = {
    CHORDMINI_BACKEND_SUPERVISED: '1',
    CHORDMINI_BACKEND_STATUS_FILE: input.statusFile,
    CHORDMINI_BACKEND_STATUS_KEY: input.statusKey,
    CHORDMINI_BACKEND_RETRY_FILE: input.retryFile,
    CHORDMINI_BACKEND_RETRY_TOKEN: input.retryToken,
  } as unknown as NodeJS.ProcessEnv;
  if (input.allowLegacy) {
    env.CHORDMINI_ALLOW_LEGACY_BACKEND = '1';
  }
  if (input.origin) {
    env.PYTHON_API_URL = input.origin;
    // Overrides an inherited "required" mode. Desktop mode never attaches the
    // inference secret, and this URL is the loopback process under test.
    env.CHORDMINI_INFERENCE_AUTH = 'local';
  }
  if (input.nonce) {
    env.CHORDMINI_BACKEND_NONCE = input.nonce;
  }
  return env;
}

export function classifyOwnedHealth(body: unknown, nonce: string, challenge: string): 'owned' | 'mismatch' {
  if (!body || typeof body !== 'object') {
    return 'mismatch';
  }
  const record = body as Record<string, unknown>;
  if (record.status !== 'healthy' || record.service !== CHORDMINI_FLASK_SERVICE) {
    return 'mismatch';
  }
  if (!nonce || !IDENTITY_CHALLENGE.test(challenge)) {
    return 'mismatch';
  }
  if (!sameProof(record.instance, backendInstanceProof(nonce, challenge))) {
    return 'mismatch';
  }
  return 'owned';
}

export function isLegacyChordMiniRoot(body: unknown): boolean {
  if (!body || typeof body !== 'object') {
    return false;
  }
  const record = body as Record<string, unknown>;
  return record.status === 'healthy' && record.message === LEGACY_ROOT_MESSAGE && record.service === undefined;
}

function booleanField(record: Record<string, unknown>, key: string): boolean | null {
  const value = record[key];
  return typeof value === 'boolean' ? value : null;
}

export function modelsFromReadiness(
  body: unknown,
  expected?: { nonce: string; challenge: string },
): BackendModels | null {
  if (!body || typeof body !== 'object') {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (record.service !== CHORDMINI_FLASK_SERVICE || record.proves !== 'weight-files-and-imports') {
    return null;
  }
  if (expected) {
    if (!expected.nonce || !IDENTITY_CHALLENGE.test(expected.challenge)) {
      return null;
    }
    if (!sameProof(record.instance, backendInstanceProof(expected.nonce, expected.challenge))) {
      return null;
    }
  }
  const chordCnnLstm = booleanField(record, 'chordCnnLstm');
  const beatTransformer = booleanField(record, 'beatTransformer');
  const madmom = booleanField(record, 'madmom');
  if (chordCnnLstm === null || beatTransformer === null || madmom === null) {
    return null;
  }
  return { chordCnnLstm, beatTransformer, madmom };
}

export function modelsFromLegacyInfo(beatInfo: unknown, chordInfo: unknown): BackendModels | null {
  if (!beatInfo || typeof beatInfo !== 'object' || !chordInfo || typeof chordInfo !== 'object') {
    return null;
  }
  const beat = beatInfo as Record<string, unknown>;
  const chord = chordInfo as Record<string, unknown>;
  if (beat.success !== true || !Array.isArray(beat.available_beat_models)) {
    return null;
  }
  const beatTransformer = booleanField(beat, 'beat_transformer_available');
  const madmom = booleanField(beat, 'madmom_available');
  const chordModels = chord.chord_model_info;
  if (chord.success !== true || !chordModels || typeof chordModels !== 'object') {
    return null;
  }
  const cnn = (chordModels as Record<string, unknown>)['chord-cnn-lstm'];
  if (!cnn || typeof cnn !== 'object') {
    return null;
  }
  const chordCnnLstm = booleanField(cnn as Record<string, unknown>, 'available');
  if (beatTransformer === null || madmom === null || chordCnnLstm === null) {
    return null;
  }
  return { chordCnnLstm, beatTransformer, madmom };
}

export function createBackendStatus(input: {
  phase: BackendStatus['phase'];
  code: string;
  message: string;
  serverReady: boolean;
  owned: boolean;
  identity: BackendIdentity;
  models?: BackendModels;
  now?: Date;
}): BackendStatus {
  const models = input.models ?? EMPTY_MODELS;
  const modelPreflightReady = input.serverReady && isModelPreflightReady(models);
  return {
    phase: input.phase,
    code: input.code,
    message: publicBackendMessage(input.message),
    serverReady: input.serverReady,
    modelReady: modelPreflightReady,
    modelPreflightReady,
    inferenceVerified: false,
    analysisReady: false,
    owned: input.owned,
    identity: input.identity,
    models,
    updatedAt: (input.now ?? new Date()).toISOString(),
  };
}

function statusMac(body: string, key: string): string {
  return createHmac('sha256', key).update(body).digest('hex');
}

function macMatches(body: string, mac: string, key: string): boolean {
  if (!key || !mac) {
    return false;
  }
  const expected = Buffer.from(statusMac(body, key));
  const actual = Buffer.from(mac);
  if (expected.length !== actual.length) {
    return false;
  }
  return timingSafeEqual(expected, actual);
}

export function writeBackendStatus(file: string, status: BackendStatus, key?: string): void {
  if (!path.isAbsolute(file)) {
    throw new Error('Refusing to write backend status to a relative path.');
  }
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const directoryReal = fs.realpathSync(directory);
  const relative = path.relative(directoryReal, directory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Refusing to write backend status outside its directory.');
  }
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) {
    throw new Error('Refusing to write backend status through a symlink.');
  }
  const body = JSON.stringify(status);
  const payload = key ? JSON.stringify({ body, mac: statusMac(body, key) }) : body;
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, payload, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function readBackendStatus(env: NodeJS.ProcessEnv = process.env): BackendStatus | null {
  const file = env.CHORDMINI_BACKEND_STATUS_FILE?.trim();
  if (!file || !path.isAbsolute(file)) {
    return null;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const key = env.CHORDMINI_BACKEND_STATUS_KEY?.trim() ?? '';
    let parsed: Partial<BackendStatus>;
    if (typeof raw.body === 'string' && typeof raw.mac === 'string') {
      if (!key || !macMatches(raw.body, raw.mac, key)) {
        return null;
      }
      parsed = JSON.parse(raw.body) as Partial<BackendStatus>;
    } else if (key) {
      return null;
    } else {
      parsed = raw as Partial<BackendStatus>;
    }
    if (!parsed || typeof parsed.message !== 'string' || typeof parsed.code !== 'string') {
      return null;
    }
    const models = parsed.models;
    if (!models || typeof models !== 'object') {
      return null;
    }
    return {
      phase: parsed.phase === 'server-ready' || parsed.phase === 'failed' ? parsed.phase : 'starting',
      code: parsed.code,
      message: publicBackendMessage(parsed.message),
      serverReady: parsed.serverReady === true,
      modelReady: parsed.modelPreflightReady === true,
      modelPreflightReady: parsed.modelPreflightReady === true,
      inferenceVerified: false,
      analysisReady: false,
      owned: parsed.owned === true,
      identity: parsed.identity === 'owned' || parsed.identity === 'legacy' ? parsed.identity : 'none',
      models: {
        chordCnnLstm: typeof models.chordCnnLstm === 'boolean' ? models.chordCnnLstm : null,
        beatTransformer: typeof models.beatTransformer === 'boolean' ? models.beatTransformer : null,
        madmom: typeof models.madmom === 'boolean' ? models.madmom : null,
      },
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
    };
  } catch {
    return null;
  }
}

function tokenMatches(expected: string, actual: string): boolean {
  if (!expected || !actual || expected.length < 32 || expected.length !== actual.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

export function requestBackendRetry(file: string, token: string): boolean {
  if (!file || !path.isAbsolute(file) || !token || token.length < 32) {
    return false;
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ requestedAt: new Date().toISOString(), token }), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

export function consumeRetryRequest(file: string, expectedToken: string): boolean {
  if (!file || !path.isAbsolute(file) || !fs.existsSync(file)) {
    return false;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { requestedAt?: unknown; token?: unknown };
    fs.unlinkSync(file);
    return typeof parsed.requestedAt === 'string'
      && parsed.requestedAt.length > 0
      && typeof parsed.token === 'string'
      && tokenMatches(expectedToken, parsed.token);
  } catch {
    try {
      fs.unlinkSync(file);
    } catch {
      // The next poll can try again.
    }
    return false;
  }
}

export function selectedDetectorReady(
  models: BackendModels,
  kind: 'beat' | 'chord',
  detector: string,
): 'ready' | 'missing' | 'unknown' | 'untracked' {
  const name = detector.trim().toLowerCase();
  if (kind === 'beat') {
    if (name === 'madmom') {
      return models.madmom === null ? 'unknown' : models.madmom ? 'ready' : 'missing';
    }
    if (name === 'beat-transformer') {
      return models.beatTransformer === null ? 'unknown' : models.beatTransformer ? 'ready' : 'missing';
    }
    return 'untracked';
  }
  if (name === 'chord-cnn-lstm') {
    return models.chordCnnLstm === null ? 'unknown' : models.chordCnnLstm ? 'ready' : 'missing';
  }
  return 'untracked';
}
