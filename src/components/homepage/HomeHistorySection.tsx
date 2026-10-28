'use client';

import { useI18n } from '@/i18n/I18nProvider';
import { useAppRuntime } from '@/runtime/useAppRuntime';
import { selectHomeHistorySource } from '@/services/audio/desktopHistoryLibrary';
import DesktopAnalysisHistory from '@/components/homepage/DesktopAnalysisHistory';
import RecentVideos from '@/components/homepage/LazyRecentVideos';

/**
 * Electron home shows the local analysis library.
 * Website and installed PWA keep the Firestore recent-transcription list.
 */
export default function HomeHistorySection() {
  const { t } = useI18n();
  const { runtime } = useAppRuntime();
  const local = selectHomeHistorySource(runtime) === 'local';

  return (
    <>
      <div className="mb-12 text-center">
        <h2 className="mb-4 text-3xl font-bold text-gray-900 dark:text-white md:text-4xl">
          {local ? t('home.localHistoryTitle') : t('home.recentTitle')}
        </h2>
        <p className="mx-auto max-w-2xl text-lg text-gray-600 dark:text-gray-300">
          {local ? t('home.localHistoryBody') : t('home.recentBody')}
        </p>
      </div>
      {local ? <DesktopAnalysisHistory /> : <RecentVideos />}
    </>
  );
}
