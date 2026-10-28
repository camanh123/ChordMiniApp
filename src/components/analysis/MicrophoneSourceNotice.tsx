'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/i18n/I18nProvider';
import {
  cancelMicrophoneRecording,
  microphoneRecordingAvailable,
  readRecordingSnapshot,
  releaseRecordingTracks,
  startMicrophoneRecording,
  stopMicrophoneRecording,
  subscribeMicrophoneRecording,
} from '@/services/audio/microphoneRecording';
import { armMicrophoneContinue } from '@/stores/analysisInputSourceStore';

const buttonClass = 'rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-800 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100';

export default function MicrophoneSourceNotice({
  onAnalyze,
}: {
  onAnalyze?: (file: File) => void;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const recording = useSyncExternalStore(
    subscribeMicrophoneRecording,
    readRecordingSnapshot,
    readRecordingSnapshot,
  );
  const available = microphoneRecordingAvailable();

  useEffect(() => () => {
    releaseRecordingTracks();
  }, []);

  if (!available) {
    return (
      <div className="mt-3 space-y-1" data-testid="microphone-unavailable" role="status">
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{t('source.microphoneTitle')}</p>
        <p className="text-sm text-gray-600 dark:text-gray-300">{t('source.microphoneBody')}</p>
      </div>
    );
  }

  const showStart = recording.phase !== 'recording' && recording.phase !== 'requesting';
  const showCancel = recording.phase === 'recording' || recording.phase === 'requesting' || recording.phase === 'ready';
  const analyzable = recording.phase === 'ready' && recording.file !== null;

  return (
    <div className="mt-3 space-y-2" data-testid="microphone-recorder" data-phase={recording.phase}>
      <p className="text-sm text-gray-600 dark:text-gray-300">{t('source.recordHint')}</p>
      {recording.phase === 'requesting' ? (
        <p role="status" className="text-sm text-gray-600 dark:text-gray-300">{t('source.recordRequesting')}</p>
      ) : null}
      {recording.phase === 'recording' ? (
        <p role="status" className="text-sm text-gray-900 dark:text-gray-100" data-testid="microphone-duration">
          {t('source.recordDuration', { time: recording.durationLabel })}
        </p>
      ) : null}
      {recording.phase === 'denied' ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">{t('source.recordDenied')}</p>
      ) : null}
      {recording.phase === 'missing' ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">{t('source.recordMissing')}</p>
      ) : null}
      {recording.phase === 'error' ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">{t('source.recordFailed')}</p>
      ) : null}
      {analyzable ? (
        <p role="status" className="text-sm text-gray-600 dark:text-gray-300">{t('source.recordReady')}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {showStart ? (
          <button type="button" className={buttonClass} data-testid="microphone-start" onClick={() => { void startMicrophoneRecording(); }}>
            {t('source.recordStart')}
          </button>
        ) : null}
        {recording.phase === 'recording' ? (
          <button type="button" className={buttonClass} data-testid="microphone-stop" onClick={() => { void stopMicrophoneRecording(); }}>
            {t('source.recordStop')}
          </button>
        ) : null}
        {showCancel ? (
          <button type="button" className={buttonClass} data-testid="microphone-cancel" onClick={cancelMicrophoneRecording}>
            {t('source.recordCancel')}
          </button>
        ) : null}
        {analyzable && recording.file && onAnalyze ? (
          <button
            type="button"
            className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white"
            data-testid="microphone-analyze"
            onClick={() => onAnalyze(recording.file as File)}
          >
            {t('source.recordAnalyze')}
          </button>
        ) : null}
        {analyzable && !onAnalyze ? (
          <button
            type="button"
            className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white"
            data-testid="microphone-continue"
            onClick={() => {
              armMicrophoneContinue();
              router.push('/analyze');
            }}
          >
            {t('source.recordContinue')}
          </button>
        ) : null}
      </div>
      {analyzable && recording.previewUrl ? (
        <audio data-testid="microphone-preview" controls preload="metadata" src={recording.previewUrl} />
      ) : null}
    </div>
  );
}
