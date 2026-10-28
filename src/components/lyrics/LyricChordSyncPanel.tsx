'use client';

import { useMemo, useRef, useState, type FormEvent } from 'react';
import { useI18n } from '@/i18n/I18nProvider';
import {
  alignLyricsToChords,
  locateLyricCursor,
  parseLocalLrc,
  type AlignmentIssue,
  type CatalogLyricCandidate,
  type ChordEvent,
  type LyricChordAlignment,
  type LyricSourceIdentity,
  type TimestampRow,
} from '@/services/lyrics/lyricChordAlignment';
import { lookupCatalogLyrics, type CatalogLookupResult } from '@/services/lyrics/lyricCatalogLookup';
import type { LyricHistoryDraft } from '@/services/audio/lyricHistoryClient';

interface LoadedLyricSource {
  rows: TimestampRow[];
  identity: LyricSourceIdentity;
  offsetSeconds: number;
  sourceOffsetSeconds: number;
  confirmedEdition: boolean;
  userModified: boolean;
  persisted: boolean;
}

export interface LyricHistorySnapshot {
  rows: TimestampRow[];
  identity: LyricSourceIdentity;
  offsetSeconds: number;
  sourceOffsetSeconds: number;
  userModified: boolean;
  parentResultSha256: string;
}

export interface LyricChordSyncPanelProps {
  chords: ReadonlyArray<{ chord: string; start: number; end: number }>;
  currentTime: number;
  audioDuration: number;
  fileKey: string;
  sessionId: number;
  onSeek: (time: number) => void;
  lookup?: (input: { artist: string; title: string; audioDurationSeconds: number }) => Promise<CatalogLookupResult>;
  allowCatalogSearch?: boolean;
  historyResultSha256?: string | null;
  initialSnapshot?: LyricHistorySnapshot | null;
  onPersistLyrics?: (draft: LyricHistoryDraft) => Promise<{ ok: boolean; reason?: 'mismatch' | 'invalid' | 'unavailable' }>;
  onDeleteLyrics?: () => Promise<{ ok: boolean }>;
}

function formatSeconds(value: number): string {
  const sign = value < 0 ? '-' : '';
  const absolute = Math.abs(value);
  const minutes = Math.floor(absolute / 60);
  const seconds = (absolute - minutes * 60).toFixed(2).padStart(5, '0');
  return `${sign}${minutes}:${seconds}`;
}

async function readLyricFile(file: File): Promise<string> {
  if (file.size > 1_000_000) throw new Error('too-large');
  if (typeof file.text === 'function') return file.text();
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

function snapshotSource(snapshot: LyricHistorySnapshot | null | undefined): LoadedLyricSource | null {
  if (!snapshot || snapshot.identity.recognizesAudio !== false) return null;
  return {
    rows: snapshot.rows.map((row) => ({ time: row.time, text: row.text, words: row.words ?? null })),
    identity: snapshot.identity,
    offsetSeconds: snapshot.offsetSeconds,
    sourceOffsetSeconds: snapshot.sourceOffsetSeconds,
    confirmedEdition: true,
    userModified: snapshot.offsetSeconds !== snapshot.sourceOffsetSeconds,
    persisted: true,
  };
}

function storedWords(words: TimestampRow['words']): LyricHistoryDraft['rows'][number]['words'] {
  if (!words || words.length === 0) return null;
  return words.map((word) => ({ text: word.text, startTime: word.startTime, endTime: word.endTime }));
}

export default function LyricChordSyncPanel({
  chords,
  currentTime,
  audioDuration,
  fileKey,
  sessionId,
  onSeek,
  lookup = lookupCatalogLyrics,
  allowCatalogSearch = true,
  historyResultSha256 = null,
  initialSnapshot = null,
  onPersistLyrics,
  onDeleteLyrics,
}: LyricChordSyncPanelProps) {
  const { t } = useI18n();
  const identityKey = `${fileKey}:${sessionId}`;
  const [resetKey, setResetKey] = useState(identityKey);
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [searching, setSearching] = useState(false);
  const [candidates, setCandidates] = useState<CatalogLyricCandidate[]>([]);
  const [source, setSource] = useState<LoadedLyricSource | null>(() => snapshotSource(initialSnapshot));
  const [offsetDraft, setOffsetDraft] = useState(() => (
    initialSnapshot ? String(initialSnapshot.offsetSeconds) : '0'
  ));
  const [previewOffset, setPreviewOffset] = useState<number | null>(null);
  const [issue, setIssue] = useState<AlignmentIssue | 'INVALID_LRC' | 'SEARCH_FAILED' | null>(null);
  const [searchNote, setSearchNote] = useState<string | null>(null);
  const [persistNote, setPersistNote] = useState<'saved' | 'failed' | 'mismatch' | null>(
    initialSnapshot ? 'saved' : null,
  );
  const [persisting, setPersisting] = useState(false);
  const requestRef = useRef(0);
  const identityRef = useRef(identityKey);
  identityRef.current = identityKey;

  if (resetKey !== identityKey) {
    requestRef.current += 1;
    setResetKey(identityKey);
    setSearching(false);
    setCandidates([]);
    setSource(null);
    setOffsetDraft('0');
    setPreviewOffset(null);
    setIssue(null);
    setSearchNote(null);
    setPersistNote(null);
    setPersisting(false);
  }

  const activeOffset = previewOffset ?? source?.offsetSeconds ?? 0;

  const alignment: LyricChordAlignment | null = useMemo(() => {
    if (!source || !(audioDuration > 0)) return null;
    const result = alignLyricsToChords({
      rows: source.rows,
      chords,
      audioDurationSeconds: audioDuration,
      identity: source.identity,
      offsetSeconds: previewOffset ?? source.offsetSeconds,
      confirmedEdition: source.confirmedEdition,
    });
    return result.ok ? result.alignment : null;
  }, [audioDuration, chords, previewOffset, source]);

  const pendingIssue: AlignmentIssue | null = useMemo(() => {
    if (!source || !(audioDuration > 0) || alignment) return null;
    const result = alignLyricsToChords({
      rows: source.rows,
      chords,
      audioDurationSeconds: audioDuration,
      identity: source.identity,
      offsetSeconds: previewOffset ?? source.offsetSeconds,
      confirmedEdition: source.confirmedEdition,
    });
    return result.ok ? null : result.code;
  }, [alignment, audioDuration, chords, previewOffset, source]);

  const cursor = alignment ? locateLyricCursor(alignment, currentTime) : null;
  const shownIssue = issue ?? pendingIssue;

  async function searchCatalog(event: FormEvent) {
    event.preventDefault();
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    const captured = identityRef.current;
    setSearching(true);
    setSearchNote(null);
    setIssue(null);
    try {
      const result = await lookup({ artist, title, audioDurationSeconds: audioDuration });
      if (requestId !== requestRef.current || captured !== identityRef.current) return;
      setCandidates(result.candidates);
      if (!result.ok || result.candidates.length === 0) setSearchNote(result.error ? 'failed' : 'empty');
    } catch {
      if (requestId !== requestRef.current || captured !== identityRef.current) return;
      setCandidates([]);
      setIssue('SEARCH_FAILED');
    } finally {
      if (requestId === requestRef.current) setSearching(false);
    }
  }

  function useCandidate(candidate: CatalogLyricCandidate) {
    if (!candidate.rows) return;
    setSource({
      rows: candidate.rows,
      identity: {
        source: 'lrclib',
        trackTitle: candidate.title,
        artist: candidate.artist,
        catalogDurationSeconds: candidate.catalogDurationSeconds,
        recognizesAudio: false,
      },
      offsetSeconds: 0,
      sourceOffsetSeconds: 0,
      confirmedEdition: true,
      userModified: false,
      persisted: false,
    });
    setOffsetDraft('0');
    setPreviewOffset(null);
    setPersistNote(null);
    setIssue(null);
  }

  async function importLrc(file: File | undefined) {
    if (!file) return;
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    const captured = identityRef.current;
    try {
      const text = await readLyricFile(file);
      if (requestId !== requestRef.current || captured !== identityRef.current) return;
      const parsed = parseLocalLrc(text);
      if (!parsed.ok) {
        setIssue('INVALID_LRC');
        return;
      }
      const identity: LyricSourceIdentity = {
        source: 'local-lrc',
        trackTitle: parsed.title,
        artist: parsed.artist,
        catalogDurationSeconds: parsed.catalogDurationSeconds,
        recognizesAudio: false,
      };
      const trial = audioDuration > 0
        ? alignLyricsToChords({
          rows: parsed.rows,
          chords,
          audioDurationSeconds: audioDuration,
          identity,
          offsetSeconds: parsed.fileOffsetSeconds,
          confirmedEdition: false,
        })
        : null;
      setSource({
        rows: parsed.rows,
        identity,
        offsetSeconds: parsed.fileOffsetSeconds,
        sourceOffsetSeconds: parsed.fileOffsetSeconds,
        confirmedEdition: Boolean(trial?.ok),
        userModified: false,
        persisted: false,
      });
      setOffsetDraft(String(parsed.fileOffsetSeconds));
      setPreviewOffset(null);
      setPersistNote(null);
      setCandidates([]);
      setIssue(null);
    } catch {
      if (requestId === requestRef.current) setIssue('INVALID_LRC');
    }
  }

  function previewOffsetChange() {
    if (!source) return;
    const offsetSeconds = Number(offsetDraft);
    if (!Number.isFinite(offsetSeconds) || !(audioDuration > 0)) {
      setIssue(Number.isFinite(offsetSeconds) ? 'INVALID_AUDIO' : 'OFFSET_OUT_OF_RANGE');
      return;
    }
    const attempt = alignLyricsToChords({
      rows: source.rows,
      chords,
      audioDurationSeconds: audioDuration,
      identity: source.identity,
      offsetSeconds,
      confirmedEdition: source.confirmedEdition,
    });
    if (!attempt.ok) {
      setIssue(attempt.code);
      return;
    }
    setPreviewOffset(offsetSeconds);
    setIssue(null);
  }

  function draftFrom(loaded: LoadedLyricSource): LyricHistoryDraft | null {
    if (!historyResultSha256 || !/^[0-9a-f]{64}$/.test(historyResultSha256)) return null;
    if (!loaded.confirmedEdition || !(audioDuration > 0)) return null;
    const textRows = loaded.rows.filter((row) => row.text.trim());
    const granularity = textRows.length > 0 && textRows.every((row) => row.words && row.words.length > 0)
      ? 'word'
      : 'line';
    return {
      parentResultSha256: historyResultSha256,
      source: loaded.identity.source,
      trackTitle: loaded.identity.trackTitle,
      artist: loaded.identity.artist,
      catalogDurationSeconds: loaded.identity.catalogDurationSeconds,
      audioDurationSeconds: audioDuration,
      granularity,
      sourceOffsetSeconds: loaded.sourceOffsetSeconds,
      offsetSeconds: loaded.offsetSeconds,
      confirmedEdition: true,
      recognizesAudio: false,
      userModified: loaded.offsetSeconds !== loaded.sourceOffsetSeconds,
      rows: loaded.rows.map((row) => ({
        time: row.time,
        text: row.text,
        words: storedWords(row.words),
      })),
    };
  }

  async function persist(loaded: LoadedLyricSource) {
    if (!onPersistLyrics) return;
    const draft = draftFrom(loaded);
    if (!draft) {
      setPersistNote('failed');
      setSource((current) => (current ? { ...current, persisted: false } : current));
      return;
    }
    setPersisting(true);
    try {
      const result = await onPersistLyrics(draft);
      if (!result.ok) {
        setPersistNote(result.reason === 'mismatch' ? 'mismatch' : 'failed');
        setSource((current) => (current ? { ...current, persisted: false } : current));
        return;
      }
      setSource((current) => (current ? { ...current, persisted: true } : current));
      setPersistNote('saved');
    } catch {
      setPersistNote('failed');
      setSource((current) => (current ? { ...current, persisted: false } : current));
    } finally {
      setPersisting(false);
    }
  }

  async function confirmOffset() {
    if (!source || previewOffset === null) return;
    const next: LoadedLyricSource = {
      ...source,
      offsetSeconds: previewOffset,
      userModified: previewOffset !== source.sourceOffsetSeconds,
      persisted: false,
    };
    setSource(next);
    setPreviewOffset(null);
    setOffsetDraft(String(previewOffset));
    await persist(next);
  }

  async function saveLyrics() {
    if (!source || !source.confirmedEdition || previewOffset !== null) return;
    await persist(source);
  }

  async function revertOffset() {
    if (!source) return;
    const next: LoadedLyricSource = {
      ...source,
      offsetSeconds: source.sourceOffsetSeconds,
      userModified: false,
    };
    setPreviewOffset(null);
    setOffsetDraft(String(source.sourceOffsetSeconds));
    setIssue(null);
    if (source.persisted) {
      setSource({ ...next, persisted: true });
      await persist(next);
      return;
    }
    setSource(next);
  }

  async function clearLyrics() {
    const previous = source;
    if (previous?.persisted && onDeleteLyrics) {
      const result = await onDeleteLyrics();
      if (!result.ok) {
        setPersistNote('failed');
        return;
      }
    }
    setSource(null);
    setPreviewOffset(null);
    setCandidates([]);
    setIssue(null);
    setPersistNote(null);
  }

  function issueMessage(code: AlignmentIssue | 'INVALID_LRC' | 'SEARCH_FAILED'): string {
    if (code === 'INVALID_LRC') return t('lyricSync.invalidLrc');
    if (code === 'SEARCH_FAILED') return t('lyricSync.searchFailed');
    if (code === 'OFFSET_OUT_OF_RANGE') return t('lyricSync.offsetRejected');
    if (code === 'EDITION_MISMATCH') return t('lyricSync.editionNotice');
    if (code === 'TIMESTAMPS_PAST_AUDIO') return t('lyricSync.timestampsPastAudio');
    if (code === 'NO_TIMED_LINES') return t('lyricSync.noTimedLines');
    if (code === 'INVALID_AUDIO') return t('lyricSync.needDuration');
    return t('lyricSync.invalidTiming');
  }

  const timeline = alignment
    ? [
        ...alignment.gaps.map((gap, index) => ({ kind: 'gap' as const, index, start: gap.startTime, gap })),
        ...alignment.lines.map((line, index) => ({ kind: 'line' as const, index, start: line.startTime, line })),
      ].sort((left, right) => left.start - right.start)
    : [];

  return (
    <section className="space-y-4 text-gray-900 dark:text-gray-100" data-testid="lyric-sync-panel" aria-label={t('tabs.lyrics')}>
      <div className="space-y-1">
        <h3 className="text-lg font-semibold">{alignment ? t('tabs.lyrics') : t('lyricSync.emptyTitle')}</h3>
        {!alignment && <p>{t('lyricSync.emptyBody')}</p>}
        {persistNote === 'saved' && <p role="status" className="text-sm text-gray-600 dark:text-gray-300">{t('lyricSync.lyricsSaved')}</p>}
        {persistNote === 'failed' && <p role="status" className="text-sm text-gray-600 dark:text-gray-300">{t('lyricSync.lyricsSaveFailed')}</p>}
        {persistNote === 'mismatch' && <p role="status" className="text-sm text-gray-600 dark:text-gray-300">{t('lyricSync.lyricsParentMismatch')}</p>}
        {persistNote !== 'saved' && persistNote !== 'failed' && persistNote !== 'mismatch' && (
          <p className="text-sm text-gray-600 dark:text-gray-300">{t('lyricSync.historyNotStored')}</p>
        )}
      </div>

      {allowCatalogSearch && !alignment && (
        <form className="flex flex-col gap-2 md:flex-row" onSubmit={searchCatalog}>
          <label className="flex-1 text-sm">
            {t('lyricSync.title')}
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2 dark:border-gray-600 dark:bg-gray-800"
            />
          </label>
          <label className="flex-1 text-sm">
            {t('lyricSync.artist')}
            <input
              value={artist}
              onChange={(event) => setArtist(event.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2 dark:border-gray-600 dark:bg-gray-800"
            />
          </label>
          <button type="submit" className="self-end rounded-md bg-blue-600 px-3 py-2 text-white disabled:bg-gray-400" disabled={searching}>
            {searching ? t('lyricSync.searching') : t('lyricSync.search')}
          </button>
        </form>
      )}

      <label className="block text-sm">
        {t('lyricSync.import')}
        <input
          type="file"
          accept=".lrc,text/plain"
          className="mt-1 block w-full text-sm"
          onChange={(event) => {
            void importLrc(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
      </label>

      {!(audioDuration > 0) && <p role="status">{t('lyricSync.needDuration')}</p>}
      {shownIssue && <p role="status">{issueMessage(shownIssue)}</p>}
      {searchNote === 'failed' && <p role="status">{t('lyricSync.searchFailed')}</p>}
      {searchNote === 'empty' && <p role="status">{t('lyricSync.noTimedMatch')}</p>}

      {candidates.length > 0 && !alignment && (
        <ul className="space-y-3">
          {candidates.map((candidate) => {
            const delta = candidate.catalogDurationSeconds === null || !(audioDuration > 0)
              ? null
              : candidate.catalogDurationSeconds - audioDuration;
            const canSync = Boolean(candidate.rows && candidate.rows.some((row) => row.text.trim()));
            return (
              <li key={`${candidate.id}:${candidate.title}:${candidate.artist}`} className="rounded-md border border-gray-200 p-3 dark:border-gray-700">
                <p className="font-medium">{candidate.title} — {candidate.artist}</p>
                <p className="text-sm">{t('lyricSync.notFromAudio')}</p>
                <p className="text-sm">{t('lyricSync.editionNotice')}</p>
                {candidate.catalogDurationSeconds !== null && (
                  <p className="text-sm">{t('lyricSync.catalogDuration', { seconds: candidate.catalogDurationSeconds.toFixed(1) })}</p>
                )}
                {delta !== null && <p className="text-sm">{t('lyricSync.durationDelta', { seconds: delta.toFixed(1) })}</p>}
                <p className="text-sm">
                  {candidate.granularity === 'word' ? t('lyricSync.granularityWord') : candidate.granularity === 'line' ? t('lyricSync.granularityLine') : candidate.granularity === 'instrumental' ? t('lyricSync.instrumentalCatalog') : t('lyricSync.plainOnly')}
                </p>
                {candidate.granularity === 'instrumental' && <p className="text-sm">{t('lyricSync.instrumentalCatalog')}</p>}
                {canSync ? (
                  <button type="button" className="mt-2 underline" onClick={() => useCandidate(candidate)}>
                    {delta !== null && Math.abs(delta) > 5 ? t('lyricSync.confirmEdition') : t('lyricSync.useLyrics')}
                  </button>
                ) : (
                  <p className="text-sm">{candidate.instrumental ? t('lyricSync.instrumentalCatalog') : t('lyricSync.plainOnly')}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {source && !source.confirmedEdition && pendingIssue === 'EDITION_MISMATCH' && (
        <button type="button" className="underline" onClick={() => setSource({ ...source, confirmedEdition: true })}>
          {t('lyricSync.confirmEdition')}
        </button>
      )}

      {source && alignment && (
        <div className="space-y-3">
          <p className="text-sm">
            {alignment.provenance.source === 'lrclib' ? t('lyricSync.sourceLrclib') : t('lyricSync.sourceLocal')}
            {' · '}
            {alignment.granularity === 'word' ? t('lyricSync.granularityWord') : t('lyricSync.granularityLine')}
            {' · '}
            {alignment.provenance.trackTitle} — {alignment.provenance.artist}
          </p>
          {alignment.provenance.source === 'lrclib' && <p className="text-sm">{t('lyricSync.notFromAudio')}</p>}
          <p className="text-sm">{t('lyricSync.audioDuration', { seconds: alignment.provenance.audioDurationSeconds.toFixed(1) })}</p>
          {alignment.provenance.durationDeltaSeconds !== null && Math.abs(alignment.provenance.durationDeltaSeconds) >= 0.05 && (
            <p className="text-sm">{t('lyricSync.durationDelta', { seconds: alignment.provenance.durationDeltaSeconds.toFixed(1) })}</p>
          )}
          <p className="text-sm" data-testid="lyric-active-offset">{t('lyricSync.activeOffset', { seconds: activeOffset.toFixed(3) })}</p>
          <p className="text-sm" data-testid="lyric-source-offset">{t('lyricSync.sourceOffset', { seconds: source.sourceOffsetSeconds.toFixed(3) })}</p>
          {previewOffset !== null && (
            <p role="status" className="text-sm">{t('lyricSync.offsetPreviewing', { seconds: previewOffset.toFixed(3) })}</p>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-sm">
              {t('lyricSync.offset')}
              <input
                value={offsetDraft}
                onChange={(event) => setOffsetDraft(event.target.value)}
                className="mt-1 block w-32 rounded-md border border-gray-300 bg-white px-2 py-1 dark:border-gray-600 dark:bg-gray-800"
              />
            </label>
            <button type="button" className="rounded-md border border-gray-300 px-2 py-1 text-sm" onClick={previewOffsetChange}>
              {t('lyricSync.previewOffset')}
            </button>
            {previewOffset !== null && (
              <button type="button" className="rounded-md border border-gray-300 px-2 py-1 text-sm" onClick={() => { void confirmOffset(); }} disabled={persisting}>
                {t('lyricSync.saveOffset')}
              </button>
            )}
            {onPersistLyrics && source.confirmedEdition && previewOffset === null && (
              <button type="button" className="rounded-md border border-gray-300 px-2 py-1 text-sm" onClick={() => { void saveLyrics(); }} disabled={persisting}>
                {t('lyricSync.saveLyrics')}
              </button>
            )}
            <button type="button" className="text-sm underline" onClick={() => { void revertOffset(); }} disabled={persisting}>
              {t('lyricSync.revertOffset')}
            </button>
            <button type="button" className="text-sm underline" onClick={() => { void clearLyrics(); }}>
              {t('lyricSync.clear')}
            </button>
          </div>
          <ol className="space-y-2">
            {timeline.map((entry) => entry.kind === 'gap' ? (
              <li
                key={`gap-${entry.index}`}
                data-lyric-gap="true"
                data-active-gap={cursor?.gapIndex === entry.index ? 'true' : 'false'}
                className={`rounded-md px-2 py-1 ${cursor?.gapIndex === entry.index ? 'bg-amber-50 dark:bg-amber-950' : ''}`}
              >
                <button type="button" className="text-left text-sm text-gray-500" onClick={() => onSeek(entry.gap.startTime)}>
                  {t('lyricSync.gap')} {formatSeconds(entry.gap.startTime)}–{formatSeconds(entry.gap.endTime)}
                </button>
                <ChordRow
                  chords={entry.gap.chords}
                  activeChord={cursor?.gapIndex === entry.index ? cursor.chord : null}
                />
              </li>
            ) : (
              <li
                key={`line-${entry.index}`}
                data-active-line={cursor?.lineIndex === entry.index ? 'true' : 'false'}
                className={`rounded-md px-2 py-1 ${cursor?.lineIndex === entry.index ? 'bg-blue-50 dark:bg-blue-950' : ''}`}
              >
                <ChordRow
                  chords={entry.line.chords}
                  activeChord={cursor?.lineIndex === entry.index ? cursor.chord : null}
                />
                <button type="button" className="text-left" onClick={() => onSeek(entry.line.startTime)}>
                  <span className="mr-2 text-xs text-gray-500">{formatSeconds(entry.line.startTime)}</span>
                  {entry.line.text}
                </button>
                {alignment.granularity === 'word' && entry.line.words && (
                  <p className="text-xs text-gray-500">
                    {entry.line.words.map((word) => `${word.text} ${formatSeconds(word.startTime)}`).join(' · ')}
                  </p>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

function sameChord(left: ChordEvent | null, right: ChordEvent): boolean {
  return Boolean(left && left.chord === right.chord && left.start === right.start && left.end === right.end);
}

function ChordRow({
  chords,
  activeChord,
}: {
  chords: ChordEvent[];
  activeChord: ChordEvent | null;
}) {
  if (chords.length === 0) return null;
  return (
    <p className="text-sm font-medium text-blue-700 dark:text-blue-300">
      {chords.map((chord) => (
        <span
          key={`${chord.chord}:${chord.start}:${chord.end}`}
          data-chord={chord.chord}
          data-active-chord={sameChord(activeChord, chord) ? 'true' : 'false'}
          className={`mr-3 ${sameChord(activeChord, chord) ? 'underline' : ''}`}
        >
          {chord.chord}
        </span>
      ))}
    </p>
  );
}
