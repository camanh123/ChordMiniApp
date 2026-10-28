/**
 * Contract for a future offline transcription engine.
 *
 * This module does not transcribe audio, does not download a model, and does
 * not call LRCLIB. LRCLIB is a lyric catalog: it does not recognize words from
 * an uploaded file. A later phase may implement OfflineTranscriptionEngine with
 * an on-device model such as faster-whisper. That work needs a separate
 * approval before any weight download. The engine must run outside the chord
 * and beat request, on the audio the user already has, and must not upload it.
 *
 * Measured timestamps are required. Interpolating characters or words from a
 * line's start and end is not an implementation of this contract.
 */

export interface OfflineTranscriptionRequest {
  /** Local audio the user already has. The engine must not upload it. */
  audio: Blob;
  mimeType: string;
  durationSeconds: number;
  language?: string;
}

export interface MeasuredTimedText {
  text: string;
  startTime: number;
  endTime: number;
}

export interface OfflineTranscriptionLine extends MeasuredTimedText {
  /**
   * Present only when every word on the line was measured.
   * Absent word timestamps stay absent.
   */
  words?: MeasuredTimedText[];
}

export interface OfflineTranscriptionProvenance {
  engine: string;
  modelId: string;
  granularity: 'line' | 'word';
  timestamps: 'measured';
}

export interface OfflineTranscriptionSuccess {
  ok: true;
  lines: OfflineTranscriptionLine[];
  granularity: 'line' | 'word';
  provenance: OfflineTranscriptionProvenance;
}

export interface OfflineTranscriptionFailure {
  ok: false;
  reason: 'instrumental' | 'no-speech' | 'failed' | 'unavailable';
  lines: [];
}

export type OfflineTranscriptionResult = OfflineTranscriptionSuccess | OfflineTranscriptionFailure;

export interface OfflineTranscriptionEngine {
  transcribe(request: OfflineTranscriptionRequest): Promise<OfflineTranscriptionResult>;
}

function measuredSpan(span: MeasuredTimedText): boolean {
  return Number.isFinite(span.startTime)
    && Number.isFinite(span.endTime)
    && span.endTime >= span.startTime
    && span.text.trim().length > 0;
}

/**
 * Accept only a result that reports measured timestamps and does not invent
 * text for a failure or word times for a line that has none.
 */
export function acceptMeasuredTranscription(result: OfflineTranscriptionResult): boolean {
  if (!result.ok) return result.lines.length === 0;
  if (result.provenance.timestamps !== 'measured') return false;
  if (result.granularity !== result.provenance.granularity) return false;
  if (result.lines.length === 0) return false;
  if (result.lines.some((line) => !measuredSpan(line))) return false;
  if (result.granularity === 'line') {
    return result.lines.every((line) => !line.words || line.words.length === 0);
  }
  return result.lines.every((line) => Array.isArray(line.words)
    && line.words.length > 0
    && line.words.every((word) => measuredSpan(word)));
}
