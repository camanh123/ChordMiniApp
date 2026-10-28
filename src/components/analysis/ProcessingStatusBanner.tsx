'use client';

import React, { useCallback, useEffect, useRef, createElement } from 'react';
import { addToast, closeToast } from '@heroui/react';
import { mergeToastClassNames } from '@/utils/toastStyles';

import { useProcessing } from '@/contexts/ProcessingContext';
import { useI18n } from '@/i18n/I18nProvider';

/**
 * The bar is indeterminate. Elapsed time is not model progress, so the track
 * must not fill to 100% while beat or chord recognition is still running.
 */
function createIndeterminateProgressBar(id: string) {
  const animName = `toast-progress-indeterminate-${id}`;
  return createElement('div', {
    key: id,
    className: 'absolute bottom-0 left-0 right-0 h-1 overflow-hidden rounded-b-lg',
    'aria-hidden': true,
  },
    createElement('style', {
      key: 'style',
      dangerouslySetInnerHTML: {
        __html: `@keyframes ${animName} { from { transform: translateX(-120%); } to { transform: translateX(320%); } }`,
      },
    }),
    createElement('div', {
      key: 'bar',
      style: {
        height: '100%',
        width: '35%',
        animation: `${animName} 1.4s ease-in-out infinite`,
      },
      className: 'bg-primary-400 dark:bg-primary-500 opacity-60',
    }),
  );
}

interface ProcessingStatusBannerProps {
  audioUrl?: string;
  fromCache?: boolean;
  fromFirestoreCache?: boolean;
  videoId?: string;
  beatDetector?: 'madmom' | 'beat-transformer' | 'auto';
  /**
   * Local-upload generation. Omitted on the YouTube page, which does not
   * switch files underneath an in-flight upload request.
   */
  analysisSessionId?: number;
}

const ProcessingStatusBanner: React.FC<ProcessingStatusBannerProps> = React.memo(({
  audioUrl,
  fromCache = false,
  fromFirestoreCache = false,
  analysisSessionId,
}) => {
  const { stage, statusMessage, getFormattedElapsedTime } = useProcessing();
  const { t } = useI18n();
  const chordToastKeyRef = useRef<string | null>(null);
  const beatToastKeyRef = useRef<string | null>(null);
  const cacheToastKeyRef = useRef<string | null>(null);
  const prevStageRef = useRef<string>('idle');
  const seenAudioUrlRef = useRef(audioUrl);
  const progressAudioRef = useRef<string | null>(null);
  const progressSessionRef = useRef<number | undefined>(undefined);
  const progressDismissedRef = useRef(false);

  const closeProgressToasts = useCallback(() => {
    if (chordToastKeyRef.current) {
      closeToast(chordToastKeyRef.current);
      chordToastKeyRef.current = null;
    }
    if (beatToastKeyRef.current) {
      closeToast(beatToastKeyRef.current);
      beatToastKeyRef.current = null;
    }
    if (cacheToastKeyRef.current) {
      closeToast(cacheToastKeyRef.current);
      cacheToastKeyRef.current = null;
    }
  }, []);

  const bindProgressOwner = useCallback(() => {
    progressDismissedRef.current = false;
    progressAudioRef.current = audioUrl ?? null;
    progressSessionRef.current = analysisSessionId;
  }, [analysisSessionId, audioUrl]);

  useEffect(() => {
    const prevStage = prevStageRef.current;
    prevStageRef.current = stage;

    if (seenAudioUrlRef.current !== audioUrl) {
      const previousUrl = seenAudioUrlRef.current;
      seenAudioUrlRef.current = audioUrl;
      if (previousUrl && previousUrl !== audioUrl) {
        progressDismissedRef.current = true;
        progressAudioRef.current = null;
        progressSessionRef.current = undefined;
        closeProgressToasts();
      }
    }

    // The upload page labels chord recognition first, then beat detection, while
    // one analysis request is still running. Each label is its own toast. A toast
    // is opened only when that stage is entered, and it stays until the analysis
    // reaches a terminal stage. Estimated durations are not used as dismiss timers.
    if (stage === 'chord-recognition' && prevStage !== 'chord-recognition') {
      if (chordToastKeyRef.current) {
        closeToast(chordToastKeyRef.current);
        chordToastKeyRef.current = null;
      }
      bindProgressOwner();
      chordToastKeyRef.current = addToast({
        title: t('analyze.recognizingTitle'),
        description: t('analyze.recognizing'),
        color: 'default',
        timeout: 0,
        hideCloseButton: true,
        endContent: createIndeterminateProgressBar('chord'),
        classNames: mergeToastClassNames({
          base: 'relative overflow-hidden',
          icon: 'text-primary-500',
          title: 'text-primary-600 dark:text-blue-400',
        }),
      });
    }

    if (stage === 'beat-detection' && prevStage !== 'beat-detection') {
      if (beatToastKeyRef.current) {
        closeToast(beatToastKeyRef.current);
        beatToastKeyRef.current = null;
      }
      bindProgressOwner();
      beatToastKeyRef.current = addToast({
        title: t('analyze.detectingTitle'),
        description: t('analyze.detecting'),
        color: 'default',
        timeout: 0,
        hideCloseButton: true,
        endContent: createIndeterminateProgressBar('beat'),
        classNames: mergeToastClassNames({
          base: 'relative overflow-hidden',
          icon: 'text-primary-500',
          title: 'text-primary-600 dark:text-blue-400',
        }),
      });
    }

    if (stage === 'cache-loading' && prevStage !== 'cache-loading') {
      if (cacheToastKeyRef.current) {
        closeToast(cacheToastKeyRef.current);
        cacheToastKeyRef.current = null;
      }
      bindProgressOwner();
      cacheToastKeyRef.current = addToast({
        title: t('analyze.cacheLoadingTitle'),
        description: t('analyze.cacheLoading'),
        color: 'default',
        timeout: 0,
        hideCloseButton: true,
        endContent: createIndeterminateProgressBar('cache'),
        classNames: mergeToastClassNames({
          base: 'relative overflow-hidden',
          icon: 'text-primary-500',
          title: 'text-primary-600 dark:text-blue-400',
        }),
      });
    }

    const savedResultsLoaded = stage === 'cache-loaded'
      || (stage === 'complete' && prevStage === 'cache-loading');
    if (savedResultsLoaded && prevStage !== 'cache-loaded') {
      const dismissed = progressDismissedRef.current;
      const audioMismatch = Boolean(progressAudioRef.current) && progressAudioRef.current !== audioUrl;
      const sessionMismatch = analysisSessionId !== undefined
        && progressSessionRef.current !== analysisSessionId;
      closeProgressToasts();
      progressDismissedRef.current = false;
      progressAudioRef.current = null;
      progressSessionRef.current = undefined;
      if (!dismissed && !audioMismatch && !sessionMismatch) {
        addToast({
          title: t('analyze.savedResultsLoadedTitle'),
          description: t('analyze.savedResultsLoadedDetail'),
          color: 'default',
          timeout: 5000,
          shouldShowTimeoutProgress: true,
          classNames: mergeToastClassNames({
            icon: 'text-success-500',
            title: 'text-success-600 dark:text-success-400',
          }),
        });
      }
    }

    if (stage === 'complete' && (prevStage === 'beat-detection' || prevStage === 'chord-recognition')) {
      const dismissed = progressDismissedRef.current;
      const audioMismatch = Boolean(progressAudioRef.current) && progressAudioRef.current !== audioUrl;
      const sessionMismatch = analysisSessionId !== undefined
        && progressSessionRef.current !== analysisSessionId;
      closeProgressToasts();
      progressDismissedRef.current = false;
      progressAudioRef.current = null;
      progressSessionRef.current = undefined;
      if (dismissed || audioMismatch || sessionMismatch) {
        return;
      }
      const cacheInfo = [
        fromCache ? t('analyze.audioCache') : '',
        fromFirestoreCache ? t('analyze.resultsCache') : '',
      ].filter(Boolean).join(' · ');
      const description = `${t('analyze.completeDetail', { time: getFormattedElapsedTime() })}${cacheInfo ? ` · ${cacheInfo}` : ''}`;
      addToast({
        title: t('analyze.completeTitle'),
        description,
        color: 'default',
        timeout: 5000,
        shouldShowTimeoutProgress: true,
        classNames: mergeToastClassNames({
          icon: 'text-success-500',
          title: 'text-success-600 dark:text-success-400',
        }),
      });
    }

    // AnalysisErrorToast owns the user-facing error on the YouTube page.
    // The local upload page renders the error inline. Either way, progress toasts end here.
    if (stage === 'error' || stage === 'idle') {
      closeProgressToasts();
      progressDismissedRef.current = false;
      progressAudioRef.current = null;
      progressSessionRef.current = undefined;
    }
  }, [
    stage,
    statusMessage,
    getFormattedElapsedTime,
    fromCache,
    fromFirestoreCache,
    t,
    closeProgressToasts,
    audioUrl,
    analysisSessionId,
    bindProgressOwner,
  ]);

  useEffect(() => {
    return () => {
      closeProgressToasts();
    };
  }, [closeProgressToasts]);

  return null;
});

ProcessingStatusBanner.displayName = 'ProcessingStatusBanner';

export default ProcessingStatusBanner;
