'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/i18n/I18nProvider';
import { parseYouTubeLink } from '@/utils/youtubeLink';

export default function YouTubeSourceDraft() {
  const { t } = useI18n();
  const router = useRouter();
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseYouTubeLink(value);
    if (!parsed.ok) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    router.push(`/analyze/${parsed.videoId}`);
  };

  return (
    <form onSubmit={onSubmit} className="mt-3 space-y-2" data-testid="youtube-source-draft" data-inference="false">
      <p className="text-sm text-gray-600 dark:text-gray-300">{t('source.youtubePlaybackOnly')}</p>
      <div className="flex flex-wrap gap-2">
        <input
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setInvalid(false);
          }}
          placeholder={t('source.youtubePlaceholder')}
          aria-label={t('source.youtubePlaceholder')}
          className="min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          data-testid="youtube-url"
        />
        <button
          type="submit"
          className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white"
          data-testid="youtube-open-playback"
        >
          {t('source.youtubeOpen')}
        </button>
      </div>
      {invalid ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">{t('source.youtubeInvalid')}</p>
      ) : null}
    </form>
  );
}
