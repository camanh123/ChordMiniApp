import { createHash, randomUUID } from 'crypto';
import { AnalysisHistoryError } from './errors';

export const ANALYSIS_HISTORY_SCHEMA_VERSION = 1;
export const ANALYSIS_HISTORY_PIPELINE = 'local-upload-v1';
export const ANALYSIS_HISTORY_MAX_RECORDS = 200;
export const ANALYSIS_HISTORY_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
export const ANALYSIS_HISTORY_MAX_RECORD_BYTES = 2 * 1024 * 1024;
export const ANALYSIS_HISTORY_MAX_TIMELINE_SECONDS = 3600;
export const ANALYSIS_HISTORY_MAX_AUDIO_BYTES = 100 * 1024 * 1024;

const MAX_DISPLAY_NAME = 180;
const MAX_CHORD_LABEL = 64;
const MAX_KEY_LENGTH = 64;
const MAX_CHORDS = 20_000;
const MAX_BEATS = 100_000;
const MAX_DOWNBEATS = 20_000;
const MAX_SYNCHRONIZED = 100_000;
const MAX_STRING = 4096;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?Z$/;
const FORBIDDEN_KEYS = new Set([
  'apikey',
  'api_key',
  'token',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'cookie',
  'cookies',
  'nonce',
  'secret',
  'password',
  'credential',
  'credentials',
  'audiobytes',
  'audiobase64',
  'bytes',
  'blob',
  'filepath',
  'absolutepath',
  'storagepath',
  'audiourl',
  'content',
  'file',
  'mp3',
  'wav',
  'backendnonce',
  'inferencesecret',
]);

export interface ProvenanceValue<T, P extends string> {
  value: T;
  provenance: P;
}

export interface HistoryChord {
  chord: string;
  start: number;
  end: number;
  confidence?: ProvenanceValue<number, 'model'>;
}

export interface HistoryBeat {
  time: number;
}

export interface HistoryDownbeats {
  times: number[];
  provenance: 'model';
}

export interface HistorySynchronizedChord {
  chord: string;
  beatIndex: number;
  beatNum?: number;
}

export interface HistoryMeter {
  beatsPerBar: 3 | 4;
  denominator: 4;
  provenance: 'madmom-candidate-selection';
}

export interface HistorySource {
  kind: 'local-audio';
  displayName: string;
  sizeBytes: number;
  contentSha256: string;
}

export interface HistoryModels {
  beat: string;
  chord: string;
  beatReported: string | null;
}

export interface AnalysisHistoryRecord {
  schemaVersion: 1;
  id: string;
  source: HistorySource;
  analyzedAt: string;
  lastOpenedAt: string;
  audioDurationSeconds: number | null;
  models: HistoryModels;
  chords: HistoryChord[];
  beats: HistoryBeat[];
  downbeats: HistoryDownbeats | null;
  synchronizedChords: HistorySynchronizedChord[] | null;
  meter: HistoryMeter | null;
  bpm: ProvenanceValue<number, 'model'> | null;
  key: ProvenanceValue<string, 'key-service'> | null;
  status: 'complete';
  provenance: { pipeline: typeof ANALYSIS_HISTORY_PIPELINE };
  resultSha256: string;
}

export function assertRecordId(id: string): string {
  if (typeof id !== 'string' || !UUID_V4.test(id)) {
    throw new AnalysisHistoryError('PATH_UNSAFE', 'Analysis history record id is not a stable identifier.');
  }
  return id;
}

export function createRecordId(): string {
  return assertRecordId(randomUUID());
}

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new AnalysisHistoryError('RECORD_INVALID', 'Analysis history numbers must be finite.');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  throw new AnalysisHistoryError('RECORD_INVALID', 'Analysis history contains a value that cannot be stored.');
}

export function resultDocument(record: Pick<
  AnalysisHistoryRecord,
  'chords' | 'beats' | 'downbeats' | 'synchronizedChords' | 'meter' | 'bpm' | 'key'
>): Record<string, unknown> {
  const document: Record<string, unknown> = {
    schemaVersion: ANALYSIS_HISTORY_SCHEMA_VERSION,
    beats: record.beats,
    chords: record.chords,
  };
  if (record.downbeats) document.downbeats = record.downbeats;
  if (record.synchronizedChords) document.synchronizedChords = record.synchronizedChords;
  if (record.meter) document.meter = record.meter;
  if (record.bpm) document.bpm = record.bpm;
  if (record.key) document.key = record.key;
  return document;
}

export function hashAnalysisResult(record: Pick<
  AnalysisHistoryRecord,
  'chords' | 'beats' | 'downbeats' | 'synchronizedChords' | 'meter' | 'bpm' | 'key'
>): string {
  return createHash('sha256').update(canonicalJson(resultDocument(record))).digest('hex');
}

export function analysisIdentity(record: Pick<AnalysisHistoryRecord, 'source' | 'models' | 'resultSha256'>): string {
  return [
    record.source.contentSha256,
    record.models.beat,
    record.models.chord,
    record.resultSha256,
  ].join('\n');
}

function invalid(message: string): AnalysisHistoryError {
  return new AnalysisHistoryError('RECORD_INVALID', message);
}

function assertNoForbidden(value: unknown, depth = 0): void {
  if (depth > 12) {
    throw new AnalysisHistoryError('PAYLOAD_TOO_LARGE', 'Analysis history payload is nested too deeply.');
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_BEATS) {
      throw new AnalysisHistoryError('PAYLOAD_TOO_LARGE', 'Analysis history payload has too many timeline events.');
    }
    for (const entry of value) assertNoForbidden(entry, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string') assertPlainString(value);
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (FORBIDDEN_KEYS.has(normalized) || key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw invalid('Analysis history cannot store credentials, audio bytes, or file paths.');
    }
    assertNoForbidden(entry, depth + 1);
  }
}

function assertPlainString(value: string): void {
  if (value.length > MAX_STRING) {
    throw new AnalysisHistoryError('PAYLOAD_TOO_LARGE', 'Analysis history text field is too long.');
  }
  if (/bearer\s+/i.test(value) || value.includes('-----BEGIN ') || value.startsWith('data:audio')) {
    throw invalid('Analysis history cannot store credentials or audio data.');
  }
}

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw invalid(`${label} contains unexpected field ${key}.`);
    }
  }
}

function assertTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !TIMESTAMP.test(value)) {
    throw invalid(`${label} must be a UTC ISO-8601 timestamp.`);
  }
  const match = TIMESTAMP.exec(value);
  if (!match) throw invalid(`${label} must be a UTC ISO-8601 timestamp.`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (year < 2000 || year > 2100 || hour > 23 || minute > 59 || second > 59) {
    throw invalid(`${label} is outside the supported range.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw invalid(`${label} is not a real timestamp.`);
  const date = new Date(parsed);
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() + 1 !== month
    || date.getUTCDate() !== day
    || date.getUTCHours() !== hour
    || date.getUTCMinutes() !== minute
    || date.getUTCSeconds() !== second
  ) {
    throw invalid(`${label} is not a real timestamp.`);
  }
  return value;
}

function assertTime(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > ANALYSIS_HISTORY_MAX_TIMELINE_SECONDS) {
    throw invalid(`${label} must be a finite time from 0 to ${ANALYSIS_HISTORY_MAX_TIMELINE_SECONDS} seconds.`);
  }
  return value;
}

function assertModel(value: unknown, label: string): string {
  if (typeof value !== 'string' || !MODEL_ID.test(value)) {
    throw invalid(`${label} must be an actual model identifier.`);
  }
  return value;
}

function assertChordLabel(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CHORD_LABEL || /[\u0000-\u001f\u007f]/.test(value)) {
    throw invalid('Chord label is missing or too long.');
  }
  return value;
}

function assertDisplayName(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_DISPLAY_NAME || value !== value.trim()) {
    throw invalid('Audio display name is missing or too long.');
  }
  if (/[\u0000-\u001f\u007f:\\/]/.test(value) || value === '.' || value === '..') {
    throw invalid('Audio display name must be a file name, not a path.');
  }
  return value;
}

function assertConfidence(value: unknown): ProvenanceValue<number, 'model'> | undefined {
  if (value === undefined || value === null) return undefined;
  const record = assertObject(value, 'Chord confidence');
  assertExactKeys(record, ['value', 'provenance'], 'Chord confidence');
  if (record.provenance !== 'model') {
    throw invalid('Chord confidence requires model provenance.');
  }
  if (typeof record.value !== 'number' || !Number.isFinite(record.value) || record.value < 0 || record.value > 1) {
    throw invalid('Chord confidence must be a finite model score from 0 to 1.');
  }
  return { value: record.value, provenance: 'model' };
}

function assertChords(value: unknown): HistoryChord[] {
  if (!Array.isArray(value)) throw invalid('Chord timeline must be an array.');
  if (value.length > MAX_CHORDS) {
    throw new AnalysisHistoryError('PAYLOAD_TOO_LARGE', 'Chord timeline is too large.');
  }
  let previousStart = -1;
  return value.map((entry) => {
    const record = assertObject(entry, 'Chord');
    assertExactKeys(record, ['chord', 'start', 'end', 'confidence'], 'Chord');
    const start = assertTime(record.start, 'Chord start');
    const end = assertTime(record.end, 'Chord end');
    if (start >= end) throw invalid('Chord end must be later than chord start.');
    if (start <= previousStart) throw invalid('Chord timeline must be ordered by start time.');
    previousStart = start;
    const chord: HistoryChord = { chord: assertChordLabel(record.chord), start, end };
    const confidence = assertConfidence(record.confidence);
    if (confidence) chord.confidence = confidence;
    return chord;
  });
}

function assertBeats(value: unknown): HistoryBeat[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BEATS) {
    throw invalid('Beat timeline must contain at least one finite timestamp.');
  }
  let previous = -1;
  return value.map((entry) => {
    const record = assertObject(entry, 'Beat');
    assertExactKeys(record, ['time'], 'Beat');
    const time = assertTime(record.time, 'Beat time');
    if (time <= previous) throw invalid('Beat timeline must be strictly increasing.');
    previous = time;
    return { time };
  });
}

function assertDownbeats(value: unknown): HistoryDownbeats | null {
  if (value === undefined || value === null) return null;
  const record = assertObject(value, 'Downbeats');
  assertExactKeys(record, ['times', 'provenance'], 'Downbeats');
  if (record.provenance !== 'model') throw invalid('Downbeats require model provenance.');
  if (!Array.isArray(record.times) || record.times.length > MAX_DOWNBEATS) {
    throw invalid('Downbeat timeline is invalid.');
  }
  if (record.times.length === 0) return null;
  let previous = -1;
  const times = record.times.map((time) => {
    const parsed = assertTime(time, 'Downbeat time');
    if (parsed <= previous) throw invalid('Downbeat timeline must be strictly increasing.');
    previous = parsed;
    return parsed;
  });
  return { times, provenance: 'model' };
}

function assertSynchronized(value: unknown, beatCount: number): HistorySynchronizedChord[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > MAX_SYNCHRONIZED) {
    throw invalid('Synchronized chord timeline is invalid.');
  }
  if (value.length === 0) return null;
  let previousIndex = -1;
  return value.map((entry) => {
    const record = assertObject(entry, 'Synchronized chord');
    assertExactKeys(record, ['chord', 'beatIndex', 'beatNum'], 'Synchronized chord');
    if (typeof record.beatIndex !== 'number' || !Number.isInteger(record.beatIndex) || record.beatIndex < 0 || record.beatIndex >= beatCount) {
      throw invalid('Synchronized chord beat index is outside the beat timeline.');
    }
    if (record.beatIndex < previousIndex) throw invalid('Synchronized chords must follow the beat timeline.');
    previousIndex = record.beatIndex;
    const chord: HistorySynchronizedChord = {
      chord: assertChordLabel(record.chord),
      beatIndex: record.beatIndex,
    };
    if (record.beatNum !== undefined && record.beatNum !== null) {
      if (typeof record.beatNum !== 'number' || !Number.isInteger(record.beatNum) || record.beatNum < 1 || record.beatNum > 32) {
        throw invalid('Synchronized chord beat number is invalid.');
      }
      chord.beatNum = record.beatNum;
    }
    return chord;
  });
}

function assertMeter(value: unknown): HistoryMeter | null {
  if (value === undefined || value === null) return null;
  const record = assertObject(value, 'Time signature');
  assertExactKeys(record, ['beatsPerBar', 'denominator', 'provenance'], 'Time signature');
  if (record.provenance !== 'madmom-candidate-selection') {
    throw invalid('Time signature requires meter-selection provenance.');
  }
  if (record.denominator !== 4 || (record.beatsPerBar !== 3 && record.beatsPerBar !== 4)) {
    throw invalid('Time signature must be the selected 3/4 or 4/4 meter.');
  }
  return {
    beatsPerBar: record.beatsPerBar,
    denominator: 4,
    provenance: 'madmom-candidate-selection',
  };
}

function assertBpm(value: unknown): ProvenanceValue<number, 'model'> | null {
  if (value === undefined || value === null) return null;
  const record = assertObject(value, 'BPM');
  assertExactKeys(record, ['value', 'provenance'], 'BPM');
  if (record.provenance !== 'model') throw invalid('BPM requires model provenance.');
  if (typeof record.value !== 'number' || !Number.isFinite(record.value) || record.value < 1 || record.value > 400) {
    throw invalid('BPM must be a finite model measurement.');
  }
  return { value: record.value, provenance: 'model' };
}

function assertKey(value: unknown): ProvenanceValue<string, 'key-service'> | null {
  if (value === undefined || value === null) return null;
  const record = assertObject(value, 'Key');
  assertExactKeys(record, ['value', 'provenance'], 'Key');
  if (record.provenance !== 'key-service') throw invalid('Key requires key-service provenance.');
  if (typeof record.value !== 'string' || record.value.length === 0 || record.value.length > MAX_KEY_LENGTH || record.value === 'Unknown') {
    throw invalid('Key must be a real key-service result.');
  }
  if (/[\u0000-\u001f\u007f:\\/]/.test(record.value)) throw invalid('Key contains unsupported characters.');
  return { value: record.value, provenance: 'key-service' };
}

function assertDuration(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > ANALYSIS_HISTORY_MAX_TIMELINE_SECONDS) {
    throw invalid('Audio duration must be a measured finite length.');
  }
  return value;
}

function assertSource(value: unknown): HistorySource {
  const record = assertObject(value, 'Source');
  assertExactKeys(record, ['kind', 'displayName', 'sizeBytes', 'contentSha256'], 'Source');
  if (record.kind !== 'local-audio') throw invalid('This store accepts local-audio records only.');
  if (typeof record.sizeBytes !== 'number' || !Number.isInteger(record.sizeBytes) || record.sizeBytes < 0 || record.sizeBytes > ANALYSIS_HISTORY_MAX_AUDIO_BYTES) {
    throw invalid('Audio file size is missing or outside the supported range.');
  }
  if (typeof record.contentSha256 !== 'string' || !SHA256_HEX.test(record.contentSha256)) {
    throw invalid('Audio content hash must be a lowercase SHA-256 digest.');
  }
  return {
    kind: 'local-audio',
    displayName: assertDisplayName(record.displayName),
    sizeBytes: record.sizeBytes,
    contentSha256: record.contentSha256,
  };
}

function assertModels(value: unknown): HistoryModels {
  const record = assertObject(value, 'Models');
  assertExactKeys(record, ['beat', 'chord', 'beatReported'], 'Models');
  const beatReported = record.beatReported === undefined || record.beatReported === null
    ? null
    : assertModel(record.beatReported, 'Reported beat model');
  return {
    beat: assertModel(record.beat, 'Beat model'),
    chord: assertModel(record.chord, 'Chord model'),
    beatReported,
  };
}

export interface NormalizedHistoryBody {
  source: HistorySource;
  analyzedAt: string;
  audioDurationSeconds: number | null;
  models: HistoryModels;
  chords: HistoryChord[];
  beats: HistoryBeat[];
  downbeats: HistoryDownbeats | null;
  synchronizedChords: HistorySynchronizedChord[] | null;
  meter: HistoryMeter | null;
  bpm: ProvenanceValue<number, 'model'> | null;
  key: ProvenanceValue<string, 'key-service'> | null;
}

export function validateAnalysisDraft(input: unknown): NormalizedHistoryBody {
  assertNoForbidden(input);
  const record = assertObject(input, 'Analysis record');
  assertExactKeys(record, [
    'schemaVersion',
    'source',
    'analyzedAt',
    'audioDurationSeconds',
    'models',
    'chords',
    'beats',
    'downbeats',
    'synchronizedChords',
    'meter',
    'bpm',
    'key',
    'status',
    'provenance',
  ], 'Analysis record');
  if (record.schemaVersion !== undefined && record.schemaVersion !== ANALYSIS_HISTORY_SCHEMA_VERSION) {
    throw new AnalysisHistoryError('SCHEMA_UNSUPPORTED', 'Analysis history schema version is not supported.');
  }
  if (record.status !== 'complete') throw invalid('Only a completed analysis can be stored.');
  const provenance = assertObject(record.provenance, 'Provenance');
  assertExactKeys(provenance, ['pipeline'], 'Provenance');
  if (provenance.pipeline !== ANALYSIS_HISTORY_PIPELINE) {
    throw invalid('Analysis provenance pipeline is not supported.');
  }
  const beats = assertBeats(record.beats);
  return {
    source: assertSource(record.source),
    analyzedAt: assertTimestamp(record.analyzedAt, 'Analysis timestamp'),
    audioDurationSeconds: assertDuration(record.audioDurationSeconds),
    models: assertModels(record.models),
    chords: assertChords(record.chords),
    beats,
    downbeats: assertDownbeats(record.downbeats),
    synchronizedChords: assertSynchronized(record.synchronizedChords, beats.length),
    meter: assertMeter(record.meter),
    bpm: assertBpm(record.bpm),
    key: assertKey(record.key),
  };
}

export function buildAnalysisRecord(id: string, body: NormalizedHistoryBody, lastOpenedAt = body.analyzedAt): AnalysisHistoryRecord {
  const opened = assertTimestamp(lastOpenedAt, 'Opened timestamp');
  if (Date.parse(opened) < Date.parse(body.analyzedAt)) {
    throw invalid('Opened timestamp cannot be earlier than the analysis timestamp.');
  }
  const hashed = hashAnalysisResult(body);
  return {
    schemaVersion: ANALYSIS_HISTORY_SCHEMA_VERSION,
    id: assertRecordId(id),
    source: body.source,
    analyzedAt: body.analyzedAt,
    lastOpenedAt: opened,
    audioDurationSeconds: body.audioDurationSeconds,
    models: body.models,
    chords: body.chords,
    beats: body.beats,
    downbeats: body.downbeats,
    synchronizedChords: body.synchronizedChords,
    meter: body.meter,
    bpm: body.bpm,
    key: body.key,
    status: 'complete',
    provenance: { pipeline: ANALYSIS_HISTORY_PIPELINE },
    resultSha256: hashed,
  };
}

export function parseStoredRecord(input: unknown, fileId: string): AnalysisHistoryRecord {
  const record = assertObject(input, 'Stored analysis');
  if (record.schemaVersion !== ANALYSIS_HISTORY_SCHEMA_VERSION) {
    throw new AnalysisHistoryError('SCHEMA_UNSUPPORTED', 'Analysis history schema version is not supported.');
  }
  assertExactKeys(record, [
    'schemaVersion',
    'id',
    'source',
    'analyzedAt',
    'lastOpenedAt',
    'audioDurationSeconds',
    'models',
    'chords',
    'beats',
    'downbeats',
    'synchronizedChords',
    'meter',
    'bpm',
    'key',
    'status',
    'provenance',
    'resultSha256',
  ], 'Stored analysis');
  if (record.id !== fileId) throw invalid('Stored record id does not match its file.');
  if (typeof record.resultSha256 !== 'string' || !SHA256_HEX.test(record.resultSha256)) {
    throw invalid('Stored result hash is invalid.');
  }
  const built = buildAnalysisRecord(fileId, validateAnalysisDraft({
    schemaVersion: ANALYSIS_HISTORY_SCHEMA_VERSION,
    source: record.source,
    analyzedAt: record.analyzedAt,
    audioDurationSeconds: record.audioDurationSeconds,
    models: record.models,
    chords: record.chords,
    beats: record.beats,
    downbeats: record.downbeats,
    synchronizedChords: record.synchronizedChords,
    meter: record.meter,
    bpm: record.bpm,
    key: record.key,
    status: record.status,
    provenance: record.provenance,
  }), typeof record.lastOpenedAt === 'string' ? record.lastOpenedAt : '');
  if (built.resultSha256 !== record.resultSha256) {
    throw new AnalysisHistoryError('RECORD_CORRUPT', 'Stored result hash does not match the analysis.');
  }
  return built;
}

export function serializeRecord(record: AnalysisHistoryRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}
