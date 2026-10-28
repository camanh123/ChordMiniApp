'use client';

import type { MessageKey } from '@/i18n/catalog';
import { useI18n } from '@/i18n/I18nProvider';
import {
  ANALYSIS_INPUT_SOURCES,
  type AnalysisInputSource,
  useAnalysisInputSourceStore,
} from '@/stores/analysisInputSourceStore';

const LABELS: Record<AnalysisInputSource, MessageKey> = {
  youtube: 'source.youtube',
  soundcloud: 'source.soundcloud',
  'local-audio': 'source.localAudio',
  microphone: 'source.microphone',
};

export default function AnalysisSourceSelector({ context }: { context: 'input' | 'results' }) {
  const { t } = useI18n();
  const source = useAnalysisInputSourceStore((state) => state.source);
  const setSource = useAnalysisInputSourceStore((state) => state.setSource);

  return (
    <div className={context === 'results' ? 'mb-1' : 'mb-3'}>
      <div
        role="radiogroup"
        aria-label={t('source.groupLabel')}
        data-testid={`analysis-source-selector-${context}`}
        data-selected={source}
        className="inline-flex flex-wrap gap-1"
      >
        {ANALYSIS_INPUT_SOURCES.map((option) => {
          const selected = option === source;
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={selected}
              data-testid={`analysis-source-${context}-${option}`}
              onClick={() => setSource(option)}
              className={
                selected
                  ? 'rounded-full bg-blue-600 px-3 py-1 text-xs font-medium text-white'
                  : 'rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-800 dark:bg-gray-800 dark:text-gray-100'
              }
            >
              {t(LABELS[option])}
            </button>
          );
        })}
      </div>
      {context === 'results' ? (
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400" data-testid="source-results-kept">
          {t('source.resultsKept')}
        </p>
      ) : null}
    </div>
  );
}
