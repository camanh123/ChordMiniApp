'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import { useI18n } from '@/i18n/I18nProvider';
import { AUDIO_FILE_ACCEPT, readSelectedAudioFile } from '@/runtime/audioFileInput';

export type PracticeServiceState = 'requirement' | 'not_configured' | 'unavailable';

const NOTICE_PATH = '/api/practice-inference-notice';

function formatFileSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) {
    return '';
  }
  if (size < 1024) {
    return `${Math.round(size)} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export interface LocalPracticeEntryProps {
  file: File | null;
  onFileSelected: (file: File) => void;
  /** Set after the user requests analysis. Omit to use the safe pre-click notice. */
  serviceState?: PracticeServiceState;
  hasAnalysis?: boolean;
  children?: React.ReactNode;
}

export default function LocalPracticeEntry({
  file,
  onFileSelected,
  serviceState,
  hasAnalysis = false,
  children,
}: LocalPracticeEntryProps) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const [fetchedNotice, setFetchedNotice] = useState<PracticeServiceState>('requirement');

  useEffect(() => {
    if (serviceState) {
      return undefined;
    }

    const controller = new AbortController();
    void fetch(NOTICE_PATH, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          return null;
        }
        return response.json() as Promise<{ notice?: unknown }>;
      })
      .then((body) => {
        if (body?.notice === 'not_configured') {
          setFetchedNotice('not_configured');
        }
      })
      .catch(() => {
        // A failed notice request is not evidence that inference is down.
      });

    return () => controller.abort();
  }, [serviceState]);

  const visibleState = serviceState ?? fetchedNotice;
  const openPicker = () => inputRef.current?.click();

  const onInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selected = readSelectedAudioFile(event.target.files);
    if (selected) {
      onFileSelected(selected);
    }
    event.target.value = '';
  };

  return (
    <section
      aria-labelledby={titleId}
      className="mb-6 rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-content-bg"
      data-testid="local-practice-entry"
    >
      <div className="flex flex-col gap-4">
        <div className="max-w-3xl">
          <h2 id={titleId} className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            {t('analyze.practiceTitle')}
          </h2>
          {!hasAnalysis && (
            <div className="mt-2 space-y-2 text-sm leading-6 text-gray-700 dark:text-gray-300">
              <p>{t('analyze.practicePlayback')}</p>
              <div role="status">
                {visibleState === 'not_configured' ? (
                  <>
                    <p>{t('errors.notConfigured')}</p>
                    <p>{t('errors.notConfiguredSuggestion')}</p>
                  </>
                ) : visibleState === 'unavailable' ? (
                  <>
                    <p>{t('errors.unavailable')}</p>
                    <p>{t('errors.unavailableSuggestion')}</p>
                  </>
                ) : (
                  <p>{t('analyze.practiceRequirement')}</p>
                )}
              </div>
            </div>
          )}
        </div>

        {file && (
          <div className="min-w-0">
            <p className="truncate text-base font-medium text-gray-900 dark:text-gray-100" title={file.name}>
              {file.name}
            </p>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {formatFileSize(file.size)}
              {file.type ? ` · ${file.type}` : ''}
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={openPicker}
            className={
              file
                ? 'rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700'
                : 'rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700'
            }
            data-testid="open-audio"
          >
            {file ? t('analyze.replaceAudio') : t('analyze.openAudio')}
          </button>
          <input
            ref={inputRef}
            type="file"
            accept={AUDIO_FILE_ACCEPT}
            onChange={onInputChange}
            className="hidden"
            tabIndex={-1}
            aria-hidden="true"
            data-testid="open-audio-input"
          />
        </div>

        {file ? children : null}
      </div>
    </section>
  );
}
