'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/i18n/I18nProvider';
import LyricChordSyncPanel from '@/components/lyrics/LyricChordSyncPanel';
import type { LyricHistorySnapshot } from '@/components/lyrics/LyricChordSyncPanel';
import { relinkHistoryAudio, type RestoredAnalysis } from '@/services/audio/desktopHistoryLibrary';
import type { LyricHistoryDraft, LyricHistoryWrite, StoredLyricSidecar } from '@/services/audio/lyricHistoryClient';

function lyricSnapshot(sidecar: StoredLyricSidecar): LyricHistorySnapshot | null {
  if (sidecar.recognizesAudio !== false || sidecar.confirmedEdition !== true) return null;
  if (sidecar.source !== 'lrclib' && sidecar.source !== 'local-lrc') return null;
  return {
    parentResultSha256: sidecar.parentResultSha256,
    offsetSeconds: sidecar.offsetSeconds,
    sourceOffsetSeconds: sidecar.sourceOffsetSeconds,
    userModified: sidecar.userModified,
    identity: {
      source: sidecar.source,
      trackTitle: sidecar.trackTitle,
      artist: sidecar.artist,
      catalogDurationSeconds: sidecar.catalogDurationSeconds,
      recognizesAudio: false,
    },
    rows: sidecar.rows.map((row) => ({ time: row.time, text: row.text, words: row.words })),
  };
}

function formatTime(seconds: number): string {
  return seconds.toFixed(3);
}

function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, '0')}`;
}

export default function SavedAnalysisView({
  record,
  lyrics = undefined,
  lyricNotice = undefined,
  onPersistLyrics,
  onDeleteLyrics,
}: {
  record: RestoredAnalysis;
  lyrics?: StoredLyricSidecar | null;
  lyricNotice?: 'loading' | 'none' | 'mismatch' | 'unavailable';
  onPersistLyrics?: (draft: LyricHistoryDraft) => Promise<LyricHistoryWrite>;
  onDeleteLyrics?: () => Promise<LyricHistoryWrite>;
}) {
  const { t } = useI18n();
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [relinkState, setRelinkState] = useState<'idle' | 'ready' | 'failed'>('idle');
  const [playbackTime, setPlaybackTime] = useState(0);
  const [playbackDuration, setPlaybackDuration] = useState<number | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const snapshot = lyrics && record.resultSha256 && lyrics.parentResultSha256 === record.resultSha256
    ? lyricSnapshot(lyrics)
    : null;
  const audioDuration = playbackDuration
    ?? record.durationSeconds
    ?? (snapshot ? lyrics?.audioDurationSeconds ?? null : null)
    ?? 0;

  useEffect(() => () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
  }, [audioUrl]);

  const onFile = async (file: File | null) => {
    if (!file) return;
    const outcome = await relinkHistoryAudio(file, record.contentSha256);
    if (!outcome.ok) {
      setRelinkState('failed');
      return;
    }
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl(URL.createObjectURL(file));
    setRelinkState('ready');
  };

  return (
    <article className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6">
      <p>
        <Link href="/#local-history" className="text-sm text-blue-700 underline dark:text-blue-300">
          {t('analyze.historyBack')}
        </Link>
      </p>
      <header>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">{record.filename}</h1>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">{t('analyze.historyNoInference')}</p>
        <dl className="mt-3 grid grid-cols-1 gap-1 text-sm text-gray-800 dark:text-gray-100 sm:grid-cols-2">
          <div>{record.analyzedAt}</div>
          <div>{record.beatModel} · {record.chordModel}</div>
          {record.durationSeconds !== null && <div>{formatDuration(record.durationSeconds)}</div>}
          {record.bpm !== null && <div>{record.bpm} BPM</div>}
          {record.keyName && <div>{record.keyName}</div>}
          {record.meterLabel && <div>{record.meterLabel}</div>}
        </dl>
      </header>

      <section aria-labelledby="saved-chords">
        <h2 id="saved-chords" className="mb-2 text-lg font-medium">{t('analyze.historyChords')}</h2>
        <ol className="max-h-80 overflow-y-auto rounded-md border border-divider p-3 text-sm">
          {record.chords.map((chord, index) => (
            <li key={`${chord.start}-${chord.chord}-${index}`}>
              {formatTime(chord.start)}–{formatTime(chord.end)} {chord.chord}
              {chord.confidence !== null ? ` (${chord.confidence})` : ''}
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="saved-beats">
        <h2 id="saved-beats" className="mb-2 text-lg font-medium">{t('analyze.historyBeats')}</h2>
        <ol className="max-h-64 overflow-y-auto rounded-md border border-divider p-3 text-sm">
          {record.beats.map((beat, index) => (
            <li key={`${beat.time}-${index}`}>{formatTime(beat.time)}</li>
          ))}
        </ol>
        {record.downbeats && record.downbeats.length > 0 && (
          <p className="mt-2 text-sm text-gray-700 dark:text-gray-200">
            {record.downbeats.map((time) => formatTime(time)).join(' · ')}
          </p>
        )}
      </section>

      {record.synchronizedChords && record.synchronizedChords.length > 0 && (
        <ol className="max-h-64 overflow-y-auto text-sm text-gray-800 dark:text-gray-100">
          {record.synchronizedChords.map((entry) => (
            <li key={`${entry.beatIndex}-${entry.chord}`}>
              {entry.beatIndex}: {entry.chord}
              {record.beats[entry.beatIndex] ? ` @ ${formatTime(record.beats[entry.beatIndex].time)}` : ''}
            </li>
          ))}
        </ol>
      )}

      <section aria-labelledby="saved-audio">
        <h2 id="saved-audio" className="mb-2 text-lg font-medium">{t('analyze.historyRelink')}</h2>
        <p className="mb-3 text-sm text-gray-700 dark:text-gray-200">{t('analyze.historyPlaybackNeedsFile')}</p>
        <input
          type="file"
          accept="audio/mpeg,audio/wav,.mp3,.wav"
          aria-label={t('analyze.historyRelink')}
          onChange={(event) => {
            void onFile(event.target.files?.[0] ?? null);
          }}
        />
        {relinkState === 'failed' && (
          <p role="status" className="mt-3 text-sm text-amber-800 dark:text-amber-300">{t('analyze.historyRelinkFailed')}</p>
        )}
        {audioUrl && (
          <div className="mt-3">
            {relinkState === 'ready' && (
              <p role="status" className="mb-2 text-sm text-green-700 dark:text-green-400">{t('analyze.historyRelinkReady')}</p>
            )}
            <audio
              ref={audioElementRef}
              controls
              src={audioUrl}
              onTimeUpdate={(event) => setPlaybackTime(event.currentTarget.currentTime)}
              onLoadedMetadata={(event) => {
                const value = event.currentTarget.duration;
                if (Number.isFinite(value) && value > 0) setPlaybackDuration(value);
              }}
            />
          </div>
        )}
      </section>

      {lyricNotice === 'mismatch' && (
        <p role="status" className="text-sm text-amber-800 dark:text-amber-300">{t('lyricSync.lyricsParentMismatch')}</p>
      )}
      {lyricNotice === 'unavailable' && (
        <p role="status" className="text-sm text-amber-800 dark:text-amber-300">{t('lyricSync.lyricsUnavailable')}</p>
      )}
      {lyrics === null && lyricNotice !== 'mismatch' && lyricNotice !== 'unavailable' && lyricNotice !== 'loading' && (
        <p className="text-sm text-gray-700 dark:text-gray-200">{t('lyricSync.noSavedLyrics')}</p>
      )}
      {snapshot && lyrics && (
        <LyricChordSyncPanel
          key={record.id}
          allowCatalogSearch={false}
          chords={record.chords}
          currentTime={playbackTime}
          audioDuration={audioDuration}
          fileKey={record.id}
          sessionId={0}
          historyResultSha256={record.resultSha256}
          initialSnapshot={snapshot}
          onPersistLyrics={onPersistLyrics ? async (draft) => {
            const outcome = await onPersistLyrics(draft);
            return outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason };
          } : undefined}
          onDeleteLyrics={onDeleteLyrics ? async () => {
            const outcome = await onDeleteLyrics();
            return { ok: outcome.ok };
          } : undefined}
          onSeek={(time) => {
            const audio = audioElementRef.current;
            if (audio) {
              try { audio.currentTime = time; } catch { /* clock not ready */ }
            }
            setPlaybackTime(time);
          }}
        />
      )}
    </article>
  );
}
