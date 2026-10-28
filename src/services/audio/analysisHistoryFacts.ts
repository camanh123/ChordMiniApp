/**
 * Provenance captured beside the UI result.
 * The beat and chord services still fill BPM 120, meter 4, and confidence 0.8
 * for display. Those defaults are not stored here.
 */

import type { ChordDetectionResult } from '@/types/audioAnalysis';

export interface BeatMeasurement {
  requestedDetector: string;
  reportedModel: string | null;
  modelBpm: number | null;
  modelDownbeats: number[] | null;
}

export interface SelectedMeter {
  beatsPerBar: 3 | 4;
  provenance: 'madmom-candidate-selection';
  downbeats: number[];
}

export interface DesktopHistoryFacts {
  requestedBeat: string;
  beatReported: string | null;
  chordModel: string | null;
  modelBpm: number | null;
  meter: SelectedMeter | null;
  downbeats: number[] | null;
}

const beatMeasurements = new WeakMap<object, BeatMeasurement>();
const selectedMeters = new WeakMap<object, SelectedMeter>();
const chordModels = new WeakMap<object, string>();
const chordConfidence = new WeakMap<object, number>();

function finiteModelBpm(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 400) return null;
  return value;
}

/** BPM copied from a detector payload. A missing value stays missing. */
export function publishedDetectorBpm(...values: unknown[]): number | undefined {
  for (const value of values) {
    const bpm = finiteModelBpm(value);
    if (bpm !== null) return bpm;
  }
  return undefined;
}

function finiteTimeline(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const times: number[] = [];
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0 || entry > 3600) return null;
    times.push(entry);
  }
  return times;
}

export function rememberBeatMeasurement(target: object, raw: {
  requestedDetector: string;
  reportedModel: unknown;
  bpm: unknown;
  upperCaseBpm: unknown;
  downbeats: unknown;
}): void {
  beatMeasurements.set(target, {
    requestedDetector: raw.requestedDetector,
    reportedModel: typeof raw.reportedModel === 'string' && raw.reportedModel.trim()
      ? raw.reportedModel.trim()
      : null,
    modelBpm: finiteModelBpm(raw.upperCaseBpm) ?? finiteModelBpm(raw.bpm),
    modelDownbeats: finiteTimeline(raw.downbeats),
  });
}

export function rememberSelectedMeter(target: object, beatsPerBar: unknown, downbeats: unknown): void {
  if (beatsPerBar !== 3 && beatsPerBar !== 4) return;
  const times = finiteTimeline(downbeats) ?? [];
  selectedMeters.set(target, {
    beatsPerBar,
    provenance: 'madmom-candidate-selection',
    downbeats: times,
  });
}

export function rememberChordRun(chords: object, model: string): void {
  chordModels.set(chords, model);
}

export function readChordRun(chords: object): string | null {
  return chordModels.get(chords) ?? null;
}

export function rememberModelConfidence(chord: object, confidence: unknown): void {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return;
  chordConfidence.set(chord, confidence);
}

export function readModelConfidence(chord: object): number | undefined {
  return chordConfidence.get(chord);
}

export function collectDesktopHistory(
  beatResults: object,
  chordResults: readonly ChordDetectionResult[],
): DesktopHistoryFacts | undefined {
  const measured = beatMeasurements.get(beatResults);
  if (!measured) return undefined;
  const meter = selectedMeters.get(beatResults) ?? null;
  const downbeats = meter
    ? (meter.downbeats.length > 0 ? meter.downbeats : null)
    : measured.modelDownbeats;
  return {
    requestedBeat: measured.requestedDetector,
    beatReported: measured.reportedModel,
    chordModel: readChordRun(chordResults),
    modelBpm: measured.modelBpm,
    meter,
    downbeats: downbeats && downbeats.length > 0 ? downbeats : null,
  };
}
