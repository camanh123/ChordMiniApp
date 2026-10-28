/**
 * Decisions for playing a YouTube video beside an authorized audio file.
 * YouTube metadata and cached annotations are never labeled as a new inference.
 * BPM, key, and meter are shown only when a measured value exists.
 */

import type { AnalysisResult } from '@/types/audioAnalysis';
import type { YouTubePlayer } from '@/types/youtube';
import { suggestCapoPosition } from '@/utils/guitarVoicing';
import {
  DIRECT_UPLOAD_MAX_BYTES,
  directUploadExtensionAccepted,
  directUploadSizeAccepted,
} from '@/services/audio/directUploadPolicy';

export const DURATION_ALIGN_TOLERANCE_SECONDS = 5;
export const AUTHORIZED_AUDIO_MAX_BYTES = DIRECT_UPLOAD_MAX_BYTES;

export type DurationAlignment = 'unknown' | 'aligned' | 'mismatch';

export interface DurationComparison {
  status: DurationAlignment;
  deltaSeconds: number | null;
}

export interface AuthorizedFileInput {
  name: string;
  sizeBytes: number;
}

export interface MusicFact<T> {
  value: T;
  provenance: 'model' | 'cached-annotation' | 'key-service' | 'guitar-accompaniment-suggestion';
  detectedInRecording?: false;
}

export interface LinkedMusicFacts {
  provenance: 'cached-annotation' | 'authorized-file';
  chordCount: number;
  bpm: MusicFact<number> | null;
  key: MusicFact<string> | null;
  meter: MusicFact<string> | null;
  capo: MusicFact<number> | null;
}

export function youtubeAudioExtractionAllowed(runtime: 'web' | 'electron' | 'pwa'): boolean {
  return runtime !== 'electron';
}

export function canRunAuthorizedAnalysis(file: AuthorizedFileInput | null): boolean {
  if (!file) return false;
  return directUploadSizeAccepted(file.sizeBytes) && directUploadExtensionAccepted(file.name);
}

export function compareMediaDurations(
  videoSeconds: number | null,
  audioSeconds: number | null,
): DurationComparison {
  if (
    videoSeconds === null
    || audioSeconds === null
    || !Number.isFinite(videoSeconds)
    || !Number.isFinite(audioSeconds)
    || videoSeconds <= 0
    || audioSeconds <= 0
  ) {
    return { status: 'unknown', deltaSeconds: null };
  }
  const deltaSeconds = audioSeconds - videoSeconds;
  if (Math.abs(deltaSeconds) > DURATION_ALIGN_TOLERANCE_SECONDS) {
    return { status: 'mismatch', deltaSeconds };
  }
  return { status: 'aligned', deltaSeconds };
}

/**
 * Sync waits for a measured duration and for the user to confirm that the
 * file is the arrangement they want to follow. A close duration does not by
 * itself prove the mix.
 */
export function canSynchronize(input: {
  alignment: DurationAlignment;
  userConfirmedSameArrangement: boolean;
}): boolean {
  if (!input.userConfirmedSameArrangement) return false;
  return input.alignment === 'aligned' || input.alignment === 'mismatch';
}

export function audioTimeForVideo(videoTimeSeconds: number, offsetSeconds: number): number {
  if (!Number.isFinite(videoTimeSeconds)) return Number.NaN;
  if (!Number.isFinite(offsetSeconds)) return videoTimeSeconds;
  return videoTimeSeconds + offsetSeconds;
}

export function chordAtAudioTime<T extends { chord: string; start: number; end: number }>(
  chords: readonly T[],
  audioTimeSeconds: number,
): T | null {
  if (!Number.isFinite(audioTimeSeconds)) return null;
  return chords.find((chord) => audioTimeSeconds >= chord.start && audioTimeSeconds < chord.end) ?? null;
}

export function highlightChord<T extends { chord: string; start: number; end: number }>(input: {
  chords: readonly T[];
  videoTimeSeconds: number;
  offsetSeconds: number;
  syncAllowed: boolean;
  videoId: string;
  resultVideoId: string;
}): T | null {
  if (!input.syncAllowed || input.videoId !== input.resultVideoId) return null;
  return chordAtAudioTime(input.chords, audioTimeForVideo(input.videoTimeSeconds, input.offsetSeconds));
}

export function shiftAnalysisToVideoTimeline(result: AnalysisResult, offsetSeconds: number): AnalysisResult {
  if (!Number.isFinite(offsetSeconds) || offsetSeconds === 0) return result;
  const shift = (time: number) => time - offsetSeconds;
  return {
    ...result,
    chords: result.chords.map((chord) => ({
      ...chord,
      start: shift(chord.start),
      end: shift(chord.end),
      time: shift(chord.time),
    })),
    beats: result.beats.map((beat) => ({ ...beat, time: shift(beat.time) })),
    downbeats: result.downbeats?.map(shift),
    downbeats_with_measures: result.downbeats_with_measures?.map((item) => ({
      ...item,
      time: shift(item.time),
    })),
    beats_with_positions: result.beats_with_positions?.map((beat) => ({
      ...beat,
      time: shift(beat.time),
    })),
  };
}

export function readPlayerDuration(player: YouTubePlayer | null): number | null {
  const reader = player as (YouTubePlayer & { getDuration?: () => number }) | null;
  if (!reader || typeof reader.getDuration !== 'function') return null;
  try {
    const value = reader.getDuration();
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
    return value;
  } catch {
    return null;
  }
}

function finiteBpm(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 400) return null;
  return value;
}

function finiteMeter(value: unknown): number | null {
  if (typeof value === 'string' && value.includes('/')) {
    return finiteMeter(Number(value.split('/')[0]));
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 2 || value > 12) return null;
  return value;
}

export function guitarAccompanimentCapo(chordNames: readonly string[]): number | null {
  const names = chordNames.map((name) => name.trim()).filter((name) => name.length > 0);
  if (names.length === 0) return null;
  try {
    const suggestion = suggestCapoPosition(names);
    if (!suggestion || !Number.isInteger(suggestion.capoFret) || suggestion.capoFret < 0 || suggestion.capoFret > 12) {
      return null;
    }
    return suggestion.capoFret;
  } catch {
    return null;
  }
}

export function presentLinkedMusicFacts(input: {
  provenance: 'cached-annotation' | 'authorized-file';
  chordCount: number;
  modelBpm: number | null;
  cachedBpm: number | null;
  displayBpm: number | null;
  modelMeter: 3 | 4 | null;
  cachedMeter: number | null;
  key: string | null;
  keyFromHeuristic: boolean;
  capoFret: number | null;
}): LinkedMusicFacts {
  const bpm = input.provenance === 'authorized-file'
    ? finiteBpm(input.modelBpm)
    : finiteBpm(input.cachedBpm);
  const meter = input.provenance === 'authorized-file'
    ? input.modelMeter
    : finiteMeter(input.cachedMeter);
  const key = !input.keyFromHeuristic && input.key && input.key.trim() && input.key.trim() !== 'Unknown'
    ? input.key.trim()
    : null;
  void input.displayBpm;

  return {
    provenance: input.provenance,
    chordCount: input.chordCount,
    bpm: bpm === null ? null : {
      value: bpm,
      provenance: input.provenance === 'authorized-file' ? 'model' : 'cached-annotation',
    },
    key: key === null ? null : { value: key, provenance: 'key-service' },
    meter: meter === null ? null : {
      value: `${meter}/4`,
      provenance: input.provenance === 'authorized-file' ? 'model' : 'cached-annotation',
    },
    capo: input.capoFret === null ? null : {
      value: input.capoFret,
      provenance: 'guitar-accompaniment-suggestion',
      detectedInRecording: false,
    },
  };
}

export function authorizedFileHistorySource(file: {
  displayName: string;
  sizeBytes: number;
  contentSha256: string;
}): { kind: 'local-audio'; displayName: string; sizeBytes: number; contentSha256: string } {
  return {
    kind: 'local-audio',
    displayName: file.displayName,
    sizeBytes: file.sizeBytes,
    contentSha256: file.contentSha256,
  };
}

export function linkedResultApplies(current: { videoId: string; token: number }, result: { videoId: string; token: number }): boolean {
  return current.videoId === result.videoId && current.token === result.token;
}
