'use client';

import { FormEvent } from 'react';
import { useI18n } from '@/i18n/I18nProvider';
import { parseSoundCloudLink } from '@/services/soundcloud/soundCloudLink';
import {
  requestSoundCloudLookup,
  useAnalysisInputSourceStore,
} from '@/stores/analysisInputSourceStore';

export default function SoundCloudSourcePanel({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  const input = useAnalysisInputSourceStore((state) => state.soundCloudInput);
  const setInput = useAnalysisInputSourceStore((state) => state.setSoundCloudInput);
  const lookup = useAnalysisInputSourceStore((state) => state.soundCloudLookup);
  const parsed = parseSoundCloudLink(input);
  const ready = lookup.status === 'ready' && parsed.ok && parsed.url === lookup.url ? lookup : null;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void requestSoundCloudLookup(input);
  };

  return (
    <form
      onSubmit={onSubmit}
      className="mt-3 space-y-2"
      data-testid="soundcloud-source-panel"
      data-inference="false"
    >
      <p className="text-sm text-gray-600 dark:text-gray-300">{t('source.soundcloudPlaybackOnly')}</p>
      <div className="flex flex-wrap gap-2">
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={t('source.soundcloudPlaceholder')}
          aria-label={t('source.soundcloudPlaceholder')}
          className="min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          data-testid="soundcloud-url"
        />
        <button
          type="submit"
          className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-800 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
          data-testid="soundcloud-check-link"
        >
          {t('source.soundcloudCheck')}
        </button>
      </div>
      {lookup.status === 'invalid' ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">{t('source.soundcloudInvalid')}</p>
      ) : null}
      {lookup.status === 'unavailable' ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">{t('source.soundcloudFailed')}</p>
      ) : null}
      {lookup.status === 'loading' ? (
        <p role="status" className="text-sm text-gray-600 dark:text-gray-300">{t('source.soundcloudChecking')}</p>
      ) : null}
      {ready ? (
        <div className="space-y-1">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{ready.title}</p>
          <p className="text-xs text-gray-600 dark:text-gray-300">{ready.author}</p>
          <iframe
            title={ready.title}
            src={ready.playerUrl}
            width="100%"
            height={compact ? 120 : 166}
            loading="lazy"
            referrerPolicy="strict-origin-when-cross-origin"
            allow="autoplay"
            data-testid="soundcloud-player"
          />
        </div>
      ) : null}
    </form>
  );
}
