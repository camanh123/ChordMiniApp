export const MAX_ANALYSIS_DURATION_MINUTES = 12;
export const MAX_ANALYSIS_DURATION_SECONDS = MAX_ANALYSIS_DURATION_MINUTES * 60;

export type DurationRejection = 'missing' | 'failed' | 'invalid' | 'exceeded';

export type DurationEligibility =
  | { eligible: true; seconds: number }
  | { eligible: false; reason: DurationRejection; seconds: number | null };

export interface DurationObservation {
  sourceId: string;
  seconds: number | null;
  failed: boolean;
}

export function parseAnalysisDurationSeconds(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function isAnalysisDurationExceeded(durationSeconds: number | null | undefined): boolean {
  return typeof durationSeconds === 'number'
    && Number.isFinite(durationSeconds)
    && durationSeconds > MAX_ANALYSIS_DURATION_SECONDS;
}

/**
 * Positive finite lengths at or under the cap are eligible.
 * Missing, failed, zero, and non-finite values are not eligible.
 */
export function durationEligibility(
  seconds: number | null | undefined,
  metadataFailed = false,
): DurationEligibility {
  if (metadataFailed) {
    return { eligible: false, reason: 'failed', seconds: null };
  }
  if (seconds === undefined || seconds === null) {
    return { eligible: false, reason: 'missing', seconds: null };
  }
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return { eligible: false, reason: 'invalid', seconds: null };
  }
  if (seconds > MAX_ANALYSIS_DURATION_SECONDS) {
    return { eligible: false, reason: 'exceeded', seconds };
  }
  return { eligible: true, seconds };
}

export function durationLimitMessage(decision: DurationEligibility): string | null {
  if (decision.eligible) return null;
  if (decision.reason === 'exceeded') {
    return `Analysis is limited to audio up to ${MAX_ANALYSIS_DURATION_MINUTES} minutes.`;
  }
  if (decision.reason === 'failed') {
    return 'Audio duration could not be read for this file.';
  }
  if (decision.reason === 'invalid') {
    return 'Audio duration for this file is not a positive length.';
  }
  return 'Audio duration for this source is not available yet.';
}

export class DurationGateError extends Error {
  readonly code = 'DURATION_GATE' as const;
  readonly reason: DurationRejection;

  constructor(decision: Extract<DurationEligibility, { eligible: false }>) {
    super(durationLimitMessage(decision) ?? 'Audio duration is not eligible.');
    this.name = 'DurationGateError';
    this.reason = decision.reason;
  }
}

export function isDurationGateError(error: unknown): error is DurationGateError {
  return error instanceof DurationGateError
    || (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'DURATION_GATE');
}

export function localFileSourceId(file: { name: string; size: number; lastModified: number }): string {
  return `file:${file.size}:${file.lastModified}:${file.name}`;
}

export function youtubeVideoSourceId(videoId: string): string {
  return `video:${videoId}`;
}

/**
 * A measurement authorizes only the source id it was taken for.
 * Another file, recording, or video id is treated as missing.
 */
export function durationGateDecision(
  observation: DurationObservation | null | undefined,
  activeSourceId: string,
): DurationEligibility {
  if (!observation || observation.sourceId !== activeSourceId) {
    return { eligible: false, reason: 'missing', seconds: null };
  }
  return durationEligibility(observation.seconds, observation.failed);
}

export async function observeLocalFileDuration(
  file: { name: string; size: number; lastModified: number },
  readSeconds: () => Promise<number>,
): Promise<DurationObservation> {
  const sourceId = localFileSourceId(file);
  try {
    const seconds = await readSeconds();
    return { sourceId, seconds, failed: false };
  } catch {
    return { sourceId, seconds: null, failed: true };
  }
}

export function getAnalysisDurationLimitReason(durationSeconds: number | null | undefined): string | null {
  if (!isAnalysisDurationExceeded(durationSeconds)) {
    return null;
  }
  return `Analysis is limited to audio up to ${MAX_ANALYSIS_DURATION_MINUTES} minutes.`;
}
