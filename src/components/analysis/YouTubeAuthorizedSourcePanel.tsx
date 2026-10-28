'use client';

import { useEffect, useState } from 'react';
import { useI18n } from '@/i18n/I18nProvider';
import {
  canRunAuthorizedAnalysis,
  canSynchronize,
  compareMediaDurations,
} from '@/services/youtube/linkedAnalysisSession';
import type { AuthorizedRunRequest, AuthorizedRunResult } from '@/hooks/youtube/useAuthorizedYouTubeFile';

interface YouTubeAuthorizedSourcePanelProps {
  videoId: string;
  videoTitle: string;
  videoDurationSeconds: number | null;
  currentTimeSeconds: number;
  run: (request: AuthorizedRunRequest) => Promise<AuthorizedRunResult>;
  publish: (offsetSeconds: number, syncAllowed: boolean) => void;
  readDuration?: (file: File) => Promise<number | null>;
}

async function readAudioDuration(file: File): Promise<number | null> {
  const url = URL.createObjectURL(file);
  try {
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    const duration = await new Promise<number | null>((resolve) => {
      audio.onloadedmetadata = () => {
        resolve(Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null);
      };
      audio.onerror = () => resolve(null);
      audio.src = url;
    });
    return duration;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function YouTubeAuthorizedSourcePanel({
  videoId,
  videoTitle,
  videoDurationSeconds,
  currentTimeSeconds,
  run,
  publish,
  readDuration = readAudioDuration,
}: YouTubeAuthorizedSourcePanelProps) {
  const { t } = useI18n();
  const [file, setFile] = useState<File | null>(null);
  const [audioDurationSeconds, setAudioDurationSeconds] = useState<number | null>(null);
  const [offsetSeconds, setOffsetSeconds] = useState(0);
  const [confirmed, setConfirmed] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<AuthorizedRunResult | null>(null);
  const [trackedVideoId, setTrackedVideoId] = useState(videoId);
  if (trackedVideoId !== videoId) {
    setTrackedVideoId(videoId);
    setFile(null);
    setAudioDurationSeconds(null);
    setOffsetSeconds(0);
    setConfirmed(false);
    setRunning(false);
    setError(null);
    setOutcome(null);
  }

  const alignment = compareMediaDurations(videoDurationSeconds, audioDurationSeconds);
  const syncAllowed = canSynchronize({
    alignment: alignment.status,
    userConfirmedSameArrangement: confirmed,
  });
  const canAnalyze = canRunAuthorizedAnalysis(file ? { name: file.name, sizeBytes: file.size } : null) && !running;
  const highlighted = outcome && outcome.videoId === videoId && !outcome.stale && syncAllowed
    ? t('ytlink.syncReady', { time: currentTimeSeconds.toFixed(1) })
    : t('ytlink.syncHeld');

  useEffect(() => {
    if (!outcome || outcome.stale || outcome.videoId !== videoId) return;
    publish(offsetSeconds, syncAllowed);
  }, [offsetSeconds, outcome, publish, syncAllowed, videoId]);

  return (
    <section className="mb-3 rounded-xl border border-default-200 bg-content1 p-4" aria-label={t('ytlink.blockedTitle')}>
      <h2 className="text-base font-semibold text-foreground">{t('ytlink.blockedTitle')}</h2>
      <p className="mt-1 text-sm text-default-600">{t('ytlink.blockedBody')}</p>
      <p className="mt-2 text-sm text-foreground">
        {videoTitle ? t('ytlink.metadataTitle', { title: videoTitle }) : t('ytlink.metadataPending')}
      </p>
      <p className="text-sm text-default-600">{t('ytlink.cachedHint')}</p>

      <label className="mt-3 block text-sm font-medium text-foreground" htmlFor={`authorized-audio-${videoId}`}>
        {t('ytlink.fileLabel')}
        <input
          id={`authorized-audio-${videoId}`}
          className="mt-1 block w-full text-sm"
          type="file"
          accept=".mp3,.wav,.m4a,.mp4,.flac,.ogg,.aiff,.aif"
          onChange={(event) => {
            const next = event.target.files?.[0] ?? null;
            setOutcome(null);
            setConfirmed(false);
            setError(null);
            setFile(next);
            setAudioDurationSeconds(null);
            if (!next) return;
            void readDuration(next).then((duration) => {
              setAudioDurationSeconds(duration);
            });
          }}
        />
      </label>

      <p className="mt-2 text-sm" role="status">
        {alignment.status === 'unknown' && t('ytlink.durationUnknown')}
        {alignment.status === 'aligned' && t('ytlink.durationAligned')}
        {alignment.status === 'mismatch' && t('ytlink.durationMismatch')}
      </p>

      <label className="mt-2 block text-sm text-foreground" htmlFor={`audio-offset-${videoId}`}>
        {t('ytlink.offset')}
        <input
          id={`audio-offset-${videoId}`}
          className="mt-1 block w-32 rounded border border-default-300 px-2 py-1"
          type="number"
          step="0.1"
          value={offsetSeconds}
          onChange={(event) => {
            const next = Number(event.target.value);
            setOffsetSeconds(Number.isFinite(next) ? next : 0);
          }}
        />
      </label>

      <label className="mt-2 flex items-start gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        <span>{t('ytlink.confirmArrangement')}</span>
      </label>

      <button
        type="button"
        className="mt-3 rounded-md bg-blue-600 px-3 py-2 text-sm text-white disabled:bg-gray-400"
        disabled={!canAnalyze}
        onClick={() => {
          if (!file || !canAnalyze) return;
          setRunning(true);
          setError(null);
          void run({ file, offsetSeconds, syncAllowed })
            .then((result) => {
              if (result.videoId !== videoId || result.stale) return;
              setOutcome(result);
            })
            .catch((caught: unknown) => {
              setError(caught instanceof Error ? caught.message : t('ytlink.failed'));
            })
            .finally(() => setRunning(false));
        }}
      >
        {running ? t('ytlink.analyzing') : t('ytlink.analyze')}
      </button>

      {error ? <p className="mt-2 text-sm text-red-600" role="alert">{error}</p> : null}
      <p className="mt-2 text-sm text-default-600">{highlighted}</p>
      {outcome && outcome.videoId === videoId && !outcome.stale ? (
        <dl className="mt-2 grid grid-cols-1 gap-1 text-sm">
          <div>{t('ytlink.fileResult')}</div>
          <div>{t('ytlink.chords', { count: outcome.facts.chordCount })}</div>
          <div>{outcome.facts.bpm ? t('ytlink.bpm', { value: outcome.facts.bpm.value }) : t('ytlink.bpmMissing')}</div>
          <div>{outcome.facts.key ? t('ytlink.key', { value: outcome.facts.key.value }) : t('ytlink.keyMissing')}</div>
          <div>{outcome.facts.meter ? t('ytlink.meter', { value: outcome.facts.meter.value }) : t('ytlink.meterMissing')}</div>
          <div>
            {outcome.facts.capo
              ? t('ytlink.capo', { fret: outcome.facts.capo.value })
              : t('ytlink.capoMissing')}
          </div>
          <div>{t('ytlink.capoNote')}</div>
        </dl>
      ) : null}
    </section>
  );
}
