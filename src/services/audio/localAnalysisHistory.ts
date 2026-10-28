/**
 * Desktop-only persistence for one completed local analysis.
 * The renderer posts to the existing history API. It does not write files.
 * source.contentSha256 is computed here from the selected Blob. The server
 * does not see the audio, so the hash is not server-attested provenance.
 *
 * A POST that has already been dispatched cannot be cancelled. Callers check
 * the session token immediately before dispatch so a stale song is not saved.
 */

import type { AnalysisResult } from '@/types/audioAnalysis';
import type { KeyDetectionResult } from '@/services/audio/keyDetectionService';
import { readModelConfidence } from '@/services/audio/analysisHistoryFacts';
import { hashBlobSha256 } from '@/services/audio/incrementalSha256';

const HISTORY_URL = '/api/desktop/analysis-history';
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface HistoryKeyFact {
  value: string;
  provenance: 'key-service';
}

export type HistorySaveOutcome =
  | { state: 'saved'; id: string; created: boolean; visible: boolean; resultSha256: string | null }
  | { state: 'skipped'; reason: 'not-desktop' | 'incomplete' | 'stale' | 'cleared' | 'unmounted'; visible: false }
  | { state: 'failed'; reason: 'hash' | 'invalid' | 'storage' | 'network'; visible: boolean };

export interface HistorySaveRequest {
  token: number;
  file: Blob & { name?: string };
  isCurrent: (token: number) => boolean;
  isMounted: () => boolean;
  activeFile: () => (Blob & { name?: string }) | null;
  result: AnalysisResult;
  keyObservation: Promise<HistoryKeyFact | null>;
  runtime: 'web' | 'electron' | 'pwa';
  analyzedAt: string;
  fetchImpl?: typeof fetch;
  hashImpl?: typeof hashBlobSha256;
}

export function keyFactFromDetection(result: KeyDetectionResult | null | undefined): HistoryKeyFact | null {
  if (!result || result.fromHeuristicFallback) return null;
  const value = result.primaryKey?.trim();
  if (!value || value === 'Unknown' || value.length > 64) return null;
  if (/[\u0000-\u001f\u007f:\\/]/.test(value)) return null;
  return { value, provenance: 'key-service' };
}

export function createHistoryKeyGate() {
  let generation = 0;
  let settleCurrent: (value: HistoryKeyFact | null) => void = () => {};

  const release = (value: HistoryKeyFact | null) => {
    const settle = settleCurrent;
    settleCurrent = () => {};
    settle(value);
  };

  return {
    arm(token: number): Promise<HistoryKeyFact | null> {
      release(null);
      generation = token;
      let settled = false;
      return new Promise((resolve) => {
        settleCurrent = (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
      });
    },
    abandon() {
      release(null);
    },
    provide(token: number, value: HistoryKeyFact | null) {
      if (token !== generation) return;
      release(value);
    },
  };
}

function modelId(value: string | null | undefined): string | null {
  return typeof value === 'string' && MODEL_ID.test(value) ? value : null;
}

function displayNameOf(file: Blob & { name?: string }): string | null {
  const raw = typeof file.name === 'string' ? file.name : '';
  const base = raw.split(/[\\/]/).pop() ?? '';
  if (!base || base === '.' || base === '..' || base !== base.trim() || base.length > 180) return null;
  if (/[\u0000-\u001f\u007f:\\/]/.test(base)) return null;
  return base;
}

function finiteTime(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 3600) return null;
  return value;
}

function sessionStillOwns(
  request: HistorySaveRequest,
): 'current' | 'unmounted' | 'cleared' | 'stale' {
  if (!request.isMounted()) return 'unmounted';
  if (!request.isCurrent(request.token)) return 'stale';
  const active = request.activeFile();
  if (!active) return 'cleared';
  if (active !== request.file) return 'stale';
  return 'current';
}

export function buildLocalHistoryDraft(input: {
  file: Blob & { name?: string };
  contentSha256: string;
  result: AnalysisResult;
  analyzedAt: string;
  key: HistoryKeyFact | null;
}): Record<string, unknown> | null {
  const facts = input.result.desktopHistory;
  if (!facts) return null;
  if (!SHA256_HEX.test(input.contentSha256)) return null;
  const displayName = displayNameOf(input.file);
  if (!displayName) return null;
  if (!Number.isInteger(input.file.size) || input.file.size < 0 || input.file.size > 100 * 1024 * 1024) return null;

  const reported = modelId(facts.beatReported);
  const requested = modelId(facts.requestedBeat);
  const beat = reported ?? (requested && requested !== 'auto' ? requested : null);
  const chord = modelId(facts.chordModel) ?? modelId(input.result.chordModel);
  if (!beat || !chord) return null;

  if (!Array.isArray(input.result.beats) || input.result.beats.length === 0) return null;
  const beats: Array<{ time: number }> = [];
  let previousBeat = -1;
  for (const beatInfo of input.result.beats) {
    const time = finiteTime(beatInfo?.time);
    if (time === null || time <= previousBeat) return null;
    previousBeat = time;
    beats.push({ time });
  }

  if (!Array.isArray(input.result.chords) || input.result.chords.length === 0) return null;
  const chords: Array<Record<string, unknown>> = [];
  let previousStart = -1;
  for (const chord of input.result.chords) {
    const start = finiteTime(chord?.start);
    const end = finiteTime(chord?.end);
    if (start === null || end === null || start >= end || start <= previousStart) return null;
    if (typeof chord.chord !== 'string' || chord.chord.length === 0 || chord.chord.length > 64) return null;
    previousStart = start;
    const stored: Record<string, unknown> = { chord: chord.chord, start, end };
    const confidence = readModelConfidence(chord);
    if (confidence !== undefined) {
      stored.confidence = { value: confidence, provenance: 'model' };
    }
    chords.push(stored);
  }

  let downbeats: { times: number[]; provenance: 'model' } | null = null;
  if (facts.downbeats && facts.downbeats.length > 0) {
    const times: number[] = [];
    let previous = -1;
    let valid = true;
    for (const time of facts.downbeats) {
      const parsed = finiteTime(time);
      if (parsed === null || parsed <= previous) {
        valid = false;
        break;
      }
      previous = parsed;
      times.push(parsed);
    }
    if (valid) downbeats = { times, provenance: 'model' };
  }

  let synchronizedChords: Array<Record<string, unknown>> | null = null;
  if (Array.isArray(input.result.synchronizedChords) && input.result.synchronizedChords.length > 0) {
    const synced: Array<Record<string, unknown>> = [];
    let previousIndex = -1;
    let valid = true;
    for (const entry of input.result.synchronizedChords) {
      if (!entry || typeof entry.chord !== 'string' || entry.chord.length === 0 || entry.chord.length > 64) {
        valid = false;
        break;
      }
      if (!Number.isInteger(entry.beatIndex) || entry.beatIndex < 0 || entry.beatIndex >= beats.length || entry.beatIndex < previousIndex) {
        valid = false;
        break;
      }
      previousIndex = entry.beatIndex;
      const stored: Record<string, unknown> = { chord: entry.chord, beatIndex: entry.beatIndex };
      if (entry.beatNum !== undefined) {
        if (!Number.isInteger(entry.beatNum) || entry.beatNum < 1 || entry.beatNum > 32) {
          valid = false;
          break;
        }
        stored.beatNum = entry.beatNum;
      }
      synced.push(stored);
    }
    if (valid) synchronizedChords = synced;
  }

  const duration = finiteTime(input.result.audioDuration);
  const audioDurationSeconds = duration !== null && duration > 0 ? duration : null;

  return {
    schemaVersion: 1,
    source: {
      kind: 'local-audio',
      displayName,
      sizeBytes: input.file.size,
      contentSha256: input.contentSha256,
    },
    analyzedAt: input.analyzedAt,
    audioDurationSeconds,
    models: {
      beat,
      chord,
      beatReported: reported,
    },
    chords,
    beats,
    downbeats,
    synchronizedChords,
    meter: facts.meter
      ? {
        beatsPerBar: facts.meter.beatsPerBar,
        denominator: 4,
        provenance: 'madmom-candidate-selection',
      }
      : null,
    bpm: facts.modelBpm === null ? null : { value: facts.modelBpm, provenance: 'model' },
    key: input.key,
    status: 'complete',
    provenance: { pipeline: 'local-upload-v1' },
  };
}

export async function saveCompletedLocalAnalysis(request: HistorySaveRequest): Promise<HistorySaveOutcome> {
  if (request.runtime !== 'electron') {
    return { state: 'skipped', reason: 'not-desktop', visible: false };
  }
  const before = sessionStillOwns(request);
  if (before !== 'current') {
    return { state: 'skipped', reason: before, visible: false };
  }
  const facts = request.result.desktopHistory;
  if (!facts || request.result.beats.length === 0 || request.result.chords.length === 0) {
    return { state: 'skipped', reason: 'incomplete', visible: false };
  }

  const hashImpl = request.hashImpl ?? hashBlobSha256;
  let digest = '';
  let key: HistoryKeyFact | null = null;
  try {
    const [hashed, observedKey] = await Promise.all([
      hashImpl(request.file),
      request.keyObservation,
    ]);
    digest = hashed.digest;
    key = observedKey;
  } catch {
    const owner = sessionStillOwns(request);
    return {
      state: 'failed',
      reason: 'hash',
      visible: owner === 'current',
    };
  }

  const afterHash = sessionStillOwns(request);
  if (afterHash !== 'current') {
    return { state: 'skipped', reason: afterHash, visible: false };
  }

  const draft = buildLocalHistoryDraft({
    file: request.file,
    contentSha256: digest,
    result: request.result,
    analyzedAt: request.analyzedAt,
    key,
  });
  if (!draft) {
    return { state: 'failed', reason: 'invalid', visible: true };
  }

  const beforeDispatch = sessionStillOwns(request);
  if (beforeDispatch !== 'current') {
    return { state: 'skipped', reason: beforeDispatch, visible: false };
  }

  const fetchImpl = request.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(HISTORY_URL, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(draft),
    });
  } catch {
    const owner = sessionStillOwns(request);
    return { state: 'failed', reason: 'network', visible: owner === 'current' };
  }

  const visible = sessionStillOwns(request) === 'current';
  if (!response.ok) {
    return { state: 'failed', reason: 'storage', visible };
  }
  let body: { id?: unknown; created?: unknown; record?: { resultSha256?: unknown } } = {};
  try {
    body = await response.json() as { id?: unknown; created?: unknown; record?: { resultSha256?: unknown } };
  } catch {
    return { state: 'failed', reason: 'storage', visible };
  }
  if (typeof body.id !== 'string' || body.id.length === 0) {
    return { state: 'failed', reason: 'storage', visible };
  }
  const resultSha256 = typeof body.record?.resultSha256 === 'string' && SHA256_HEX.test(body.record.resultSha256)
    ? body.record.resultSha256
    : null;
  return {
    state: 'saved',
    id: body.id,
    created: body.created === true,
    visible,
    resultSha256,
  };
}
