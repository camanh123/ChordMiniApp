/**
 * Versioned lyric sidecar for one schemaVersion 1 analysis record.
 * The parent JSON and its resultSha256 are not rewritten by this module.
 * Source lyric timestamps stay unshifted. offsetSeconds is applied later.
 */

import { AnalysisHistoryError } from './errors';
import { ANALYSIS_HISTORY_MAX_TIMELINE_SECONDS, assertRecordId } from './schema';

export const LYRIC_SIDECAR_SCHEMA_VERSION = 1;
export const LYRIC_SIDECAR_MAX_BYTES = 512 * 1024;
const MAX_ROWS = 4_000;
const MAX_WORDS = 64;
const MAX_TEXT = 400;
const MAX_LABEL = 200;

const SHA256_HEX = /^[0-9a-f]{64}$/;
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
  'mp3',
  'wav',
  'backendnonce',
  'inferencesecret',
]);

export interface LyricSidecarWord {
  text: string;
  startTime: number;
  endTime: number;
}

export interface LyricSidecarRow {
  time: number;
  text: string;
  words: LyricSidecarWord[] | null;
}

export interface LyricSidecarDraft {
  parentResultSha256: string;
  source: 'lrclib' | 'local-lrc';
  trackTitle: string;
  artist: string;
  catalogDurationSeconds: number | null;
  audioDurationSeconds: number;
  granularity: 'line' | 'word';
  sourceOffsetSeconds: number;
  offsetSeconds: number;
  confirmedEdition: true;
  recognizesAudio: false;
  userModified: boolean;
  rows: LyricSidecarRow[];
}

export interface LyricSidecar extends LyricSidecarDraft {
  schemaVersion: 1;
  parentId: string;
  savedAt: string;
}

const DRAFT_KEYS = [
  'parentResultSha256',
  'source',
  'trackTitle',
  'artist',
  'catalogDurationSeconds',
  'audioDurationSeconds',
  'granularity',
  'sourceOffsetSeconds',
  'offsetSeconds',
  'confirmedEdition',
  'recognizesAudio',
  'userModified',
  'rows',
] as const;

const STORED_KEYS = ['schemaVersion', 'parentId', 'savedAt', ...DRAFT_KEYS];

export function lyricSidecarFileName(parentId: string): string {
  return `${assertRecordId(parentId)}.lyrics.json`;
}

function invalid(message: string): AnalysisHistoryError {
  return new AnalysisHistoryError('RECORD_INVALID', message);
}

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw invalid(`${label} contains unexpected field ${key}.`);
  }
}

function rejectSecrets(value: unknown, depth = 0): void {
  if (depth > 8) throw invalid('Lyric sidecar is nested too deeply.');
  if (Array.isArray(value)) {
    for (const entry of value) rejectSecrets(entry, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string') {
      if (
        value.includes('\0')
        || /bearer\s+/i.test(value)
        || value.includes('-----BEGIN ')
        || value.startsWith('data:audio')
        || value.includes('file://')
        || /^[A-Za-z]:\\/.test(value)
        || /^\/(?:Users|home|tmp|var|opt|workspace|private)\//.test(value)
      ) {
        throw invalid('Lyric sidecar cannot store credentials, audio bytes, or file paths.');
      }
    }
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (FORBIDDEN_KEYS.has(normalized) || key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw invalid('Lyric sidecar cannot store credentials, audio bytes, or file paths.');
    }
    rejectSecrets(entry, depth + 1);
  }
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function assertLabel(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length > MAX_LABEL) {
    throw invalid(`${label} is not a usable lyric label.`);
  }
  return value;
}

function assertClock(value: unknown, label: string, minimum: number): number {
  if (!finite(value) || value < minimum || value > ANALYSIS_HISTORY_MAX_TIMELINE_SECONDS) {
    throw invalid(`${label} is outside the lyric timeline.`);
  }
  return value;
}

function assertWords(value: unknown): LyricSidecarWord[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_WORDS) {
    throw invalid('Lyric word timestamps are not a measured list.');
  }
  const words: LyricSidecarWord[] = [];
  for (const entry of value) {
    const word = assertObject(entry, 'Lyric word');
    assertExactKeys(word, ['text', 'startTime', 'endTime'], 'Lyric word');
    if (typeof word.text !== 'string' || word.text.trim() === '' || word.text.length > MAX_TEXT) {
      throw invalid('A lyric word is missing its text.');
    }
    const startTime = assertClock(word.startTime, 'Lyric word start', 0);
    const endTime = assertClock(word.endTime, 'Lyric word end', 0);
    if (endTime < startTime) throw invalid('A lyric word ends before it starts.');
    words.push({ text: word.text, startTime, endTime });
  }
  return words;
}

function assertRows(value: unknown): LyricSidecarRow[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ROWS) {
    throw invalid('Lyric sidecar needs timestamped lines.');
  }
  const rows: LyricSidecarRow[] = [];
  for (const entry of value) {
    const row = assertObject(entry, 'Lyric row');
    assertExactKeys(row, ['time', 'text', 'words'], 'Lyric row');
    const time = assertClock(row.time, 'Lyric timestamp', 0);
    if (typeof row.text !== 'string' || row.text.length > MAX_TEXT || row.text.trim() !== row.text) {
      throw invalid('A lyric line has text that cannot be stored.');
    }
    rows.push({ time, text: row.text, words: assertWords(row.words) });
  }
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index].time < rows[index - 1].time) throw invalid('Lyric timestamps are out of order.');
  }
  if (!rows.some((row) => row.text.trim())) throw invalid('Lyric sidecar needs timestamped lines.');
  return rows;
}

function assertOffsetFits(rows: readonly LyricSidecarRow[], offsetSeconds: number, audioDurationSeconds: number): void {
  for (const row of rows) {
    if (!row.text.trim()) continue;
    const start = row.time + offsetSeconds;
    if (start < -0.001 || start >= audioDurationSeconds) {
      throw invalid('Lyric offset does not fit this audio.');
    }
    if (!row.words) continue;
    for (const word of row.words) {
      const wordStart = word.startTime + offsetSeconds;
      if (wordStart < -0.001 || wordStart >= audioDurationSeconds) {
        throw invalid('Lyric offset does not fit this audio.');
      }
    }
  }
}

function assertTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) {
    throw invalid('Lyric sidecar timestamp must be a UTC ISO-8601 value.');
  }
  return value;
}

function normalizedDraft(record: Record<string, unknown>): LyricSidecarDraft {
  if (typeof record.parentResultSha256 !== 'string' || !SHA256_HEX.test(record.parentResultSha256)) {
    throw invalid('Lyric sidecar parent hash is invalid.');
  }
  if (record.source !== 'lrclib' && record.source !== 'local-lrc') throw invalid('Lyric source is not a confirmed catalog entry or local LRC file.');
  if (record.granularity !== 'line' && record.granularity !== 'word') throw invalid('Lyric granularity must be line or word.');
  if (record.confirmedEdition !== true) throw invalid('Lyrics can be stored only after the edition is confirmed.');
  if (record.recognizesAudio !== false) throw invalid('Stored lyrics do not recognize the audio file.');
  if (typeof record.userModified !== 'boolean') throw invalid('Lyric modifications must be recorded explicitly.');
  const catalog = record.catalogDurationSeconds;
  if (catalog !== null && (!finite(catalog) || catalog <= 0 || catalog > ANALYSIS_HISTORY_MAX_TIMELINE_SECONDS)) {
    throw invalid('Catalog duration is not a measured length.');
  }
  const audioDurationSeconds = assertClock(record.audioDurationSeconds, 'Audio duration', 0.001);
  const sourceOffsetSeconds = assertClock(record.sourceOffsetSeconds, 'Source offset', -ANALYSIS_HISTORY_MAX_TIMELINE_SECONDS);
  const offsetSeconds = assertClock(record.offsetSeconds, 'Lyric offset', -ANALYSIS_HISTORY_MAX_TIMELINE_SECONDS);
  if (record.userModified !== (offsetSeconds !== sourceOffsetSeconds)) {
    throw invalid('A lyric offset change has to be recorded as a user modification.');
  }
  const rows = assertRows(record.rows);
  const textRows = rows.filter((row) => row.text.trim());
  const everyLineHasWords = textRows.every((row) => row.words && row.words.length > 0);
  if (record.granularity === 'word' && !everyLineHasWords) {
    throw invalid('Word granularity requires a measured timestamp on every lyric line.');
  }
  assertOffsetFits(rows, offsetSeconds, audioDurationSeconds);
  return {
    parentResultSha256: record.parentResultSha256,
    source: record.source,
    trackTitle: assertLabel(record.trackTitle, 'Track title'),
    artist: assertLabel(record.artist, 'Artist'),
    catalogDurationSeconds: catalog === null ? null : catalog,
    audioDurationSeconds,
    granularity: record.granularity,
    sourceOffsetSeconds,
    offsetSeconds,
    confirmedEdition: true,
    recognizesAudio: false,
    userModified: record.userModified,
    rows,
  };
}

export function validateLyricSidecarDraft(input: unknown): LyricSidecarDraft {
  rejectSecrets(input);
  const record = assertObject(input, 'Lyric sidecar');
  assertExactKeys(record, DRAFT_KEYS, 'Lyric sidecar');
  return normalizedDraft(record);
}

export function buildLyricSidecar(
  parentId: string,
  parentResultSha256: string,
  draft: LyricSidecarDraft,
  savedAt: string,
): LyricSidecar {
  if (!SHA256_HEX.test(parentResultSha256) || draft.parentResultSha256 !== parentResultSha256) {
    throw new AnalysisHistoryError('LYRIC_PARENT_MISMATCH', 'Lyric sidecar does not match this analysis result.');
  }
  return {
    schemaVersion: LYRIC_SIDECAR_SCHEMA_VERSION,
    parentId: assertRecordId(parentId),
    savedAt: assertTimestamp(savedAt),
    ...draft,
    parentResultSha256,
  };
}

export function parseLyricSidecar(input: unknown, parentId: string): LyricSidecar {
  rejectSecrets(input);
  const record = assertObject(input, 'Lyric sidecar');
  if (record.schemaVersion !== LYRIC_SIDECAR_SCHEMA_VERSION) {
    throw new AnalysisHistoryError('SCHEMA_UNSUPPORTED', 'Lyric sidecar schema version is not supported.');
  }
  assertExactKeys(record, STORED_KEYS, 'Lyric sidecar');
  const id = assertRecordId(parentId);
  if (record.parentId !== id) {
    throw new AnalysisHistoryError('LYRIC_PARENT_MISMATCH', 'Lyric sidecar does not match this analysis record.');
  }
  const draft = normalizedDraft(record);
  return {
    schemaVersion: LYRIC_SIDECAR_SCHEMA_VERSION,
    parentId: id,
    savedAt: assertTimestamp(record.savedAt),
    ...draft,
  };
}

export function serializeLyricSidecar(sidecar: LyricSidecar): string {
  return `${JSON.stringify(sidecar)}\n`;
}
