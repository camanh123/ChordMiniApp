'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useI18n } from '@/i18n/I18nProvider';
import { useAppRuntime } from '@/runtime/useAppRuntime';
import SavedAnalysisView from '@/components/analysis/SavedAnalysisView';
import {
  fetchHistoryRecord,
  type HistoryRecordResult,
} from '@/services/audio/desktopHistoryLibrary';
import {
  deleteLyricHistory,
  fetchLyricSidecar,
  saveLyricHistory,
  type StoredLyricSidecar,
} from '@/services/audio/lyricHistoryClient';

export default function SavedAnalysisPage() {
  const params = useParams();
  const rawId = params?.id;
  const id = typeof rawId === 'string' ? rawId : Array.isArray(rawId) ? rawId[0] ?? '' : '';
  const { runtime } = useAppRuntime();
  const { t } = useI18n();
  const [result, setResult] = useState<HistoryRecordResult | null>(null);
  const [lyrics, setLyrics] = useState<StoredLyricSidecar | null | undefined>(undefined);
  const [lyricNotice, setLyricNotice] = useState<'loading' | 'none' | 'mismatch' | 'unavailable'>('loading');

  useEffect(() => {
    if (runtime !== 'electron' || !id) return undefined;
    let cancelled = false;
    void fetchHistoryRecord(id).then((loaded) => {
      if (!cancelled) setResult(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [id, runtime]);

  useEffect(() => {
    if (runtime !== 'electron' || !id || result?.state !== 'ready') return undefined;
    const ready = result.record;
    let cancelled = false;
    setLyricNotice('loading');
    void fetchLyricSidecar(id, fetch, ready.resultSha256).then((loaded) => {
      if (cancelled) return;
      if (loaded.state === 'ready') {
        const attached = loaded.lyrics
          && ready.resultSha256
          && loaded.lyrics.parentResultSha256 === ready.resultSha256
          ? loaded.lyrics
          : null;
        setLyrics(attached);
        setLyricNotice(loaded.lyrics && !attached ? 'mismatch' : 'none');
      } else if (loaded.state === 'mismatch') {
        setLyrics(null);
        setLyricNotice('mismatch');
      } else {
        setLyrics(null);
        setLyricNotice('unavailable');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [id, result, runtime]);

  if (runtime !== 'electron') {
    return (
      <p className="px-4 py-8 text-sm">
        <Link href="/">{t('analyze.historyBack')}</Link>
      </p>
    );
  }

  if (!result) {
    return <p role="status" className="px-4 py-8 text-sm">{t('home.loading')}</p>;
  }

  if (result.state === 'ready') {
    const ready = result.record;
    return (
      <SavedAnalysisView
        record={ready}
        lyrics={lyrics}
        lyricNotice={lyricNotice}
        onPersistLyrics={ready.resultSha256 ? async (draft) => saveLyricHistory(ready.id, draft) : undefined}
        onDeleteLyrics={async () => deleteLyricHistory(ready.id)}
      />
    );
  }

  const message = result.state === 'missing'
    ? t('analyze.historyMissing')
    : result.state === 'corrupt'
      ? t('analyze.historyCorrupt')
      : result.state === 'unsupported'
        ? t('analyze.historyUnsupported')
        : t('analyze.historyUnavailable');

  return (
    <div className="px-4 py-8">
      <p>
        <Link href="/#local-history" className="text-sm text-blue-700 underline">{t('analyze.historyBack')}</Link>
      </p>
      <p role="status" className="mt-4 text-sm text-amber-800">{message}</p>
    </div>
  );
}
