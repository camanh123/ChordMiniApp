/**
 * Desktop history list, restore, and relink.
 * This module talks only to /api/desktop/analysis-history.
 * It does not call beat, chord, or key inference.
 * A client content hash is compared locally and is not server-attested.
 */

import { hashBlobSha256 } from '@/services/audio/incrementalSha256';

export const HISTORY_COLLECTION_PATH = '/api/desktop/analysis-history';
export const HISTORY_PAGE_LIMIT = 50;
export const HISTORY_CARD_PAGE_SIZE = 12;
export const HISTORY_MAX_RECORDS = 200;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INFERENCE_PATH = /\/api\/(?:detect-beats|recognize-chords|detect-key)(?:\?|$)/;

export type HomeHistorySource = 'local' | 'firestore';

export function selectHomeHistorySource(runtime: 'web' | 'electron' | 'pwa'): HomeHistorySource {
  return runtime === 'electron' ? 'local' : 'firestore';
}

export interface HistoryCard {
  id: string;
  filename: string;
  analyzedAt: string;
  durationSeconds: number | null;
  beatModel: string;
  chordModel: string;
  bpm: number | null;
  keyName: string | null;
  meterLabel: string | null;
  chordPreview: string[];
}

export interface RestoredChord {
  chord: string;
  start: number;
  end: number;
  confidence: number | null;
}

export interface RestoredAnalysis {
  id: string;
  filename: string;
  analyzedAt: string;
  durationSeconds: number | null;
  beatModel: string;
  chordModel: string;
  bpm: number | null;
  keyName: string | null;
  meterLabel: string | null;
  contentSha256: string;
  chords: RestoredChord[];
  beats: Array<{ time: number }>;
  downbeats: number[] | null;
  synchronizedChords: Array<{ chord: string; beatIndex: number; beatNum?: number }> | null;
  resultSha256: string | null;
}

export type HistoryLoadResult =
  | { state: 'ready'; records: HistoryCard[]; isolatedCount: number }
  | { state: 'unavailable'; records: HistoryCard[] }
  | { state: 'error'; records: HistoryCard[] };

export type HistoryRecordResult =
  | { state: 'ready'; record: RestoredAnalysis }
  | { state: 'missing' }
  | { state: 'unsupported' }
  | { state: 'corrupt' }
  | { state: 'unavailable' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function filenameOf(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) return null;
  if (/[\u0000-\u001f\u007f:\\/]/.test(value)) return null;
  return value;
}

function modelProvenanceNumber(value: unknown, provenance: string): number | null {
  if (!isRecord(value) || value.provenance !== provenance) return null;
  if (typeof value.value !== 'number' || !Number.isFinite(value.value)) return null;
  return value.value;
}

function keyProvenance(value: unknown): string | null {
  if (!isRecord(value) || value.provenance !== 'key-service') return null;
  if (typeof value.value !== 'string' || value.value.length === 0 || value.value === 'Unknown') return null;
  return value.value;
}

function meterLabel(value: unknown): string | null {
  if (!isRecord(value) || value.provenance !== 'madmom-candidate-selection') return null;
  if (value.denominator !== 4 || (value.beatsPerBar !== 3 && value.beatsPerBar !== 4)) return null;
  return `${value.beatsPerBar}/4`;
}

function durationOf(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

export function cardFromSummary(value: unknown): HistoryCard | null {
  if (!isRecord(value) || value.schemaVersion !== 1) return null;
  if (typeof value.id !== 'string' || !UUID_V4.test(value.id)) return null;
  const source = isRecord(value.source) ? value.source : null;
  const filename = filenameOf(source?.displayName);
  const models = isRecord(value.models) ? value.models : null;
  if (!filename || typeof models?.beat !== 'string' || typeof models.chord !== 'string') return null;
  if (typeof value.analyzedAt !== 'string') return null;
  const preview = Array.isArray(value.chordPreview)
    ? value.chordPreview.filter((label): label is string => typeof label === 'string' && label.length > 0).slice(0, 8)
    : [];
  return {
    id: value.id,
    filename,
    analyzedAt: value.analyzedAt,
    durationSeconds: durationOf(value.audioDurationSeconds),
    beatModel: models.beat,
    chordModel: models.chord,
    bpm: modelProvenanceNumber(value.bpm, 'model'),
    keyName: keyProvenance(value.key),
    meterLabel: meterLabel(value.meter),
    chordPreview: preview,
  };
}

export function sortHistoryNewestFirst(records: readonly HistoryCard[]): HistoryCard[] {
  return [...records].sort((left, right) => {
    const byTime = Date.parse(right.analyzedAt) - Date.parse(left.analyzedAt);
    if (byTime !== 0 && Number.isFinite(byTime)) return byTime;
    return right.id < left.id ? -1 : right.id > left.id ? 1 : 0;
  });
}

export function filterHistoryByFilename(records: readonly HistoryCard[], query: string): HistoryCard[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...records];
  return records.filter((record) => record.filename.toLocaleLowerCase().includes(needle));
}

export function pageHistoryCards(
  records: readonly HistoryCard[],
  page: number,
  pageSize = HISTORY_CARD_PAGE_SIZE,
): { page: HistoryCard[]; pageIndex: number; pageCount: number; total: number } {
  const sorted = sortHistoryNewestFirst(records);
  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const pageIndex = Math.min(Math.max(0, page), pageCount - 1);
  const start = pageIndex * pageSize;
  return {
    page: sorted.slice(start, start + pageSize),
    pageIndex,
    pageCount,
    total: sorted.length,
  };
}

function finiteTime(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return value;
}

export function restoreHistoryRecord(payload: unknown): HistoryRecordResult {
  if (!isRecord(payload)) return { state: 'corrupt' };
  const record = isRecord(payload.record) ? payload.record : payload;
  if (record.schemaVersion !== 1) return { state: 'unsupported' };
  if (typeof record.id !== 'string' || !UUID_V4.test(record.id)) return { state: 'corrupt' };
  const source = isRecord(record.source) ? record.source : null;
  const filename = filenameOf(source?.displayName);
  const contentSha256 = typeof source?.contentSha256 === 'string' ? source.contentSha256 : '';
  const models = isRecord(record.models) ? record.models : null;
  if (!filename || !/^[0-9a-f]{64}$/.test(contentSha256)) return { state: 'corrupt' };
  if (typeof models?.beat !== 'string' || typeof models.chord !== 'string') return { state: 'corrupt' };
  if (typeof record.analyzedAt !== 'string' || !Array.isArray(record.chords) || !Array.isArray(record.beats)) {
    return { state: 'corrupt' };
  }
  if (record.beats.length === 0 || record.chords.length === 0) return { state: 'corrupt' };

  const chords: RestoredChord[] = [];
  for (const entry of record.chords) {
    if (!isRecord(entry) || typeof entry.chord !== 'string') return { state: 'corrupt' };
    const start = finiteTime(entry.start);
    const end = finiteTime(entry.end);
    if (start === null || end === null || start >= end) return { state: 'corrupt' };
    let confidence: number | null = null;
    if (isRecord(entry.confidence) && entry.confidence.provenance === 'model') {
      const value = entry.confidence.value;
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) confidence = value;
    }
    chords.push({ chord: entry.chord, start, end, confidence });
  }

  const beats: Array<{ time: number }> = [];
  for (const entry of record.beats) {
    if (!isRecord(entry)) return { state: 'corrupt' };
    const time = finiteTime(entry.time);
    if (time === null) return { state: 'corrupt' };
    beats.push({ time });
  }

  let downbeats: number[] | null = null;
  if (isRecord(record.downbeats) && record.downbeats.provenance === 'model' && Array.isArray(record.downbeats.times)) {
    const times: number[] = [];
    for (const time of record.downbeats.times) {
      const parsed = finiteTime(time);
      if (parsed === null) {
        times.length = 0;
        break;
      }
      times.push(parsed);
    }
    downbeats = times.length > 0 ? times : null;
  }

  let synchronizedChords: RestoredAnalysis['synchronizedChords'] = null;
  if (Array.isArray(record.synchronizedChords)) {
    const synced: NonNullable<RestoredAnalysis['synchronizedChords']> = [];
    let valid = true;
    for (const entry of record.synchronizedChords) {
      if (!isRecord(entry) || typeof entry.chord !== 'string') {
        valid = false;
        break;
      }
      if (typeof entry.beatIndex !== 'number' || !Number.isInteger(entry.beatIndex) || entry.beatIndex < 0 || entry.beatIndex >= beats.length) {
        valid = false;
        break;
      }
      const item: { chord: string; beatIndex: number; beatNum?: number } = {
        chord: entry.chord,
        beatIndex: entry.beatIndex,
      };
      if (entry.beatNum !== undefined) {
        if (typeof entry.beatNum !== 'number' || !Number.isInteger(entry.beatNum)) {
          valid = false;
          break;
        }
        item.beatNum = entry.beatNum;
      }
      synced.push(item);
    }
    synchronizedChords = valid && synced.length > 0 ? synced : null;
  }

  return {
    state: 'ready',
    record: {
      id: record.id,
      filename,
      analyzedAt: record.analyzedAt,
      durationSeconds: durationOf(record.audioDurationSeconds),
      beatModel: models.beat,
      chordModel: models.chord,
      bpm: modelProvenanceNumber(record.bpm, 'model'),
      keyName: keyProvenance(record.key),
      meterLabel: meterLabel(record.meter),
      contentSha256,
      chords,
      beats,
      downbeats,
      synchronizedChords,
      resultSha256: typeof record.resultSha256 === 'string' && /^[0-9a-f]{64}$/.test(record.resultSha256)
        ? record.resultSha256
        : null,
    },
  };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function loadDesktopHistory(
  fetchImpl: typeof fetch = fetch,
): Promise<HistoryLoadResult> {
  const records: HistoryCard[] = [];
  let cursor: string | null = null;
  let isolatedCount = 0;
  let page = 0;
  try {
    do {
      const params = new URLSearchParams({ limit: String(HISTORY_PAGE_LIMIT) });
      if (cursor) params.set('cursor', cursor);
      const response = await fetchImpl(`${HISTORY_COLLECTION_PATH}?${params.toString()}`, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      });
      if (response.status === 503 || response.status === 404) {
        return records.length > 0
          ? { state: 'error', records }
          : { state: 'unavailable', records: [] };
      }
      if (!response.ok) {
        return { state: 'error', records };
      }
      const body = await readJson(response);
      if (!isRecord(body) || !Array.isArray(body.records)) {
        return { state: 'error', records };
      }
      if (typeof body.isolatedCount === 'number') isolatedCount = body.isolatedCount;
      for (const entry of body.records) {
        const card = cardFromSummary(entry);
        if (card) records.push(card);
        if (records.length >= HISTORY_MAX_RECORDS) break;
      }
      cursor = typeof body.nextCursor === 'string' && UUID_V4.test(body.nextCursor) ? body.nextCursor : null;
      page += 1;
    } while (cursor && records.length < HISTORY_MAX_RECORDS && page < 8);
  } catch {
    return records.length > 0 ? { state: 'error', records } : { state: 'unavailable', records: [] };
  }
  return { state: 'ready', records: sortHistoryNewestFirst(records), isolatedCount };
}

export async function fetchHistoryRecord(
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HistoryRecordResult> {
  if (!UUID_V4.test(id)) return { state: 'missing' };
  let response: Response;
  try {
    response = await fetchImpl(`${HISTORY_COLLECTION_PATH}/${id}`, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
  } catch {
    return { state: 'unavailable' };
  }
  if (response.status === 404) return { state: 'missing' };
  if (response.status === 503) return { state: 'unavailable' };
  const body = await readJson(response);
  const code = isRecord(body) && typeof body.code === 'string' ? body.code : '';
  if (response.status === 400 && code === 'SCHEMA_UNSUPPORTED') return { state: 'unsupported' };
  if (response.status === 422 || code === 'RECORD_CORRUPT') return { state: 'corrupt' };
  if (!response.ok) return { state: 'unavailable' };
  const restored = restoreHistoryRecord(body);
  return restored.state === 'ready' ? restored : { state: restored.state };
}

export async function deleteHistoryRecord(
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<'deleted' | 'failed'> {
  if (!UUID_V4.test(id)) return 'failed';
  try {
    const response = await fetchImpl(`${HISTORY_COLLECTION_PATH}/${id}`, {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ recordId: id, confirmDelete: true }),
    });
    return response.ok ? 'deleted' : 'failed';
  } catch {
    return 'failed';
  }
}

export async function relinkHistoryAudio(
  file: Blob,
  expectedSha256: string,
): Promise<{ ok: true; digest: string } | { ok: false; reason: 'mismatch' | 'unreadable' }> {
  let digest = '';
  try {
    digest = (await hashBlobSha256(file)).digest;
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  if (digest !== expectedSha256.toLowerCase()) return { ok: false, reason: 'mismatch' };
  return { ok: true, digest };
}

export function isInferenceRequest(url: string): boolean {
  return INFERENCE_PATH.test(url);
}
