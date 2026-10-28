import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { AnalysisHistoryError } from './errors';
import {
  LYRIC_SIDECAR_MAX_BYTES,
  LyricSidecar,
  LyricSidecarDraft,
  buildLyricSidecar,
  lyricSidecarFileName,
  parseLyricSidecar,
  serializeLyricSidecar,
  validateLyricSidecarDraft,
} from './lyricSidecar';
import {
  ANALYSIS_HISTORY_MAX_RECORD_BYTES,
  ANALYSIS_HISTORY_MAX_RECORDS,
  ANALYSIS_HISTORY_MAX_TOTAL_BYTES,
  AnalysisHistoryRecord,
  analysisIdentity,
  assertRecordId,
  buildAnalysisRecord,
  createRecordId,
  parseStoredRecord,
  serializeRecord,
  validateAnalysisDraft,
} from './schema';

const UUID_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;
const TEMP_FILE = /^\..+\.tmp-\d+-[0-9a-f]+$/;
const PENDING_LYRIC_DELETE = /^\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.lyrics\.json\.pending-delete-\d+-[0-9a-f]+$/;
const LOCK_FILE = '.write.lock';
const INDEX_FILE = 'index.json';
const STALE_LOCK_MS = 30_000;
const LOCK_WAIT_MS = 5_000;
const LOCK_RENEW_MS = 10_000;
const DEFAULT_TEMP_MAX_AGE_MS = 60_000;

const tails = new Map<string, Promise<void>>();

export interface HistoryWriteFault {
  beforeRename?: () => void;
  /** Test seam. Runs after a lyric sidecar is parked and before the parent record is unlinked. */
  beforeParentUnlink?: () => void;
}

export interface HistoryStoreOptions {
  env?: NodeJS.ProcessEnv;
  maxRecords?: number;
  maxTotalBytes?: number;
  maxRecordBytes?: number;
  tempMaxAgeMs?: number;
  lockWaitMs?: number;
  fault?: HistoryWriteFault;
  /** Test seam. Lets a second caller contend on the file lock instead of the in-process queue. */
  contendForLock?: boolean;
  /** Test seam. Runs after this caller owns the lock and before it reads or writes records. */
  onLocked?: () => Promise<void> | void;
}

export interface IsolatedHistoryRecord {
  id: string | null;
  reason: 'corrupt-json' | 'schema-mismatch' | 'invalid-record' | 'symlink' | 'result-hash-mismatch' | 'quarantine-unsafe';
}

export interface HistoryList {
  records: AnalysisHistoryRecord[];
  isolated: IsolatedHistoryRecord[];
}

export interface SaveAnalysisResult {
  record: AnalysisHistoryRecord;
  created: boolean;
}

export interface SaveLyricSidecarResult {
  lyrics: LyricSidecar;
  created: boolean;
}

export interface DeleteAnalysisRecordRequest {
  recordId: string;
  confirmDelete: true;
}

interface StoreLimits {
  maxRecords: number;
  maxTotalBytes: number;
  maxRecordBytes: number;
  tempMaxAgeMs: number;
}

/**
 * Local analysis history lives in the directory named by
 * CHORDMINI_ANALYSIS_HISTORY_DIR. The renderer cannot pass a path.
 * Callers must set that variable from the Electron main process.
 * Record files are the source of truth. index.json is rebuilt from them.
 * Writes use a same-directory temporary file and rename. A crash before
 * rename leaves the previous record in place. Aged temporary files are
 * recoverable. The lock file names its process. A live owner is never
 * replaced only because the lock is older than 30 seconds. A lock with no
 * live owner and timestamps older than 30 seconds is reclaimed. Duplicate
 * identity does not replace a record.
 * Capacity failure returns an error and deletes nothing.
 */
function assertServerContext(): void {
  const host = globalThis as { window?: unknown };
  if (host.window !== undefined) {
    throw new AnalysisHistoryError(
      'STORAGE_UNAVAILABLE',
      'Analysis history storage runs only in the desktop server context.',
    );
  }
}

function mapFs(error: unknown): AnalysisHistoryError {
  if (error instanceof AnalysisHistoryError) return error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOSPC') {
    return new AnalysisHistoryError(
      'STORAGE_UNAVAILABLE',
      'Analysis history could not be written because the disk is full. Existing records were left unchanged.',
    );
  }
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return new AnalysisHistoryError(
      'STORAGE_UNAVAILABLE',
      'Analysis history could not be written because the directory is not writable. Existing records were left unchanged.',
    );
  }
  return new AnalysisHistoryError(
    'STORAGE_UNAVAILABLE',
    'Analysis history could not be written. Existing records were left unchanged.',
  );
}

function limitsFrom(options?: HistoryStoreOptions): StoreLimits {
  const maxRecords = options?.maxRecords ?? ANALYSIS_HISTORY_MAX_RECORDS;
  const maxTotalBytes = options?.maxTotalBytes ?? ANALYSIS_HISTORY_MAX_TOTAL_BYTES;
  const maxRecordBytes = options?.maxRecordBytes ?? ANALYSIS_HISTORY_MAX_RECORD_BYTES;
  const tempMaxAgeMs = options?.tempMaxAgeMs ?? DEFAULT_TEMP_MAX_AGE_MS;
  if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > ANALYSIS_HISTORY_MAX_RECORDS) {
    throw new AnalysisHistoryError('RECORD_INVALID', 'Record count limit is outside the supported range.');
  }
  if (!Number.isInteger(maxTotalBytes) || maxTotalBytes < 1 || maxTotalBytes > ANALYSIS_HISTORY_MAX_TOTAL_BYTES) {
    throw new AnalysisHistoryError('RECORD_INVALID', 'History size limit is outside the supported range.');
  }
  if (!Number.isInteger(maxRecordBytes) || maxRecordBytes < 1 || maxRecordBytes > ANALYSIS_HISTORY_MAX_RECORD_BYTES) {
    throw new AnalysisHistoryError('RECORD_INVALID', 'Record size limit is outside the supported range.');
  }
  if (!Number.isInteger(tempMaxAgeMs) || tempMaxAgeMs < 0 || tempMaxAgeMs > 86_400_000) {
    throw new AnalysisHistoryError('RECORD_INVALID', 'Temporary file age is outside the supported range.');
  }
  return { maxRecords, maxTotalBytes, maxRecordBytes, tempMaxAgeMs };
}

function resolveRoot(env: NodeJS.ProcessEnv): string {
  if (env.CHORDMINI_DESKTOP_MODE !== '1') {
    throw new AnalysisHistoryError('STORAGE_ROOT_UNSAFE', 'Analysis history storage runs only in desktop mode.');
  }
  const root = env.CHORDMINI_ANALYSIS_HISTORY_DIR?.trim() ?? '';
  if (
    root.length === 0
    || root.includes('\0')
    || !path.isAbsolute(root)
    || root.split(/[\\/]+/).includes('..')
  ) {
    throw new AnalysisHistoryError('STORAGE_ROOT_UNSAFE', 'Analysis history directory must be an approved absolute path.');
  }
  const resolved = path.resolve(root);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw mapFs(error);
    try {
      fs.mkdirSync(resolved, { recursive: true });
      stat = fs.lstatSync(resolved);
    } catch (mkdirError) {
      throw mapFs(mkdirError);
    }
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new AnalysisHistoryError('STORAGE_ROOT_UNSAFE', 'Analysis history directory must be a real directory.');
  }
  return fs.realpathSync(resolved);
}

function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  tails.set(key, run.then(() => undefined, () => undefined));
  return run;
}

interface LockOwner {
  pid: number;
  token: string;
  heartbeat: number;
}

/**
 * Signal 0 is Node's existence check. EPERM means the process is still there
 * but this caller cannot signal it, which is the Windows result when the
 * process exists outside our rights. Only a confirmed absence allows reclaim.
 */
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLockOwner(lockPath: string): LockOwner | null {
  try {
    if (fs.lstatSync(lockPath).isSymbolicLink()) return null;
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Partial<LockOwner>;
    if (!Number.isInteger(parsed.pid) || !parsed.pid || parsed.pid <= 0) return null;
    if (typeof parsed.token !== 'string' || parsed.token.length < 8) return null;
    if (typeof parsed.heartbeat !== 'number' || !Number.isFinite(parsed.heartbeat)) return null;
    return { pid: parsed.pid, token: parsed.token, heartbeat: parsed.heartbeat };
  } catch {
    return null;
  }
}

function recoveryDecision(lockPath: string): 'wait' | 'steal' {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'wait';
    throw mapFs(error);
  }
  const age = Date.now() - stat.mtimeMs;
  if (stat.isSymbolicLink()) {
    return age > STALE_LOCK_MS ? 'steal' : 'wait';
  }
  if (!stat.isFile()) return 'wait';
  const owner = readLockOwner(lockPath);
  if (owner && processAlive(owner.pid)) return 'wait';
  const heartbeatAge = owner ? Date.now() - owner.heartbeat : age;
  if (age > STALE_LOCK_MS && heartbeatAge > STALE_LOCK_MS) return 'steal';
  return 'wait';
}

function releaseOwnedLock(lockPath: string, token: string): void {
  try {
    const stat = fs.lstatSync(lockPath);
    if (stat.isSymbolicLink() || !stat.isFile()) return;
    const owner = readLockOwner(lockPath);
    if (owner?.token === token) fs.unlinkSync(lockPath);
  } catch {
    // A crash here leaves a lock. A dead owner can be reclaimed after 30 seconds.
  }
}

async function withLock<T>(
  canonical: string,
  options: HistoryStoreOptions | undefined,
  task: () => Promise<T>,
): Promise<T> {
  const lockPath = path.join(canonical, LOCK_FILE);
  const waitMs = options?.lockWaitMs ?? LOCK_WAIT_MS;
  const started = Date.now();
  const owner: LockOwner = {
    pid: process.pid,
    token: randomBytes(16).toString('hex'),
    heartbeat: Date.now(),
  };
  for (;;) {
    let fd: number | null = null;
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify(owner));
      fs.closeSync(fd);
      fd = null;
      break;
    } catch (error) {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* already closed */ }
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw mapFs(error);
      try {
        if (recoveryDecision(lockPath) === 'steal') {
          const stat = fs.lstatSync(lockPath);
          if (stat.isSymbolicLink() || stat.isFile()) fs.unlinkSync(lockPath);
        }
      } catch (recoveryError) {
        if (recoveryError instanceof AnalysisHistoryError) throw recoveryError;
      }
      if (Date.now() - started > waitMs) {
        throw new AnalysisHistoryError(
          'STORAGE_UNAVAILABLE',
          'Analysis history is busy. Existing records were left unchanged.',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
  let held = true;
  const renew = setInterval(() => {
    if (!held) return;
    try {
      const stat = fs.lstatSync(lockPath);
      if (stat.isSymbolicLink() || !stat.isFile()) return;
      const current = readLockOwner(lockPath);
      if (current?.token !== owner.token) return;
      fs.writeFileSync(lockPath, JSON.stringify({ ...owner, heartbeat: Date.now() }), { mode: 0o600 });
    } catch {
      // The live pid still prevents another writer from taking this lock.
    }
  }, LOCK_RENEW_MS);
  renew.unref?.();
  try {
    if (options?.onLocked) await options.onLocked();
    return await task();
  } finally {
    held = false;
    clearInterval(renew);
    releaseOwnedLock(lockPath, owner.token);
  }
}

function runExclusive<T>(
  canonical: string,
  options: HistoryStoreOptions | undefined,
  task: () => Promise<T>,
): Promise<T> {
  const exec = () => withLock(canonical, options, task);
  if (options?.contendForLock) return exec();
  return serialize(canonical, exec);
}

function recoverUnlocked(canonical: string, tempMaxAgeMs: number): void {
  let names: string[] = [];
  try {
    names = fs.readdirSync(canonical);
  } catch (error) {
    throw mapFs(error);
  }
  const now = Date.now();
  for (const name of names) {
    if (!TEMP_FILE.test(name)) continue;
    const full = path.join(canonical, name);
    try {
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      if (now - stat.mtimeMs < tempMaxAgeMs) continue;
      fs.unlinkSync(full);
    } catch {
      // Leave a file that cannot be identified safely.
    }
  }
}

function contained(canonical: string, name: string): string {
  if (name.includes('/') || name.includes('\\') || name.includes('..') || name.includes('\0')) {
    throw new AnalysisHistoryError('PATH_UNSAFE', 'Analysis history refused an unsafe file name.');
  }
  const target = path.resolve(canonical, name);
  if (path.dirname(target) !== canonical) {
    throw new AnalysisHistoryError('PATH_UNSAFE', 'Analysis history refused a path outside its directory.');
  }
  return target;
}

function atomicWrite(canonical: string, name: string, contents: string, replace: boolean, fault?: HistoryWriteFault): void {
  const target = contained(canonical, name);
  try {
    const existing = fs.lstatSync(target);
    if (existing.isSymbolicLink()) {
      throw new AnalysisHistoryError('PATH_UNSAFE', 'Refusing to write a history file through a symlink.');
    }
    if (!replace) {
      throw new AnalysisHistoryError('STORAGE_UNAVAILABLE', 'Refusing to replace an existing history record.');
    }
    if (!existing.isFile()) {
      throw new AnalysisHistoryError('PATH_UNSAFE', 'Refusing to write a history file onto a non-file.');
    }
  } catch (error) {
    if (error instanceof AnalysisHistoryError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw mapFs(error);
  }
  const temporary = contained(
    canonical,
    `.${name}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`,
  );
  let fd: number | null = null;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeSync(fd, contents);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fault?.beforeRename?.();
    fs.renameSync(temporary, target);
  } catch (error) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
    try {
      if (fs.lstatSync(temporary).isFile()) fs.unlinkSync(temporary);
    } catch { /* temp was not created or was already renamed */ }
    throw mapFs(error);
  }
}

function isolateFile(canonical: string, fileName: string): boolean {
  const source = contained(canonical, fileName);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(source);
  } catch {
    return false;
  }
  if (stat.isSymbolicLink()) {
    try {
      fs.unlinkSync(source);
      return true;
    } catch {
      return false;
    }
  }
  if (!stat.isFile()) return false;
  const quarantine = path.join(canonical, 'quarantine');
  try {
    if (fs.existsSync(quarantine) && fs.lstatSync(quarantine).isSymbolicLink()) return false;
    fs.mkdirSync(quarantine, { recursive: true });
    if (fs.lstatSync(quarantine).isSymbolicLink() || !fs.lstatSync(quarantine).isDirectory()) return false;
    const destName = `${fileName}.${Date.now()}-${randomBytes(4).toString('hex')}.isolated`;
    const dest = path.resolve(quarantine, destName);
    if (path.dirname(dest) !== path.resolve(quarantine)) return false;
    fs.renameSync(source, dest);
    return true;
  } catch {
    return false;
  }
}

function isolationReason(error: unknown): IsolatedHistoryRecord['reason'] {
  if (error instanceof AnalysisHistoryError && error.code === 'SCHEMA_UNSUPPORTED') return 'schema-mismatch';
  if (error instanceof AnalysisHistoryError && error.code === 'RECORD_CORRUPT') return 'result-hash-mismatch';
  return 'invalid-record';
}

function readEntries(canonical: string): HistoryList {
  let names: string[] = [];
  try {
    names = fs.readdirSync(canonical);
  } catch (error) {
    throw mapFs(error);
  }
  const records: AnalysisHistoryRecord[] = [];
  const isolated: IsolatedHistoryRecord[] = [];
  for (const name of names.filter((entry) => UUID_FILE.test(entry)).sort()) {
    const id = name.slice(0, -'.json'.length);
    const full = contained(canonical, name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      const moved = isolateFile(canonical, name);
      isolated.push({ id, reason: moved ? 'symlink' : 'quarantine-unsafe' });
      continue;
    }
    if (!stat.isFile()) {
      isolated.push({ id, reason: 'invalid-record' });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      const moved = isolateFile(canonical, name);
      isolated.push({ id, reason: moved ? 'corrupt-json' : 'quarantine-unsafe' });
      continue;
    }
    try {
      records.push(parseStoredRecord(parsed, id));
    } catch (error) {
      const reason = isolationReason(error);
      const moved = isolateFile(canonical, name);
      isolated.push({ id, reason: moved ? reason : 'quarantine-unsafe' });
    }
  }
  records.sort((left, right) => {
    const byTime = Date.parse(right.analyzedAt) - Date.parse(left.analyzedAt);
    if (byTime !== 0) return byTime;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  return { records, isolated };
}

function recordBytes(canonical: string, records: AnalysisHistoryRecord[]): number {
  return records.reduce((sum, record) => {
    try {
      return sum + fs.statSync(contained(canonical, `${record.id}.json`)).size;
    } catch {
      return sum;
    }
  }, 0);
}

function assertCapacity(count: number, bytes: number, limits: StoreLimits): void {
  if (count > limits.maxRecords || bytes > limits.maxTotalBytes) {
    throw new AnalysisHistoryError(
      'CAPACITY_EXCEEDED',
      'Analysis history is full. No records were deleted.',
    );
  }
}

function writeDerivedIndex(canonical: string, records: AnalysisHistoryRecord[]): void {
  const body = `${JSON.stringify({
    schemaVersion: 1,
    derived: true,
    records: records.map((record) => ({
      id: record.id,
      analyzedAt: record.analyzedAt,
      resultSha256: record.resultSha256,
    })),
  })}\n`;
  const target = path.join(canonical, INDEX_FILE);
  try {
    if (fs.lstatSync(target).isSymbolicLink()) fs.unlinkSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
  }
  try {
    atomicWrite(canonical, INDEX_FILE, body, true);
  } catch {
    // The index is derived. Record files remain the source of truth.
  }
}

function refresh(canonical: string, limits: StoreLimits): HistoryList {
  recoverUnlocked(canonical, limits.tempMaxAgeMs);
  reclaimParkedSidecars(canonical);
  const listed = readEntries(canonical);
  writeDerivedIndex(canonical, listed.records);
  return listed;
}

function envOf(options?: HistoryStoreOptions): NodeJS.ProcessEnv {
  return options?.env ?? process.env;
}

export async function saveAnalysisRecord(draft: unknown, options?: HistoryStoreOptions): Promise<SaveAnalysisResult> {
  assertServerContext();
  const canonical = resolveRoot(envOf(options));
  const limits = limitsFrom(options);
  const body = validateAnalysisDraft(draft);
  return runExclusive(canonical, options, async () => {
    const listed = refresh(canonical, limits);
    const candidate = buildAnalysisRecord(createRecordId(), body);
    const identity = analysisIdentity(candidate);
    const existing = listed.records.find((record) => analysisIdentity(record) === identity);
    if (existing) return { record: existing, created: false };
    const payload = serializeRecord(candidate);
    const payloadBytes = Buffer.byteLength(payload);
    if (payloadBytes > limits.maxRecordBytes) {
      throw new AnalysisHistoryError('PAYLOAD_TOO_LARGE', 'Analysis history record exceeds the size limit.');
    }
    assertCapacity(listed.records.length + 1, recordBytes(canonical, listed.records) + payloadBytes, limits);
    atomicWrite(canonical, `${candidate.id}.json`, payload, false, options?.fault);
    writeDerivedIndex(canonical, [candidate, ...listed.records]);
    return { record: candidate, created: true };
  });
}

export async function listAnalysisRecords(options?: HistoryStoreOptions): Promise<HistoryList> {
  assertServerContext();
  const canonical = resolveRoot(envOf(options));
  const limits = limitsFrom(options);
  return runExclusive(canonical, options, async () => refresh(canonical, limits));
}

export async function readAnalysisRecord(id: string, options?: HistoryStoreOptions): Promise<AnalysisHistoryRecord> {
  assertServerContext();
  const recordId = assertRecordId(id);
  const canonical = resolveRoot(envOf(options));
  const limits = limitsFrom(options);
  return runExclusive(canonical, options, async () => {
    const listed = refresh(canonical, limits);
    const found = listed.records.find((record) => record.id === recordId);
    if (found) return found;
    const isolated = listed.isolated.find((entry) => entry.id === recordId);
    if (isolated?.reason === 'schema-mismatch') {
      throw new AnalysisHistoryError('SCHEMA_UNSUPPORTED', 'Analysis history schema version is not supported.');
    }
    if (isolated) {
      throw new AnalysisHistoryError('RECORD_CORRUPT', 'Analysis history isolated an unreadable record. Other records were kept.');
    }
    throw new AnalysisHistoryError('RECORD_NOT_FOUND', 'Analysis history record was not found.');
  });
}

export async function touchAnalysisRecord(id: string, openedAt: string, options?: HistoryStoreOptions): Promise<AnalysisHistoryRecord> {
  assertServerContext();
  const recordId = assertRecordId(id);
  const canonical = resolveRoot(envOf(options));
  const limits = limitsFrom(options);
  return runExclusive(canonical, options, async () => {
    const listed = refresh(canonical, limits);
    const current = listed.records.find((record) => record.id === recordId);
    if (!current) throw new AnalysisHistoryError('RECORD_NOT_FOUND', 'Analysis history record was not found.');
    const updated = buildAnalysisRecord(current.id, {
      source: current.source,
      analyzedAt: current.analyzedAt,
      audioDurationSeconds: current.audioDurationSeconds,
      models: current.models,
      chords: current.chords,
      beats: current.beats,
      downbeats: current.downbeats,
      synchronizedChords: current.synchronizedChords,
      meter: current.meter,
      bpm: current.bpm,
      key: current.key,
    }, openedAt);
    if (updated.resultSha256 !== current.resultSha256) {
      throw new AnalysisHistoryError('RECORD_INVALID', 'Opening a record cannot change its analysis hash.');
    }
    const payload = serializeRecord(updated);
    const payloadBytes = Buffer.byteLength(payload);
    if (payloadBytes > limits.maxRecordBytes) {
      throw new AnalysisHistoryError('PAYLOAD_TOO_LARGE', 'Analysis history record exceeds the size limit.');
    }
    const oldBytes = recordBytes(canonical, [current]);
    assertCapacity(
      listed.records.length,
      recordBytes(canonical, listed.records) - oldBytes + payloadBytes,
      limits,
    );
    atomicWrite(canonical, `${current.id}.json`, payload, true, options?.fault);
    writeDerivedIndex(canonical, listed.records.map((record) => (record.id === current.id ? updated : record)));
    return updated;
  });
}

export async function deleteAnalysisRecord(
  request: DeleteAnalysisRecordRequest,
  options?: HistoryStoreOptions,
): Promise<void> {
  assertServerContext();
  if (!request || request.confirmDelete !== true) {
    throw new AnalysisHistoryError(
      'DELETE_NOT_CONFIRMED',
      'Deleting an analysis record requires an explicit confirmation for that record.',
    );
  }
  const recordId = assertRecordId(request.recordId);
  const canonical = resolveRoot(envOf(options));
  const limits = limitsFrom(options);
  return runExclusive(canonical, options, async () => {
    const target = contained(canonical, `${recordId}.json`);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new AnalysisHistoryError('RECORD_NOT_FOUND', 'Analysis history record was not found.');
      }
      throw mapFs(error);
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new AnalysisHistoryError('PATH_UNSAFE', 'Refusing to delete a history path that is not a record file.');
    }
    const parked = parkLyricSidecar(canonical, recordId);
    try {
      options?.fault?.beforeParentUnlink?.();
      fs.unlinkSync(target);
    } catch (error) {
      if (parked) {
        try {
          restoreParkedSidecar(canonical, recordId, parked);
        } catch {
          // The parked sidecar stays in this directory. The next locked read moves it back.
        }
      }
      throw mapFs(error);
    }
    const listed = refresh(canonical, limits);
    writeDerivedIndex(canonical, listed.records.filter((record) => record.id !== recordId));
  });
}

function parkLyricSidecar(canonical: string, recordId: string): string | null {
  const name = lyricSidecarFileName(recordId);
  const stat = lyricFileStat(canonical, recordId);
  if (!stat) return null;
  if (!stat.isFile() && !stat.isSymbolicLink()) {
    throw new AnalysisHistoryError('PATH_UNSAFE', 'Refusing to delete a lyric sidecar that is not a file.');
  }
  const parked = `.${name}.pending-delete-${process.pid}-${randomBytes(8).toString('hex')}`;
  try {
    fs.renameSync(contained(canonical, name), contained(canonical, parked));
  } catch (error) {
    throw mapFs(error);
  }
  return parked;
}

function restoreParkedSidecar(canonical: string, recordId: string, parkedName: string): void {
  if (!PENDING_LYRIC_DELETE.test(parkedName) || !parkedName.includes(recordId)) {
    throw new AnalysisHistoryError('PATH_UNSAFE', 'Refusing to restore a lyric sidecar from an unsafe name.');
  }
  if (lyricFileStat(canonical, recordId)) return;
  fs.renameSync(contained(canonical, parkedName), contained(canonical, lyricSidecarFileName(recordId)));
}

function reclaimParkedSidecars(canonical: string): void {
  let names: string[] = [];
  try {
    names = fs.readdirSync(canonical);
  } catch (error) {
    throw mapFs(error);
  }
  const parkedByParent = new Map<string, string[]>();
  for (const name of names) {
    const match = PENDING_LYRIC_DELETE.exec(name);
    if (!match) continue;
    const parentId = match[1];
    const parked = parkedByParent.get(parentId) ?? [];
    parked.push(name);
    parkedByParent.set(parentId, parked);
  }
  for (const [parentId, parkedNames] of parkedByParent) {
    let parentIsFile = false;
    try {
      const parentStat = fs.lstatSync(contained(canonical, `${parentId}.json`));
      parentIsFile = parentStat.isFile() && !parentStat.isSymbolicLink();
    } catch {
      parentIsFile = false;
    }
    if (!parentIsFile) {
      for (const parked of parkedNames) {
        try {
          const parkedStat = fs.lstatSync(contained(canonical, parked));
          if (parkedStat.isSymbolicLink() || parkedStat.isFile()) fs.unlinkSync(contained(canonical, parked));
        } catch {
          // The next recovery retries. The name cannot attach to another analysis.
        }
      }
      continue;
    }
    if (lyricFileStat(canonical, parentId)) continue;
    const newest = [...parkedNames].sort((left, right) => {
      try {
        return fs.lstatSync(contained(canonical, right)).mtimeMs - fs.lstatSync(contained(canonical, left)).mtimeMs;
      } catch {
        return 0;
      }
    })[0];
    if (!newest) continue;
    try {
      restoreParkedSidecar(canonical, parentId, newest);
    } catch {
      // Leave the parked file in place until a later locked read can move it back.
    }
  }
}

function lyricFileStat(canonical: string, recordId: string): fs.Stats | null {
  const target = contained(canonical, lyricSidecarFileName(recordId));
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw mapFs(error);
  }
}

function removeLyricFile(canonical: string, recordId: string, missing: 'ignore' | 'error'): void {
  const name = lyricSidecarFileName(recordId);
  const stat = lyricFileStat(canonical, recordId);
  if (!stat) {
    if (missing === 'error') {
      throw new AnalysisHistoryError('RECORD_NOT_FOUND', 'Lyric sidecar was not found.');
    }
    return;
  }
  if (stat.isSymbolicLink()) {
    try {
      fs.unlinkSync(contained(canonical, name));
      return;
    } catch (error) {
      throw mapFs(error);
    }
  }
  if (!stat.isFile()) {
    throw new AnalysisHistoryError('PATH_UNSAFE', 'Refusing to delete a lyric sidecar that is not a file.');
  }
  try {
    fs.unlinkSync(contained(canonical, name));
  } catch (error) {
    throw mapFs(error);
  }
}

function quarantineLyricFile(canonical: string, recordId: string): void {
  const name = lyricSidecarFileName(recordId);
  const stat = lyricFileStat(canonical, recordId);
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    try {
      fs.unlinkSync(contained(canonical, name));
    } catch {
      // Leave an unlinkable symlink in place and fail the read below.
    }
    return;
  }
  if (!stat.isFile()) {
    throw new AnalysisHistoryError('PATH_UNSAFE', 'Lyric sidecar is not a file.');
  }
  isolateFile(canonical, name);
}

function requireParent(canonical: string, recordId: string, limits: StoreLimits): AnalysisHistoryRecord {
  const listed = refresh(canonical, limits);
  const found = listed.records.find((record) => record.id === recordId);
  if (found) return found;
  const isolated = listed.isolated.find((entry) => entry.id === recordId);
  if (isolated?.reason === 'schema-mismatch') {
    throw new AnalysisHistoryError('SCHEMA_UNSUPPORTED', 'Analysis history schema version is not supported.');
  }
  if (isolated) {
    throw new AnalysisHistoryError('RECORD_CORRUPT', 'Analysis history isolated an unreadable record. Other records were kept.');
  }
  throw new AnalysisHistoryError('RECORD_NOT_FOUND', 'Analysis history record was not found.');
}

function assertParentDuration(parent: AnalysisHistoryRecord, draft: LyricSidecarDraft): void {
  if (parent.audioDurationSeconds === null || !(parent.audioDurationSeconds > 0)) return;
  if (Math.abs(draft.audioDurationSeconds - parent.audioDurationSeconds) > 0.05) {
    throw new AnalysisHistoryError('RECORD_INVALID', 'Lyric audio duration does not match this analysis.');
  }
}

export async function readLyricSidecar(parentId: string, options?: HistoryStoreOptions): Promise<LyricSidecar | null> {
  assertServerContext();
  const recordId = assertRecordId(parentId);
  const canonical = resolveRoot(envOf(options));
  const limits = limitsFrom(options);
  return runExclusive(canonical, options, async () => {
    const listed = refresh(canonical, limits);
    const parent = listed.records.find((record) => record.id === recordId);
    if (!parent) {
      quarantineLyricFile(canonical, recordId);
      const isolated = listed.isolated.find((entry) => entry.id === recordId);
      if (isolated?.reason === 'schema-mismatch') {
        throw new AnalysisHistoryError('SCHEMA_UNSUPPORTED', 'Analysis history schema version is not supported.');
      }
      if (isolated) {
        throw new AnalysisHistoryError('RECORD_CORRUPT', 'Analysis history isolated an unreadable record. Other records were kept.');
      }
      throw new AnalysisHistoryError('RECORD_NOT_FOUND', 'Analysis history record was not found.');
    }
    const name = lyricSidecarFileName(recordId);
    const stat = lyricFileStat(canonical, recordId);
    if (!stat) return null;
    if (stat.isSymbolicLink() || !stat.isFile()) {
      if (stat.isSymbolicLink()) {
        try { fs.unlinkSync(contained(canonical, name)); } catch { /* do not follow the link */ }
      }
      throw new AnalysisHistoryError('PATH_UNSAFE', 'Refusing to read a lyric sidecar through an unsafe path.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(contained(canonical, name), 'utf8'));
    } catch {
      quarantineLyricFile(canonical, recordId);
      throw new AnalysisHistoryError('RECORD_CORRUPT', 'Lyric sidecar was unreadable and was quarantined. The analysis record was kept.');
    }
    try {
      const sidecar = parseLyricSidecar(parsed, recordId);
      if (sidecar.parentResultSha256 !== parent.resultSha256) {
        throw new AnalysisHistoryError('LYRIC_PARENT_MISMATCH', 'Lyric sidecar does not match this analysis result.');
      }
      return sidecar;
    } catch (error) {
      if (error instanceof AnalysisHistoryError && error.code === 'LYRIC_PARENT_MISMATCH') throw error;
      quarantineLyricFile(canonical, recordId);
      throw error;
    }
  });
}

export async function saveLyricSidecar(
  parentId: string,
  draftInput: unknown,
  options?: HistoryStoreOptions,
): Promise<SaveLyricSidecarResult> {
  assertServerContext();
  const recordId = assertRecordId(parentId);
  const draft = validateLyricSidecarDraft(draftInput);
  const canonical = resolveRoot(envOf(options));
  const limits = limitsFrom(options);
  return runExclusive(canonical, options, async () => {
    const parent = requireParent(canonical, recordId, limits);
    assertParentDuration(parent, draft);
    const lyrics = buildLyricSidecar(recordId, parent.resultSha256, draft, new Date().toISOString());
    const payload = serializeLyricSidecar(lyrics);
    if (Buffer.byteLength(payload) > Math.min(limits.maxRecordBytes, LYRIC_SIDECAR_MAX_BYTES)) {
      throw new AnalysisHistoryError('PAYLOAD_TOO_LARGE', 'Lyric sidecar exceeds the size limit.');
    }
    const existing = lyricFileStat(canonical, recordId);
    if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
      throw new AnalysisHistoryError('PATH_UNSAFE', 'Refusing to replace an unsafe lyric sidecar path.');
    }
    atomicWrite(canonical, lyricSidecarFileName(recordId), payload, true, options?.fault);
    return { lyrics, created: !existing };
  });
}

export async function deleteLyricSidecar(parentId: string, options?: HistoryStoreOptions): Promise<void> {
  assertServerContext();
  const recordId = assertRecordId(parentId);
  const canonical = resolveRoot(envOf(options));
  return runExclusive(canonical, options, async () => {
    removeLyricFile(canonical, recordId, 'error');
  });
}

export async function recoverInterruptedWrites(options?: HistoryStoreOptions): Promise<void> {
  assertServerContext();
  const canonical = resolveRoot(envOf(options));
  const limits = limitsFrom(options);
  return runExclusive(canonical, options, async () => {
    recoverUnlocked(canonical, limits.tempMaxAgeMs);
    reclaimParkedSidecars(canonical);
  });
}
