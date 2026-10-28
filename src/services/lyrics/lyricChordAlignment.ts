/**
 * Deterministic lyrics–chord alignment.
 * Timestamps come from the lyric source. This module does not invent words,
 * timestamps, or a default chord.
 */

export const EDITION_DELTA_SECONDS = 5;
export const SPAN_SLACK_SECONDS = 0.25;
export const LYRIC_SYNC_RECOGNIZES_AUDIO = false as const;

export type LyricGranularity = 'line' | 'word';
export type LyricSourceKind = 'lrclib' | 'local-lrc';

export interface TimedWord {
  text: string;
  startTime: number;
  endTime: number;
}

export interface TimestampRow {
  time: number;
  text: string;
  words?: TimedWord[] | null;
}

export interface ChordEvent {
  chord: string;
  start: number;
  end: number;
}

export interface LyricSourceIdentity {
  source: LyricSourceKind;
  trackTitle: string;
  artist: string;
  catalogDurationSeconds: number | null;
  recognizesAudio: false;
}

export interface LyricProvenance extends LyricSourceIdentity {
  audioDurationSeconds: number;
  durationDeltaSeconds: number | null;
  offsetSeconds: number;
  confirmedByUser: true;
  granularity: LyricGranularity;
}

export interface AlignedLine {
  text: string;
  startTime: number;
  endTime: number;
  sourceEndTime: number | null;
  words: TimedWord[] | null;
  chords: ChordEvent[];
}

export interface InstrumentalGap {
  startTime: number;
  endTime: number;
  chords: ChordEvent[];
}

export interface LyricChordAlignment {
  lines: AlignedLine[];
  gaps: InstrumentalGap[];
  granularity: LyricGranularity;
  provenance: LyricProvenance;
}

export type AlignmentIssue =
  | 'NO_TIMED_LINES'
  | 'UNORDERED'
  | 'INVALID_TIMING'
  | 'INVALID_AUDIO'
  | 'OFFSET_OUT_OF_RANGE'
  | 'EDITION_MISMATCH'
  | 'TIMESTAMPS_PAST_AUDIO';

export interface AlignmentRequest {
  rows: TimestampRow[];
  chords: ReadonlyArray<{ chord?: string; start?: number; end?: number }>;
  audioDurationSeconds: number;
  identity: LyricSourceIdentity;
  offsetSeconds?: number;
  confirmedEdition?: boolean;
}

export type AlignmentResult =
  | { ok: true; alignment: LyricChordAlignment }
  | {
      ok: false;
      code: AlignmentIssue;
      durationDeltaSeconds: number | null;
      lyricSpanSeconds: number | null;
    };

export interface LyricCursor {
  lineIndex: number | null;
  gapIndex: number | null;
  chord: ChordEvent | null;
}

export interface ParsedLocalLrc {
  ok: true;
  title: string;
  artist: string;
  catalogDurationSeconds: number | null;
  fileOffsetSeconds: number;
  rows: TimestampRow[];
}

export type CatalogGranularity = 'word' | 'line' | 'plain' | 'instrumental';

export interface CatalogLyricCandidate {
  id: string;
  title: string;
  artist: string;
  catalogDurationSeconds: number | null;
  instrumental: boolean;
  granularity: CatalogGranularity;
  rows: TimestampRow[] | null;
  recognizesAudio: false;
}

const CLOCK = /^(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?$/;
const LEADING_STAMPS = /^((?:\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\])+)\s*(.*)$/;
const STAMP = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
const WORD_STAMP = /<(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?>/g;

function fail(
  code: AlignmentIssue,
  durationDeltaSeconds: number | null,
  lyricSpanSeconds: number | null,
): AlignmentResult {
  return { ok: false, code, durationDeltaSeconds, lyricSpanSeconds };
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function clockToSeconds(minutes: number, seconds: number, fraction?: string): number {
  const digits = fraction ?? '';
  const milliseconds = digits.length === 2
    ? Number.parseInt(digits, 10) * 10
    : digits.length === 0
      ? 0
      : Number.parseInt(digits, 10);
  return minutes * 60 + seconds + milliseconds / 1000;
}

function durationDelta(catalog: number | null, audio: number): number | null {
  if (catalog === null || !finite(catalog)) return null;
  return catalog - audio;
}

export function usableChordEvents(
  chords: ReadonlyArray<{ chord?: string; start?: number; end?: number }>,
): ChordEvent[] {
  const events: ChordEvent[] = [];
  for (const chord of chords) {
    const label = typeof chord.chord === 'string' ? chord.chord.trim() : '';
    if (!label || !finite(chord.start) || !finite(chord.end) || chord.end <= chord.start) continue;
    events.push({ chord: label, start: chord.start, end: chord.end });
  }
  events.sort((left, right) => left.start - right.start || left.end - right.end);
  return events;
}

function overlapping(chords: readonly ChordEvent[], start: number, end: number): ChordEvent[] {
  return chords.filter((chord) => chord.start < end && start < chord.end);
}

function shiftWords(words: TimedWord[] | null | undefined, offset: number): TimedWord[] | null | 'invalid' {
  if (!words || words.length === 0) return null;
  const shifted: TimedWord[] = [];
  for (const word of words) {
    if (!word || typeof word.text !== 'string' || !finite(word.startTime) || !finite(word.endTime)) {
      return 'invalid';
    }
    shifted.push({
      text: word.text,
      startTime: word.startTime + offset,
      endTime: word.endTime + offset,
    });
  }
  return shifted;
}

function wordsForLine(words: TimedWord[] | null, lineStart: number, lineEnd: number): TimedWord[] | null {
  if (!words || words.length === 0) return null;
  const accepted: TimedWord[] = [];
  for (const word of words) {
    const text = word.text.trim();
    if (!text || word.endTime < word.startTime) return null;
    if (word.startTime < lineStart - 0.001 || word.endTime > lineEnd + 0.001) return null;
    accepted.push({ text, startTime: word.startTime, endTime: word.endTime });
  }
  return accepted.length > 0 ? accepted : null;
}

export function alignLyricsToChords(request: AlignmentRequest): AlignmentResult {
  const audio = request.audioDurationSeconds;
  const catalog = request.identity.catalogDurationSeconds;
  const delta = durationDelta(catalog, finite(audio) ? audio : 0);
  if (!finite(audio) || audio <= 0) return fail('INVALID_AUDIO', delta, null);

  const offset = request.offsetSeconds ?? 0;
  if (!finite(offset)) return fail('OFFSET_OUT_OF_RANGE', delta, null);

  const shifted: TimestampRow[] = [];
  for (const row of request.rows) {
    if (!row || !finite(row.time) || typeof row.text !== 'string') {
      return fail('INVALID_TIMING', delta, null);
    }
    const words = shiftWords(row.words, offset);
    if (words === 'invalid') return fail('INVALID_TIMING', delta, null);
    shifted.push({ time: row.time + offset, text: row.text, words });
  }

  for (let index = 1; index < shifted.length; index += 1) {
    if (shifted[index].time < shifted[index - 1].time) {
      return fail('UNORDERED', delta, lyricSpan(shifted));
    }
  }

  const span = lyricSpan(shifted);
  const drafts: Array<{
    text: string;
    startTime: number;
    endTime: number;
    sourceEndTime: number | null;
    words: TimedWord[] | null;
  }> = [];

  for (let index = 0; index < shifted.length; index += 1) {
    const row = shifted[index];
    if (!row.text.trim()) continue;
    if (row.time < -0.001) {
      return fail(offset !== 0 ? 'OFFSET_OUT_OF_RANGE' : 'INVALID_TIMING', delta, span);
    }
    if (row.time >= audio) {
      return fail(offset !== 0 ? 'OFFSET_OUT_OF_RANGE' : 'TIMESTAMPS_PAST_AUDIO', delta, span);
    }
    const next = shifted[index + 1];
    const sourceEndTime = next ? next.time : null;
    if (sourceEndTime !== null && sourceEndTime <= row.time) {
      return fail('INVALID_TIMING', delta, span);
    }
    const endTime = sourceEndTime === null ? audio : Math.min(sourceEndTime, audio);
    if (endTime <= row.time) return fail('INVALID_TIMING', delta, span);
    drafts.push({
      text: row.text.trim(),
      startTime: row.time,
      endTime,
      sourceEndTime,
      words: wordsForLine(row.words ?? null, row.time, sourceEndTime ?? audio),
    });
  }

  if (drafts.length === 0) return fail('NO_TIMED_LINES', delta, span);

  if (drafts.some((line) => line.startTime < -0.001)) {
    return fail(offset !== 0 ? 'OFFSET_OUT_OF_RANGE' : 'INVALID_TIMING', delta, span);
  }
  if (drafts.some((line) => line.startTime >= audio)) {
    return fail(offset !== 0 ? 'OFFSET_OUT_OF_RANGE' : 'TIMESTAMPS_PAST_AUDIO', delta, span);
  }

  const editionUncertain = (delta !== null && Math.abs(delta) > EDITION_DELTA_SECONDS)
    || (span !== null && span > audio + SPAN_SLACK_SECONDS);
  if (editionUncertain && !request.confirmedEdition) {
    return fail('EDITION_MISMATCH', delta, span);
  }

  const chords = usableChordEvents(request.chords);
  const lines: AlignedLine[] = drafts.map((line) => ({
    ...line,
    chords: overlapping(chords, line.startTime, line.endTime),
  }));
  const granularity: LyricGranularity = lines.every((line) => line.words && line.words.length > 0)
    ? 'word'
    : 'line';

  const gaps: InstrumentalGap[] = [];
  let cursor = 0;
  for (const line of lines) {
    if (line.startTime - cursor > 0.001) {
      gaps.push({
        startTime: cursor,
        endTime: line.startTime,
        chords: overlapping(chords, cursor, line.startTime),
      });
    }
    cursor = line.endTime;
  }
  if (audio - cursor > 0.001) {
    gaps.push({
      startTime: cursor,
      endTime: audio,
      chords: overlapping(chords, cursor, audio),
    });
  }

  return {
    ok: true,
    alignment: {
      lines,
      gaps,
      granularity,
      provenance: {
        source: request.identity.source,
        trackTitle: request.identity.trackTitle,
        artist: request.identity.artist,
        catalogDurationSeconds: catalog,
        audioDurationSeconds: audio,
        durationDeltaSeconds: delta,
        offsetSeconds: offset,
        confirmedByUser: true,
        granularity,
        recognizesAudio: false,
      },
    },
  };
}

function lyricSpan(rows: readonly TimestampRow[]): number | null {
  if (rows.length === 0) return null;
  return rows.reduce((max, row) => Math.max(max, row.time), rows[0].time);
}

function containsTime(start: number, end: number, time: number, audioDuration: number): boolean {
  if (time === audioDuration && end === audioDuration && start <= time) return true;
  return start <= time && time < end;
}

export function locateLyricCursor(alignment: LyricChordAlignment, time: number): LyricCursor {
  if (!finite(time)) return { lineIndex: null, gapIndex: null, chord: null };
  const audio = alignment.provenance.audioDurationSeconds;
  let lineIndex: number | null = null;
  let gapIndex: number | null = null;
  for (let index = 0; index < alignment.lines.length; index += 1) {
    const line = alignment.lines[index];
    if (containsTime(line.startTime, line.endTime, time, audio)) lineIndex = index;
  }
  if (lineIndex === null) {
    for (let index = 0; index < alignment.gaps.length; index += 1) {
      const gap = alignment.gaps[index];
      if (containsTime(gap.startTime, gap.endTime, time, audio)) gapIndex = index;
    }
  }
  const chords = lineIndex !== null
    ? alignment.lines[lineIndex].chords
    : gapIndex !== null
      ? alignment.gaps[gapIndex].chords
      : [];
  let chord: ChordEvent | null = null;
  for (const event of chords) {
    if (!containsTime(event.start, event.end, time, audio)) continue;
    if (!chord || event.start >= chord.start) chord = event;
  }
  return { lineIndex, gapIndex, chord };
}

export function rowsFromSynchronizedPayload(resp: unknown): TimestampRow[] | null {
  if (!resp || typeof resp !== 'object') return null;
  const record = resp as { success?: boolean; synchronized_lyrics?: unknown };
  if (record.success === false) return null;
  if (!Array.isArray(record.synchronized_lyrics) || record.synchronized_lyrics.length === 0) return null;
  const rows: TimestampRow[] = [];
  for (const entry of record.synchronized_lyrics) {
    if (!entry || typeof entry !== 'object') return null;
    const time = (entry as { time?: unknown }).time;
    const text = (entry as { text?: unknown }).text;
    if (!finite(time) || typeof text !== 'string') return null;
    rows.push({ time, text });
  }
  return rows;
}

export function synchronizedLyricsData(
  resp: unknown,
): { lines: Array<{ startTime: number; endTime: number; text: string }> } | null {
  const rows = rowsFromSynchronizedPayload(resp);
  if (!rows) return null;
  const lines: Array<{ startTime: number; endTime: number; text: string }> = [];
  for (let index = 0; index < rows.length - 1; index += 1) {
    const start = rows[index].time;
    const end = rows[index + 1].time;
    if (end <= start) return null;
    if (!rows[index].text.trim()) continue;
    lines.push({ startTime: start, endTime: end, text: rows[index].text });
  }
  return lines.length > 0 ? { lines } : null;
}

function parseClockToken(minutes: string, seconds: string, fraction?: string): number | null {
  const mins = Number.parseInt(minutes, 10);
  const secs = Number.parseInt(seconds, 10);
  if (!Number.isFinite(mins) || !Number.isFinite(secs) || secs >= 60) return null;
  return clockToSeconds(mins, secs, fraction);
}

function parseLength(value: string): number | null {
  const trimmed = value.trim();
  const clock = trimmed.match(CLOCK);
  if (clock) return parseClockToken(clock[1], clock[2], clock[3]);
  const seconds = Number(trimmed);
  return finite(seconds) && seconds > 0 ? seconds : null;
}

function displayText(body: string): string {
  return body.replace(/<\d{1,2}:\d{2}(?:[.:]\d{1,3})?>/g, ' ').replace(/\s+/g, ' ').trim();
}

function wordRows(text: string): TimedWord[] | null {
  if (!text.includes('<')) return null;
  const marks: Array<{ time: number; text: string }> = [];
  const pattern = new RegExp(WORD_STAMP.source, 'g');
  let match: RegExpExecArray | null;
  let cursor = 0;
  let sawUntimed = text.slice(0, text.indexOf('<')).trim().length > 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor && text.slice(cursor, match.index).trim()) sawUntimed = true;
    const time = parseClockToken(match[1], match[2], match[3]);
    if (time === null) return null;
    const next = pattern.lastIndex;
    const following = text.slice(next).search(WORD_STAMP);
    const bodyEnd = following === -1 ? text.length : next + following;
    marks.push({ time, text: text.slice(next, bodyEnd) });
    cursor = bodyEnd;
  }
  if (sawUntimed || marks.length === 0) return null;
  const words: TimedWord[] = [];
  for (let index = 0; index < marks.length; index += 1) {
    const current = marks[index];
    const label = current.text.trim();
    const next = marks[index + 1];
    if (!label) continue;
    if (!next) return null;
    if (next.time < current.time) return null;
    words.push({ text: label, startTime: current.time, endTime: next.time });
  }
  return words.length > 0 ? words : null;
}

export function parseLocalLrc(content: string): ParsedLocalLrc | { ok: false; code: 'INVALID_LRC' } {
  if (typeof content !== 'string' || content.length === 0 || content.length > 1_000_000 || content.includes('\0')) {
    return { ok: false, code: 'INVALID_LRC' };
  }
  let title = '';
  let artist = '';
  let catalogDurationSeconds: number | null = null;
  let fileOffsetSeconds = 0;
  const rows: TimestampRow[] = [];
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const meta = line.match(/^\[(ti|ar|length|offset):(.+)\]$/i);
    if (meta) {
      const key = meta[1].toLowerCase();
      const value = meta[2].trim();
      if (key === 'ti') title = value;
      if (key === 'ar') artist = value;
      if (key === 'length') catalogDurationSeconds = parseLength(value);
      if (key === 'offset') {
        const milliseconds = Number(value);
        if (!finite(milliseconds)) return { ok: false, code: 'INVALID_LRC' };
        fileOffsetSeconds = milliseconds / 1000;
      }
      continue;
    }
    const leading = line.match(LEADING_STAMPS);
    if (!leading) continue;
    const stamps = [...leading[1].matchAll(STAMP)];
    const body = leading[5] ?? '';
    const words = wordRows(body);
    for (const stamp of stamps) {
      const time = parseClockToken(stamp[1], stamp[2], stamp[3]);
      if (time === null) return { ok: false, code: 'INVALID_LRC' };
      rows.push({
        time,
        text: displayText(body),
        words: stamps.length === 1 ? words : null,
      });
    }
  }
  if (rows.length === 0) return { ok: false, code: 'INVALID_LRC' };
  return { ok: true, title, artist, catalogDurationSeconds, fileOffsetSeconds, rows };
}

function explicitWords(
  words: ReadonlyArray<{ text?: string; startTime?: number; endTime?: number }> | undefined,
): TimedWord[] | null {
  if (!words || words.length === 0) return null;
  const timed: TimedWord[] = [];
  for (const word of words) {
    if (!word || typeof word.text !== 'string' || !word.text.trim()) return null;
    if (!finite(word.startTime) || !finite(word.endTime) || word.endTime < word.startTime) return null;
    timed.push({ text: word.text.trim(), startTime: word.startTime, endTime: word.endTime });
  }
  return timed;
}

export function candidateFromLrclib(candidate: {
  id?: number;
  trackName?: string;
  artistName?: string;
  duration?: number;
  instrumental?: boolean;
  lyric_mode?: 'word' | 'line' | 'plain';
  synchronized_lyrics?: Array<{ time: number; text: string }>;
  lyrics?: {
    lines?: Array<{
      startTime: number;
      text: string;
      wordTimings?: Array<{ text?: string; startTime?: number; endTime?: number }>;
    }>;
  };
}): CatalogLyricCandidate {
  const mode = candidate.lyric_mode ?? 'plain';
  const instrumental = Boolean(candidate.instrumental);
  const synced = Array.isArray(candidate.synchronized_lyrics) ? candidate.synchronized_lyrics : [];
  const lyricLines = candidate.lyrics?.lines ?? [];
  let rows: TimestampRow[] | null = null;
  if (mode !== 'plain' && synced.length > 0) {
    rows = synced.map((row) => {
      const match = lyricLines.find((line) => Math.abs(line.startTime - row.time) < 0.02 && line.text.trim() === row.text.trim());
      return {
        time: row.time,
        text: row.text,
        words: match ? explicitWords(match.wordTimings) : null,
      };
    });
  } else if (mode !== 'plain' && lyricLines.length > 0) {
    rows = lyricLines.map((line) => ({
      time: line.startTime,
      text: line.text,
      words: explicitWords(line.wordTimings),
    }));
  }
  const hasText = Boolean(rows?.some((row) => row.text.trim()));
  if (!hasText) rows = null;
  let granularity: CatalogGranularity = 'plain';
  if (rows && rows.every((row) => !row.text.trim() || (row.words && row.words.length > 0)) && rows.some((row) => row.words && row.words.length > 0)) {
    granularity = 'word';
  } else if (rows) {
    granularity = 'line';
  } else if (instrumental) {
    granularity = 'instrumental';
  }
  const duration = finite(candidate.duration) && candidate.duration > 0 ? candidate.duration : null;
  return {
    id: String(candidate.id ?? ''),
    title: candidate.trackName || '',
    artist: candidate.artistName || '',
    catalogDurationSeconds: duration,
    instrumental,
    granularity,
    rows,
    recognizesAudio: false,
  };
}
