/**
 * Offline multilingual ASR adapter.
 *
 * This module validates and normalizes a recognizer payload that already
 * exists. It does not load a model, spawn a process, translate, romanize, or
 * upload audio. Timestamps that survive validation are model estimates, not
 * ground truth.
 *
 * Timestamp policy:
 * - A lyric event is kept only when start and end are finite, end is strictly
 *   after start, start is at least -0.001 seconds, start is before the audio
 *   duration, and end is at most 0.001 seconds past that duration.
 * - Events are not clamped, sorted, or split. An event that starts before the
 *   previous kept event ends (more than 0.001 seconds of overlap), or that
 *   starts before that event's start, is rejected. The earlier event's end is
 *   left unchanged.
 * - Word timestamps are kept only when every word on that line is individually
 *   finite, ordered, non-overlapping, and inside the line. One bad word drops
 *   the whole word list. Missing words stay missing. Syllable arrays are
 *   ignored. The adapter never builds equally spaced words.
 * - If any kept line has no complete word list, the result is line granularity
 *   and every word list is omitted. Partial word timing is not published as
 *   word granularity.
 *
 * Quality policy:
 * - Malformed envelopes, non-finite times, a span that does not move forward,
 *   times outside the audio, and overlaps are structural failures. Those
 *   events are rejected and their timestamps are not rewritten.
 * - A repeated line, a high character rate, a low segment score, or lyric
 *   text on an instrumental or silence flag is a review warning. The text and
 *   its measured times stay in the result. Nothing is substituted for them.
 * - A spaced chorus is ordinary singing and does not receive a repeat warning.
 * - Empty instrumental or silence output stays empty. No lyric is invented.
 * - A voice-activity flag is recorded and never treated as proof of vocals.
 * - Segment confidence is kept only when the model provided a finite value
 *   in [0, 1]. A missing score is null and does not remove the line.
 * - When every structurally valid lyric event is gone, the result is a
 *   failure with an empty line list.
 */

import {
  alignLyricsToChords,
  type AlignmentIssue,
  type AlignedLine,
  type InstrumentalGap,
  type LyricGranularity,
  type TimestampRow,
} from '@/services/lyrics/lyricChordAlignment';
import {
  acceptMeasuredTranscription,
  type MeasuredTimedText,
  type OfflineTranscriptionLine,
  type OfflineTranscriptionResult,
  type OfflineTranscriptionSuccess,
} from '@/services/lyrics/offlineTranscriptionContract';

export const ASR_TIME_EPSILON_SECONDS = 0.001;
export const ASR_MAX_CHARACTERS_PER_SECOND = 40;
export const ASR_LOW_CONFIDENCE_THRESHOLD = 0.4;
export const ASR_REPEATED_PHRASE_MIN_RUN = 3;
export const ASR_REPEATED_PHRASE_MAX_GAP_SECONDS = 0.05;
export const ASR_EXTREME_REPEAT_RUN = 8;
/** Same timeline cap as analysis history. This module does not import the store. */
export const ASR_MAX_AUDIO_DURATION_SECONDS = 3600;

export const ASR_LANGUAGE_CODES = [
  'vi',
  'en',
  'zh',
  'ja',
  'ko',
  'auto',
  'mixed',
  'uncertain',
] as const;

export type AsrLanguageCode = (typeof ASR_LANGUAGE_CODES)[number];

export interface AsrLanguageMetadata {
  /** Normalized model value. Missing or unknown input becomes uncertain. */
  declared: AsrLanguageCode;
  code: AsrLanguageCode;
  /** Null when the model did not provide a finite confidence in [0, 1]. */
  confidence: number | null;
  translated: false;
  romanized: false;
}

export interface AsrRawOutput {
  engine: unknown;
  modelId: unknown;
  audioDurationSeconds: unknown;
  fileKey: unknown;
  sessionToken: unknown;
  language?: unknown;
  languageConfidence?: unknown;
  segments?: unknown;
  vadReportedSpeech?: unknown;
  instrumental?: unknown;
  silence?: unknown;
}

export type AsrAdapterIssue =
  | 'malformed'
  | 'empty'
  | 'instrumental'
  | 'silence'
  | 'invalid-timing'
  | 'overlap'
  | 'out-of-duration';

/** Review hints. They do not delete a structurally valid lyric line. */
export type AsrQualityWarning =
  | 'low-confidence'
  | 'repeated-phrase'
  | 'high-text-density'
  | 'instrumental-hallucination-candidate';

export type AsrAdapterNote =
  | AsrAdapterIssue
  | AsrQualityWarning
  | 'missing-word-timestamps'
  | 'partial-word-timestamps-dropped'
  | 'invalid-word-timestamps'
  | 'ignored-syllable-timestamps'
  | 'mixed-language-segments';

export interface AsrSegmentReview {
  text: string;
  startTime: number;
  endTime: number;
  /** Transcription score. Null when the model did not provide one in [0, 1]. */
  confidence: number | null;
  language: AsrLanguageMetadata;
  warnings: AsrQualityWarning[];
}

export interface AsrVadObservation {
  reportedSpeech: boolean | null;
  provesVocals: false;
}

export interface AsrAdapterSuccess {
  ok: true;
  fileKey: string;
  sessionToken: number;
  audioDurationSeconds: number;
  transcription: OfflineTranscriptionSuccess;
  language: AsrLanguageMetadata;
  segmentLanguages: AsrLanguageMetadata[];
  timestampsAreEstimates: true;
  notes: AsrAdapterNote[];
  reviews: AsrSegmentReview[];
  vad: AsrVadObservation;
}

export interface AsrAdapterRejection {
  ok: false;
  fileKey: string;
  sessionToken: number;
  audioDurationSeconds: number | null;
  issue: AsrAdapterIssue;
  transcription: Extract<OfflineTranscriptionResult, { ok: false }>;
  timestampsAreEstimates: true;
  notes: AsrAdapterNote[];
  vad: AsrVadObservation;
}

export type AsrAdapterResult = AsrAdapterSuccess | AsrAdapterRejection;

export interface AsrChordPreview {
  ok: true;
  lines: AlignedLine[];
  gaps: InstrumentalGap[];
  granularity: LyricGranularity;
  provenance: {
    kind: 'asr-preview';
    persisted: false;
    sidecarSchema: null;
    recognizesAudio: true;
    timestampsAreEstimates: true;
    engine: string;
    modelId: string;
    language: AsrLanguageMetadata;
    audioDurationSeconds: number;
    fileKey: string;
    sessionToken: number;
  };
}

const LANGUAGE_ALIASES: Record<string, AsrLanguageCode> = {
  vi: 'vi',
  vie: 'vi',
  vietnamese: 'vi',
  en: 'en',
  eng: 'en',
  english: 'en',
  zh: 'zh',
  zho: 'zh',
  chi: 'zh',
  cmn: 'zh',
  chinese: 'zh',
  ja: 'ja',
  jpn: 'ja',
  japanese: 'ja',
  ko: 'ko',
  kor: 'ko',
  korean: 'ko',
  auto: 'auto',
  detect: 'auto',
  automatic: 'auto',
  mixed: 'mixed',
  multilingual: 'mixed',
  uncertain: 'uncertain',
  unknown: 'uncertain',
  und: 'uncertain',
};

const SPECIFIC_LANGUAGES = new Set<AsrLanguageCode>(['vi', 'en', 'zh', 'ja', 'ko']);

interface ParsedSegment {
  text: string;
  startTime: number;
  endTime: number;
  language: AsrLanguageMetadata;
  confidence: number | null;
  warnings: AsrQualityWarning[];
  words: MeasuredTimedText[] | null;
  wordNote: AsrAdapterNote | null;
  syllableIgnored: boolean;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function providedConfidence(value: unknown): number | null {
  if (!finiteNumber(value) || value < 0 || value > 1) return null;
  return value;
}

export function normalizeAsrLanguage(value: unknown, confidenceValue?: unknown): AsrLanguageMetadata {
  let declared: AsrLanguageCode = 'uncertain';
  if (typeof value === 'string') {
    const token = value.trim().toLowerCase().replace(/_/g, '-');
    const primary = token.split('-')[0] ?? '';
    declared = LANGUAGE_ALIASES[token] ?? LANGUAGE_ALIASES[primary] ?? 'uncertain';
  }
  return {
    declared,
    code: declared,
    confidence: providedConfidence(confidenceValue),
    translated: false,
    romanized: false,
  };
}

function codePointLength(text: string): number {
  return Array.from(text).length;
}

function normalizedForRepeat(text: string): string {
  return text.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function vadOf(raw: AsrRawOutput): AsrVadObservation {
  return {
    reportedSpeech: typeof raw.vadReportedSpeech === 'boolean' ? raw.vadReportedSpeech : null,
    provesVocals: false,
  };
}

function rejection(
  fileKey: string,
  sessionToken: number,
  audioDurationSeconds: number | null,
  issue: AsrAdapterIssue,
  reason: 'instrumental' | 'no-speech' | 'failed' | 'unavailable',
  notes: AsrAdapterNote[],
  vad: AsrVadObservation,
): AsrAdapterRejection {
  return {
    ok: false,
    fileKey,
    sessionToken,
    audioDurationSeconds,
    issue,
    transcription: { ok: false, reason, lines: [] },
    timestampsAreEstimates: true,
    notes: uniqueNotes(notes),
    vad,
  };
}

function uniqueNotes(notes: AsrAdapterNote[]): AsrAdapterNote[] {
  return [...new Set(notes)];
}

function dominantIssue(notes: readonly AsrAdapterNote[]): AsrAdapterIssue {
  const order: AsrAdapterIssue[] = [
    'out-of-duration',
    'overlap',
    'invalid-timing',
    'silence',
    'instrumental',
    'empty',
    'malformed',
  ];
  for (const issue of order) {
    if (notes.includes(issue)) return issue;
  }
  return 'empty';
}

function failureReason(issue: AsrAdapterIssue): 'instrumental' | 'no-speech' | 'failed' {
  if (issue === 'instrumental') return 'instrumental';
  if (issue === 'silence' || issue === 'empty') return 'no-speech';
  return 'failed';
}

function segmentRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function lineTimingIssue(startTime: unknown, endTime: unknown, duration: number): AsrAdapterIssue | null {
  if (!finiteNumber(startTime) || !finiteNumber(endTime)) return 'invalid-timing';
  if (endTime <= startTime) return 'invalid-timing';
  if (startTime < -ASR_TIME_EPSILON_SECONDS || startTime >= duration) return 'out-of-duration';
  if (endTime > duration + ASR_TIME_EPSILON_SECONDS) return 'out-of-duration';
  return null;
}

function parseWords(
  rawWords: unknown,
  lineStart: number,
  lineEnd: number,
): { words: MeasuredTimedText[] | null; note: AsrAdapterNote | null } {
  if (rawWords == null) return { words: null, note: 'missing-word-timestamps' };
  if (!Array.isArray(rawWords) || rawWords.length === 0) return { words: null, note: 'missing-word-timestamps' };
  const words: MeasuredTimedText[] = [];
  for (const entry of rawWords) {
    const record = segmentRecord(entry);
    if (!record || typeof record.text !== 'string') return { words: null, note: 'invalid-word-timestamps' };
    const text = record.text.trim();
    if (!text || !finiteNumber(record.startTime) || !finiteNumber(record.endTime)) {
      return { words: null, note: 'invalid-word-timestamps' };
    }
    if (record.endTime <= record.startTime) return { words: null, note: 'invalid-word-timestamps' };
    if (record.startTime < lineStart - ASR_TIME_EPSILON_SECONDS) return { words: null, note: 'invalid-word-timestamps' };
    if (record.endTime > lineEnd + ASR_TIME_EPSILON_SECONDS) return { words: null, note: 'invalid-word-timestamps' };
    const previous = words[words.length - 1];
    if (previous && (record.startTime < previous.startTime || record.startTime < previous.endTime - ASR_TIME_EPSILON_SECONDS)) {
      return { words: null, note: 'invalid-word-timestamps' };
    }
    words.push({ text, startTime: record.startTime, endTime: record.endTime });
  }
  return { words, note: null };
}

function parseSegment(
  value: unknown,
  duration: number,
  documentLanguage: AsrLanguageMetadata,
  notes: AsrAdapterNote[],
): ParsedSegment | null {
  const record = segmentRecord(value);
  if (!record || typeof record.text !== 'string') {
    notes.push('invalid-timing');
    return null;
  }
  const text = record.text.trim();
  if (!text) return null;
  if ('syllables' in record && record.syllables != null) notes.push('ignored-syllable-timestamps');
  const timing = lineTimingIssue(record.startTime, record.endTime, duration);
  if (timing) {
    notes.push(timing);
    return null;
  }
  const confidence = providedConfidence(record.confidence);
  const warnings: AsrQualityWarning[] = [];
  if (confidence !== null && confidence < ASR_LOW_CONFIDENCE_THRESHOLD) warnings.push('low-confidence');
  const span = (record.endTime as number) - (record.startTime as number);
  if (codePointLength(text) / span > ASR_MAX_CHARACTERS_PER_SECOND) warnings.push('high-text-density');
  const hasOwnLanguage = typeof record.language === 'string' && record.language.trim().length > 0;
  const language = hasOwnLanguage
    ? normalizeAsrLanguage(record.language, record.languageConfidence)
    : {
        ...documentLanguage,
        confidence: providedConfidence(record.languageConfidence) ?? documentLanguage.confidence,
      };
  const startTime = record.startTime as number;
  const endTime = record.endTime as number;
  const parsedWords = parseWords(record.words, startTime, endTime);
  if (parsedWords.note) notes.push(parsedWords.note);
  return {
    text,
    startTime,
    endTime,
    language,
    confidence,
    warnings,
    words: parsedWords.words,
    wordNote: parsedWords.note,
    syllableIgnored: 'syllables' in record && record.syllables != null,
  };
}

function flagRepeatedPhrases(segments: readonly ParsedSegment[]): void {
  let index = 0;
  while (index < segments.length) {
    const key = normalizedForRepeat(segments[index].text);
    let end = index + 1;
    while (end < segments.length && normalizedForRepeat(segments[end].text) === key) end += 1;
    const run = segments.slice(index, end);
    const tight = run.every((segment, offset) => {
      if (offset === 0) return true;
      return segment.startTime - run[offset - 1].endTime <= ASR_REPEATED_PHRASE_MAX_GAP_SECONDS;
    });
    if (run.length >= ASR_EXTREME_REPEAT_RUN || (run.length >= ASR_REPEATED_PHRASE_MIN_RUN && tight)) {
      for (const segment of run) segment.warnings.push('repeated-phrase');
    }
    index = end;
  }
}

function dropOverlaps(segments: ParsedSegment[], notes: AsrAdapterNote[]): ParsedSegment[] {
  const kept: ParsedSegment[] = [];
  for (const segment of segments) {
    const previous = kept[kept.length - 1];
    if (previous && (
      segment.startTime < previous.startTime
      || segment.startTime < previous.endTime - ASR_TIME_EPSILON_SECONDS
    )) {
      notes.push('overlap');
      continue;
    }
    kept.push(segment);
  }
  return kept;
}

function emptyOutcome(
  raw: AsrRawOutput,
  fileKey: string,
  sessionToken: number,
  duration: number,
  vad: AsrVadObservation,
): AsrAdapterRejection {
  if (raw.instrumental === true) {
    return rejection(fileKey, sessionToken, duration, 'instrumental', 'instrumental', ['instrumental'], vad);
  }
  if (raw.silence === true) {
    return rejection(fileKey, sessionToken, duration, 'silence', 'no-speech', ['silence'], vad);
  }
  return rejection(fileKey, sessionToken, duration, 'empty', 'no-speech', ['empty'], vad);
}

/**
 * Validate one recognizer payload. The returned transcription has measured
 * line or word times only, and a failure always has an empty line list.
 */
export function adaptAsrOutput(raw: AsrRawOutput): AsrAdapterResult {
  const vad = vadOf(raw);
  const fileKey = typeof raw.fileKey === 'string' ? raw.fileKey.trim() : '';
  const sessionToken = finiteNumber(raw.sessionToken) ? raw.sessionToken : Number.NaN;
  const duration = finiteNumber(raw.audioDurationSeconds) ? raw.audioDurationSeconds : null;
  if (
    typeof raw.engine !== 'string'
    || raw.engine.trim().length === 0
    || typeof raw.modelId !== 'string'
    || raw.modelId.trim().length === 0
    || fileKey.length === 0
    || !finiteNumber(sessionToken)
    || duration === null
    || duration <= 0
    || duration > ASR_MAX_AUDIO_DURATION_SECONDS
    || !Array.isArray(raw.segments)
  ) {
    return rejection(fileKey, finiteNumber(sessionToken) ? sessionToken : 0, duration, 'malformed', 'failed', ['malformed'], vad);
  }

  const language = normalizeAsrLanguage(raw.language, raw.languageConfidence);
  if (raw.segments.length === 0) return emptyOutcome(raw, fileKey, sessionToken, duration, vad);

  const notes: AsrAdapterNote[] = [];
  const parsed: ParsedSegment[] = [];
  for (const entry of raw.segments) {
    const segment = parseSegment(entry, duration, language, notes);
    if (segment) parsed.push(segment);
  }
  if (parsed.length === 0 && raw.segments.every((entry) => {
    const record = segmentRecord(entry);
    return record !== null && typeof record.text === 'string' && record.text.trim().length === 0;
  })) {
    return emptyOutcome(raw, fileKey, sessionToken, duration, vad);
  }

  flagRepeatedPhrases(parsed);
  const kept = dropOverlaps(parsed, notes);
  if (kept.length === 0) {
    const issue = dominantIssue(notes);
    return rejection(fileKey, sessionToken, duration, issue, failureReason(issue), notes, vad);
  }

  const specific = new Set(kept.map((segment) => segment.language.code).filter((code) => SPECIFIC_LANGUAGES.has(code)));
  if (specific.size > 1) notes.push('mixed-language-segments');
  if (raw.instrumental === true || raw.silence === true) {
    for (const segment of kept) segment.warnings.push('instrumental-hallucination-candidate');
  }
  for (const segment of kept) {
    for (const warning of segment.warnings) notes.push(warning);
  }

  const everyLineHasWords = kept.every((segment) => segment.words && segment.words.length > 0);
  if (!everyLineHasWords && kept.some((segment) => segment.words && segment.words.length > 0)) {
    notes.push('partial-word-timestamps-dropped');
  }
  const lines: OfflineTranscriptionLine[] = kept.map((segment) => {
    const line: OfflineTranscriptionLine = {
      text: segment.text,
      startTime: segment.startTime,
      endTime: segment.endTime,
    };
    if (everyLineHasWords && segment.words) line.words = segment.words;
    return line;
  });
  const granularity = everyLineHasWords ? 'word' : 'line';
  const transcription: OfflineTranscriptionSuccess = {
    ok: true,
    lines,
    granularity,
    provenance: {
      engine: raw.engine.trim(),
      modelId: raw.modelId.trim(),
      granularity,
      timestamps: 'measured',
    },
  };
  if (!acceptMeasuredTranscription(transcription)) {
    return rejection(fileKey, sessionToken, duration, 'invalid-timing', 'failed', [...notes, 'invalid-timing'], vad);
  }
  return {
    ok: true,
    fileKey,
    sessionToken,
    audioDurationSeconds: duration,
    transcription,
    language,
    segmentLanguages: kept.map((segment) => segment.language),
    timestampsAreEstimates: true,
    notes: uniqueNotes(notes),
    reviews: kept.map((segment) => ({
      text: segment.text,
      startTime: segment.startTime,
      endTime: segment.endTime,
      confidence: segment.confidence,
      language: segment.language,
      warnings: segment.warnings,
    })),
    vad,
  };
}

export function asrResultAppliesToSession(
  result: Pick<AsrAdapterResult, 'fileKey' | 'sessionToken'>,
  active: { fileKey: string; sessionToken: number; isCurrent: boolean },
): boolean {
  return result.fileKey.length > 0
    && result.fileKey === active.fileKey
    && result.sessionToken === active.sessionToken
    && active.isCurrent;
}

/**
 * Reuse the lyric timestamp engine without labeling the preview as LRC.
 * The internal catalog identity is a timing shim and is not part of the
 * returned provenance. This preview is not a sidecar v1 draft.
 */
export function alignAdaptedAsrToChords(
  adapted: AsrAdapterSuccess,
  chords: ReadonlyArray<{ chord?: string; start?: number; end?: number }>,
): AsrChordPreview | { ok: false; code: AlignmentIssue } {
  const rows: TimestampRow[] = [];
  for (const line of adapted.transcription.lines) {
    rows.push({
      time: line.startTime,
      text: line.text,
      words: line.words?.map((word) => ({ ...word })) ?? null,
    });
    rows.push({ time: line.endTime, text: '', words: null });
  }
  const timed = alignLyricsToChords({
    rows,
    chords,
    audioDurationSeconds: adapted.audioDurationSeconds,
    identity: {
      source: 'local-lrc',
      trackTitle: '',
      artist: '',
      catalogDurationSeconds: null,
      recognizesAudio: false,
    },
    offsetSeconds: 0,
    confirmedEdition: true,
  });
  if (!timed.ok) return { ok: false, code: timed.code };
  return {
    ok: true,
    lines: timed.alignment.lines,
    gaps: timed.alignment.gaps,
    granularity: timed.alignment.granularity,
    provenance: {
      kind: 'asr-preview',
      persisted: false,
      sidecarSchema: null,
      recognizesAudio: true,
      timestampsAreEstimates: true,
      engine: adapted.transcription.provenance.engine,
      modelId: adapted.transcription.provenance.modelId,
      language: adapted.language,
      audioDurationSeconds: adapted.audioDurationSeconds,
      fileKey: adapted.fileKey,
      sessionToken: adapted.sessionToken,
    },
  };
}
