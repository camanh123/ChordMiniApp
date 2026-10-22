'use client';

import React, { useEffect, useRef, useState, createElement } from 'react';
import { addToast, closeToast } from '@heroui/react';
import { mergeToastClassNames } from '@/utils/toastStyles';
import { useI18n } from '@/i18n/I18nProvider';

const DEFAULT_REFERENCE_DURATION_SECONDS = 240;
const DEFAULT_ESTIMATED_MELODY_SECONDS = 100;

function createNonPausingProgressBar(durationMs: number, id: string) {
  const animName = `toast-progress-${id}`;
  return createElement(
    'div',
    {
      key: id,
      className: 'absolute bottom-0 left-0 right-0 h-1 overflow-hidden rounded-b-lg',
    },
    createElement('style', {
      key: 'style',
      dangerouslySetInnerHTML: {
        __html: `@keyframes ${animName} { from { width: 0%; } to { width: 100%; } }`,
      },
    }),
    createElement('div', {
      key: 'bar',
      style: {
        height: '100%',
        animation: `${animName} ${durationMs}ms linear forwards`,
      },
      className: 'bg-primary-400 dark:bg-primary-500 opacity-60',
    }),
  );
}

function estimateMelodyWaitSeconds(durationSeconds: number | null | undefined): number {
  const safeDuration = durationSeconds && Number.isFinite(durationSeconds) && durationSeconds > 0
    ? durationSeconds
    : DEFAULT_REFERENCE_DURATION_SECONDS;

  return Math.max(
    1,
    Math.round((DEFAULT_ESTIMATED_MELODY_SECONDS * safeDuration) / DEFAULT_REFERENCE_DURATION_SECONDS),
  );
}

interface MelodyCountdownDescriptionProps {
  estimateSeconds: number;
}

const MelodyCountdownDescription: React.FC<MelodyCountdownDescriptionProps> = ({
  estimateSeconds,
}) => {
  const { t } = useI18n();
  const [remainingSeconds, setRemainingSeconds] = useState(estimateSeconds);

  useEffect(() => {
    const startedAt = Date.now();
    const estimateMs = estimateSeconds * 1000;

    const interval = setInterval(() => {
      const elapsedMs = Date.now() - startedAt;
      const nextRemainingSeconds = Math.max(0, Math.ceil((estimateMs - elapsedMs) / 1000));
      setRemainingSeconds(nextRemainingSeconds);
    }, 250);

    return () => clearInterval(interval);
  }, [estimateSeconds]);

  if (remainingSeconds === 0) {
    return <span>{t('melody.wait')}</span>;
  }

  return <span>{t('melody.estimate', { seconds: remainingSeconds })}</span>;
};

interface MelodyTranscriptionStatusToastProps {
  isComputing: boolean;
  durationSeconds?: number | null;
  hasResult?: boolean;
  errorMessage?: string | null;
}

const MelodyTranscriptionStatusToast: React.FC<MelodyTranscriptionStatusToastProps> = ({
  isComputing,
  durationSeconds,
  hasResult = false,
  errorMessage = null,
}) => {
  const { t } = useI18n();
  const toastKeyRef = useRef<string | null>(null);
  const prevComputingRef = useRef(false);

  useEffect(() => {
    const wasComputing = prevComputingRef.current;
    prevComputingRef.current = isComputing;

    if (isComputing && !toastKeyRef.current) {
      const estimateSeconds = estimateMelodyWaitSeconds(durationSeconds);
      const durationMs = estimateSeconds * 1000;
      const key = addToast({
        title: t('melody.transcribing'),
        description: <MelodyCountdownDescription estimateSeconds={estimateSeconds} />,
        color: 'default',
        timeout: 0,
        hideCloseButton: true,
        endContent: createNonPausingProgressBar(durationMs, 'melody'),
        classNames: mergeToastClassNames({
          base: 'relative overflow-hidden',
          icon: 'text-primary-500',
          title: 'text-primary-600 dark:text-blue-400',
        }),
      });
      toastKeyRef.current = key;
      return;
    }

    if (!isComputing && wasComputing) {
      if (toastKeyRef.current) {
        closeToast(toastKeyRef.current);
        toastKeyRef.current = null;
      }

      if (!errorMessage && hasResult) {
        addToast({
          title: t('melody.ready'),
          description: t('melody.readyBody'),
          color: 'default',
          timeout: 4000,
          shouldShowTimeoutProgress: true,
          classNames: mergeToastClassNames({
            icon: 'text-success-500',
            title: 'text-success-600 dark:text-success-400',
          }),
        });
      }
    }
  }, [durationSeconds, errorMessage, hasResult, isComputing, t]);

  useEffect(() => () => {
    if (toastKeyRef.current) {
      closeToast(toastKeyRef.current);
      toastKeyRef.current = null;
    }
  }, []);

  return null;
};

export default MelodyTranscriptionStatusToast;
