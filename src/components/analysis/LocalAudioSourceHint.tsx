'use client';

import Link from 'next/link';
import { useI18n } from '@/i18n/I18nProvider';
import { useAnalysisInputSourceStore } from '@/stores/analysisInputSourceStore';

export default function LocalAudioSourceHint() {
  const { t } = useI18n();
  const setSource = useAnalysisInputSourceStore((state) => state.setSource);

  return (
    <div className="mt-3 space-y-2" data-testid="local-audio-source-hint">
      <p className="text-sm text-gray-600 dark:text-gray-300">{t('source.localContinue')}</p>
      <Link
        href="/analyze"
        onClick={() => setSource('local-audio')}
        className="inline-flex rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white"
        data-testid="open-local-audio"
      >
        {t('source.openLocal')}
      </Link>
    </div>
  );
}
