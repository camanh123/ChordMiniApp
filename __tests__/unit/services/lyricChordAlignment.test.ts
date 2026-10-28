/**
 * @jest-environment node
 *
 * Synthetic lyric fixtures. These tests do not transcribe a device audio file.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  AnalysisHistoryError,
  readAnalysisRecord,
  saveAnalysisRecord,
  type HistoryStoreOptions,
} from '@/desktop/analysisHistory';
import { ANALYSIS_HISTORY_SCHEMA_VERSION, parseStoredRecord, validateAnalysisDraft } from '@/desktop/analysisHistory/schema';
import {
  alignLyricsToChords,
  candidateFromLrclib,
  locateLyricCursor,
  parseLocalLrc,
  synchronizedLyricsData,
  type LyricSourceIdentity,
} from '@/services/lyrics/lyricChordAlignment';
import { catalogSearchParams } from '@/services/lyrics/lyricCatalogLookup';
import { acceptMeasuredTranscription } from '@/services/lyrics/offlineTranscriptionContract';

const FIXTURE_LRC = `[ti:Fixture Song]
[ar:Fixture Artist]
[length:00:20.00]
[00:00.00]
[00:05.00]Line one has two chords
[00:09.00]Line two
[00:12.00]
[00:16.00]Line three
`;

const CHORDS = [
  { chord: 'Am', start: 1, end: 3 },
  { chord: 'C', start: 5.5, end: 7 },
  { chord: 'G', start: 7, end: 10 },
  { chord: 'F', start: 12.5, end: 15 },
  { chord: 'Dm', start: 16, end: 19 },
  { chord: '', start: 0, end: 1 },
  { chord: 'N', start: 4, end: 4 },
];

function identity(overrides: Partial<LyricSourceIdentity> = {}): LyricSourceIdentity {
  return {
    source: 'local-lrc',
    trackTitle: 'Fixture Song',
    artist: 'Fixture Artist',
    catalogDurationSeconds: 20,
    recognizesAudio: false,
    ...overrides,
  };
}

function alignedFixture(overrides: Partial<Parameters<typeof alignLyricsToChords>[0]> = {}) {
  const parsed = parseLocalLrc(FIXTURE_LRC);
  if (!parsed.ok) throw new Error('fixture failed to parse');
  return alignLyricsToChords({
    rows: parsed.rows,
    chords: CHORDS,
    audioDurationSeconds: 20,
    identity: identity(),
    ...overrides,
  });
}

describe('lyric chord alignment fixtures', () => {
  it('aligns a realistic timestamped LRC file to chord events', () => {
    const result = alignedFixture();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alignment.lines.map((line) => line.text)).toEqual([
      'Line one has two chords',
      'Line two',
      'Line three',
    ]);
    expect(result.alignment.lines.map((line) => [line.startTime, line.endTime])).toEqual([
      [5, 9],
      [9, 12],
      [16, 20],
    ]);
    expect(result.alignment.lines[2].sourceEndTime).toBeNull();
    expect(result.alignment.granularity).toBe('line');
    expect(result.alignment.lines.every((line) => line.words === null)).toBe(true);
    expect(result.alignment.provenance).toMatchObject({
      source: 'local-lrc',
      recognizesAudio: false,
      confirmedByUser: true,
      offsetSeconds: 0,
    });
  });

  it('keeps several chords on one lyric line and chords inside instrumental gaps', () => {
    const result = alignedFixture();
    if (!result.ok) throw new Error('expected alignment');
    expect(result.alignment.lines[0].chords.map((chord) => chord.chord)).toEqual(['C', 'G']);
    expect(result.alignment.lines[1].chords.map((chord) => chord.chord)).toEqual(['G']);
    expect(result.alignment.gaps.map((gap) => [gap.startTime, gap.endTime, gap.chords.map((chord) => chord.chord)])).toEqual([
      [0, 5, ['Am']],
      [12, 16, ['F']],
    ]);
    expect(result.alignment.lines[2].chords.map((chord) => chord.chord)).toEqual(['Dm']);
  });

  it('does not invent a chord or lyric text', () => {
    const parsed = parseLocalLrc(FIXTURE_LRC);
    if (!parsed.ok) throw new Error('fixture failed to parse');
    const result = alignLyricsToChords({
      rows: parsed.rows,
      chords: [{ chord: '', start: 0, end: 1 }],
      audioDurationSeconds: 20,
      identity: identity(),
    });
    if (!result.ok) throw new Error('expected alignment');
    expect(result.alignment.lines.flatMap((line) => line.chords)).toEqual([]);
    expect(JSON.stringify(result.alignment)).not.toContain('"chord":"C"');
    expect(result.alignment.lines.map((line) => line.text)).toEqual([
      'Line one has two chords',
      'Line two',
      'Line three',
    ]);
  });

  it('keeps missing word timestamps at line granularity', () => {
    const parsed = parseLocalLrc('[00:01.00]<00:01.00>Hello <00:01.40>there\n[00:03.00]Plain line');
    if (!parsed.ok) throw new Error('fixture failed to parse');
    const result = alignLyricsToChords({
      rows: parsed.rows,
      chords: [],
      audioDurationSeconds: 10,
      identity: identity({ catalogDurationSeconds: 10 }),
    });
    if (!result.ok) throw new Error('expected alignment');
    expect(result.alignment.granularity).toBe('line');
    expect(result.alignment.lines[0].words).toBeNull();
    expect(result.alignment.lines[1].words).toBeNull();
    expect(result.alignment.lines[0].text).toBe('Hello there');
  });

  it('uses word timestamps only when every lyric line measured them', () => {
    const parsed = parseLocalLrc('[00:01.00]<00:01.00>Hello <00:01.40>there <00:02.00>\n[00:03.00]<00:03.00>Next <00:03.40>line <00:04.00>');
    if (!parsed.ok) throw new Error('fixture failed to parse');
    const result = alignLyricsToChords({
      rows: parsed.rows,
      chords: [],
      audioDurationSeconds: 10,
      identity: identity({ catalogDurationSeconds: 10 }),
    });
    if (!result.ok) throw new Error('expected alignment');
    expect(result.alignment.granularity).toBe('word');
    expect(result.alignment.lines[0].words).toEqual([
      { text: 'Hello', startTime: 1, endTime: 1.4 },
      { text: 'there', startTime: 1.4, endTime: 2 },
    ]);
  });

  it('requires confirmation when the catalog duration belongs to another edition', () => {
    const parsed = parseLocalLrc('[ti:Same Title]\n[ar:Same Artist]\n[length:03:00.00]\n[00:01.00]Same line\n[00:04.00]Still inside');
    if (!parsed.ok) throw new Error('fixture failed to parse');
    const request = {
      rows: parsed.rows,
      chords: CHORDS,
      audioDurationSeconds: 20,
      identity: identity({
        source: 'lrclib' as const,
        trackTitle: 'Same Title',
        catalogDurationSeconds: 180,
      }),
    };
    const blocked = alignLyricsToChords(request);
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.code).toBe('EDITION_MISMATCH');
    expect(blocked.durationDeltaSeconds).toBe(160);
    const confirmed = alignLyricsToChords({ ...request, confirmedEdition: true });
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.alignment.provenance.recognizesAudio).toBe(false);
    expect(confirmed.alignment.lines[0].startTime).toBe(1);
  });

  it('rejects an offset that would push timestamps outside the audio instead of clamping them', () => {
    const parsed = parseLocalLrc('[00:00.00]Start\n[00:05.00]Later');
    if (!parsed.ok) throw new Error('fixture failed to parse');
    const request = {
      rows: parsed.rows,
      chords: [],
      audioDurationSeconds: 20,
      identity: identity({ catalogDurationSeconds: 20 }),
    };
    const early = alignLyricsToChords({ ...request, offsetSeconds: -1 });
    const late = alignLyricsToChords({ ...request, offsetSeconds: 16 });
    expect(early).toMatchObject({ ok: false, code: 'OFFSET_OUT_OF_RANGE' });
    expect(late).toMatchObject({ ok: false, code: 'OFFSET_OUT_OF_RANGE' });
    expect(JSON.stringify(early)).not.toContain('startTime');
    expect(JSON.stringify(late)).not.toContain('startTime');
  });

  it('does not clip lyric starts that remain past the audio', () => {
    const parsed = parseLocalLrc('[00:25.00]Too late');
    if (!parsed.ok) throw new Error('fixture failed to parse');
    const result = alignLyricsToChords({
      rows: parsed.rows,
      chords: [{ chord: 'C', start: 0, end: 2 }],
      audioDurationSeconds: 20,
      identity: identity({ catalogDurationSeconds: 20 }),
      confirmedEdition: true,
    });
    expect(result).toMatchObject({ ok: false, code: 'TIMESTAMPS_PAST_AUDIO' });
  });

  it('rejects unordered timestamps and plain catalog text', () => {
    const parsed = parseLocalLrc('[00:05.00]Second\n[00:01.00]First');
    if (!parsed.ok) throw new Error('fixture failed to parse');
    expect(alignLyricsToChords({
      rows: parsed.rows,
      chords: [],
      audioDurationSeconds: 20,
      identity: identity({ catalogDurationSeconds: 20 }),
    })).toMatchObject({ ok: false, code: 'UNORDERED' });
    expect(synchronizedLyricsData({ plain_lyrics: 'one\ntwo' })).toBeNull();
    expect(synchronizedLyricsData({
      synchronized_lyrics: [
        { time: 1, text: 'A' },
        { time: 4, text: 'B' },
      ],
    })).toEqual({ lines: [{ startTime: 1, endTime: 4, text: 'A' }] });
    expect(parseLocalLrc('plain words without timestamps')).toEqual({ ok: false, code: 'INVALID_LRC' });
  });

  it('follows the audio clock time for pause and seek without a rate argument', () => {
    const result = alignedFixture();
    if (!result.ok) throw new Error('expected alignment');
    const paused = locateLyricCursor(result.alignment, 8);
    expect(locateLyricCursor.length).toBe(2);
    expect(locateLyricCursor(result.alignment, 8)).toEqual(paused);
    expect(paused.lineIndex).toBe(0);
    expect(paused.chord?.chord).toBe('G');
    const sought = locateLyricCursor(result.alignment, 13);
    expect(sought.lineIndex).toBeNull();
    expect(sought.gapIndex).toBe(1);
    expect(sought.chord?.chord).toBe('F');
    expect(locateLyricCursor(result.alignment, 20).lineIndex).toBe(2);
  });

  it('keeps two lyric sources isolated', () => {
    const first = alignedFixture();
    const other = parseLocalLrc('[00:01.00]Other song');
    if (!other.ok) throw new Error('fixture failed to parse');
    const second = alignLyricsToChords({
      rows: other.rows,
      chords: [{ chord: 'Em', start: 1, end: 2 }],
      audioDurationSeconds: 8,
      identity: identity({ trackTitle: 'Other', catalogDurationSeconds: 8 }),
    });
    if (!first.ok || !second.ok) throw new Error('expected alignments');
    expect(first.alignment.lines[0].text).not.toBe(second.alignment.lines[0].text);
    expect(second.alignment.lines[0].chords.map((chord) => chord.chord)).toEqual(['Em']);
  });

  it('describes catalog entries without treating plain or instrumental text as sync', () => {
    expect(candidateFromLrclib({
      id: 7,
      trackName: 'Song',
      artistName: 'Artist',
      duration: 20,
      lyric_mode: 'plain',
    })).toMatchObject({ rows: null, granularity: 'plain', recognizesAudio: false });
    expect(candidateFromLrclib({
      id: 8,
      trackName: 'Song',
      artistName: 'Artist',
      duration: 20,
      instrumental: true,
      lyric_mode: 'plain',
    })).toMatchObject({ rows: null, granularity: 'instrumental' });
  });

  it('sends a catalog query without audio and does not call inference from the lyric modules', () => {
    expect(catalogSearchParams({ artist: ' Artist ', title: ' Title ', audioDurationSeconds: 20 })).toEqual({
      artist: 'Artist',
      title: 'Title',
      duration: 20,
      prefer_synchronized: true,
    });
    const sources = [
      'src/services/lyrics/lyricChordAlignment.ts',
      'src/services/lyrics/lyricCatalogLookup.ts',
      'src/components/lyrics/LyricChordSyncPanel.tsx',
    ].map((file) => fs.readFileSync(file, 'utf8')).join('\n');
    expect(sources).not.toMatch(/\/api\/detect-beats|\/api\/recognize-chords|\/api\/detect-key|FormData|faster-whisper/);
    expect(sources).not.toMatch(/setInterval|setTimeout/);
    expect(fs.readFileSync('src/app/analyze/page.tsx', 'utf8')).not.toMatch(/idx \* 2|start \+ 2/);
    expect(fs.readFileSync('src/components/lyrics/EnhancedLyricsDisplay.tsx', 'utf8')).not.toMatch(/chord: "C"/);
    expect(fs.readFileSync('package.json', 'utf8')).not.toMatch(/faster-whisper|openai-whisper/i);
    expect(fs.readFileSync('python_backend/requirements.txt', 'utf8')).not.toMatch(/whisper/i);
  });
});

describe('offline transcription contract', () => {
  it('accepts measured line or word output and rejects invented text', () => {
    expect(acceptMeasuredTranscription({
      ok: true,
      granularity: 'line',
      lines: [{ text: 'Hello', startTime: 1, endTime: 2 }],
      provenance: { engine: 'future', modelId: 'none', granularity: 'line', timestamps: 'measured' },
    })).toBe(true);
    expect(acceptMeasuredTranscription({
      ok: true,
      granularity: 'word',
      lines: [{ text: 'Hello', startTime: 1, endTime: 2 }],
      provenance: { engine: 'future', modelId: 'none', granularity: 'word', timestamps: 'measured' },
    })).toBe(false);
    expect(acceptMeasuredTranscription({
      ok: false,
      reason: 'instrumental',
      lines: [],
    })).toBe(true);
    expect(acceptMeasuredTranscription({
      ok: false,
      reason: 'failed',
      lines: [{ text: 'invented', startTime: 0, endTime: 1 }] as never,
    })).toBe(false);
  });
});

describe('analysis history remains schemaVersion 1', () => {
  let root = '';

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'chordmini-lyric-history-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function options(): HistoryStoreOptions {
    return {
      env: {
        CHORDMINI_DESKTOP_MODE: '1',
        CHORDMINI_ANALYSIS_HISTORY_DIR: root,
      },
    };
  }

  function draft(): Record<string, unknown> {
    return {
      schemaVersion: 1,
      source: {
        kind: 'local-audio',
        displayName: 'song.mp3',
        sizeBytes: 1280,
        contentSha256: 'a'.repeat(64),
      },
      analyzedAt: '2026-10-26T14:03:05.123Z',
      models: { beat: 'madmom', chord: 'chord-cnn-lstm', beatReported: 'madmom' },
      chords: [{ chord: 'Am', start: 0.25, end: 1.5 }],
      beats: [{ time: 0.25 }],
      status: 'complete',
      provenance: { pipeline: 'local-upload-v1' },
    };
  }

  it('keeps an existing record readable and refuses a lyric field', async () => {
    expect(ANALYSIS_HISTORY_SCHEMA_VERSION).toBe(1);
    const saved = await saveAnalysisRecord(draft(), options());
    const loaded = await readAnalysisRecord(saved.record.id, options());
    expect(loaded.schemaVersion).toBe(1);
    expect(loaded).not.toHaveProperty('lyrics');
    expect(() => parseStoredRecord({ ...loaded, lyrics: { lines: [] } }, loaded.id)).toThrow(/lyrics/);
    expect(() => parseStoredRecord({ ...loaded, schemaVersion: 2 }, loaded.id)).toThrow(AnalysisHistoryError);
    await expect(saveAnalysisRecord({ ...draft(), lyrics: { lines: [] } }, options())).rejects.toThrow(/lyrics/);
    expect((await readAnalysisRecord(saved.record.id, options())).schemaVersion).toBe(1);
    expect(() => validateAnalysisDraft({ ...draft(), schemaVersion: 2 })).toThrow(AnalysisHistoryError);
  });
});
