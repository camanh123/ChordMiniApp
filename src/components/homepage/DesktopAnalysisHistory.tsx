'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/i18n/I18nProvider';
import {
  deleteHistoryRecord,
  filterHistoryByFilename,
  HISTORY_CARD_PAGE_SIZE,
  loadDesktopHistory,
  pageHistoryCards,
  type HistoryCard,
  type HistoryLoadResult,
} from '@/services/audio/desktopHistoryLibrary';

function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const remain = total % 60;
  return `${minutes}:${remain.toString().padStart(2, '0')}`;
}

function recordedFacts(record: HistoryCard): string[] {
  return [
    record.bpm !== null ? `${record.bpm} BPM` : null,
    record.keyName,
    record.meterLabel,
  ].filter((fact): fact is string => Boolean(fact));
}

export default function DesktopAnalysisHistory({
  fetchImpl,
  load = loadDesktopHistory,
}: {
  fetchImpl?: typeof fetch;
  load?: (fetchImpl?: typeof fetch) => Promise<HistoryLoadResult>;
}) {
  const { t } = useI18n();
  const [records, setRecords] = useState<HistoryCard[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable' | 'error'>('loading');
  const [query, setQuery] = useState('');
  const [pageIndex, setPageIndex] = useState(0);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deleteFailed, setDeleteFailed] = useState(false);
  const recordsRef = useRef<HistoryCard[]>([]);
  recordsRef.current = records;

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    void load(fetchImpl).then((loaded) => {
      if (cancelled) return;
      if (loaded.state === 'ready') {
        setRecords(loaded.records);
        setStatus('ready');
        return;
      }
      const kept = loaded.records.length > 0 ? loaded.records : recordsRef.current;
      if (loaded.records.length > 0) setRecords(loaded.records);
      setStatus(kept.length > 0 ? 'error' : loaded.state === 'unavailable' ? 'unavailable' : 'error');
    });
    return () => {
      cancelled = true;
    };
  }, [fetchImpl, load]);

  const filtered = useMemo(() => filterHistoryByFilename(records, query), [records, query]);
  const paged = pageHistoryCards(filtered, pageIndex, HISTORY_CARD_PAGE_SIZE);
  const visiblePage = paged.pageIndex;

  const confirmDelete = async (id: string) => {
    const outcome = await deleteHistoryRecord(id, fetchImpl);
    if (outcome !== 'deleted') {
      setDeleteFailed(true);
      setPendingDeleteId(null);
      return;
    }
    setRecords((current) => current.filter((record) => record.id !== id));
    setPendingDeleteId(null);
    setDeleteFailed(false);
  };

  return (
    <section id="local-history" aria-label={t('home.localHistoryTitle')} className="w-full">
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-end">
        <label className="w-full md:max-w-sm text-sm text-gray-700 dark:text-gray-300">
          <span className="sr-only">{t('home.localHistorySearch')}</span>
          <input
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPageIndex(0);
            }}
            placeholder={t('home.localHistorySearch')}
            aria-label={t('home.localHistorySearch')}
            className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          />
        </label>
      </div>

      {status === 'loading' && (
        <p role="status" className="py-8 text-center text-sm text-gray-600 dark:text-gray-300">{t('home.loading')}</p>
      )}
      {status === 'unavailable' && records.length === 0 && (
        <p role="status" className="py-8 text-center text-sm text-amber-800 dark:text-amber-300">{t('home.localHistoryUnavailable')}</p>
      )}
      {status === 'error' && (
        <p role="status" className="mb-4 text-sm text-amber-800 dark:text-amber-300">{t('home.localHistoryError')}</p>
      )}
      {deleteFailed && (
        <p role="status" className="mb-4 text-sm text-amber-800 dark:text-amber-300">{t('home.localHistoryDeleteFailed')}</p>
      )}
      {records.length === 0 && status === 'ready' && (
        <p className="py-8 text-center text-sm text-gray-600 dark:text-gray-300">{t('home.localHistoryEmpty')}</p>
      )}
      {query.trim().length > 0 && filtered.length === 0 && records.length > 0 && status !== 'loading' && (
        <p className="py-8 text-center text-sm text-gray-600 dark:text-gray-300">{t('home.localHistoryNoMatches')}</p>
      )}

      {filtered.length > 0 && (
        <>
          <ul className="grid max-h-[32rem] grid-cols-1 gap-4 overflow-y-auto md:grid-cols-2 lg:grid-cols-3">
            {paged.page.map((record) => (
              <li key={record.id} className="rounded-lg border border-divider bg-content1 p-3 dark:border-white/10 dark:bg-white/[0.06]">
                <h4 className="truncate font-medium text-gray-900 dark:text-white">{record.filename}</h4>
                <p className="mt-1 text-xs text-gray-600 dark:text-gray-300">{record.analyzedAt}</p>
                <p className="mt-1 text-xs text-gray-600 dark:text-gray-300">
                  {record.beatModel} · {record.chordModel}
                  {record.durationSeconds !== null ? ` · ${formatDuration(record.durationSeconds)}` : ''}
                </p>
                {recordedFacts(record).length > 0 && (
                  <p className="mt-1 text-xs text-gray-700 dark:text-gray-200">{recordedFacts(record).join(' · ')}</p>
                )}
                {record.chordPreview.length > 0 && (
                  <p className="mt-2 text-sm text-gray-800 dark:text-gray-100">{record.chordPreview.join(' · ')}</p>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <Link
                    href={`/analyze/history/${record.id}`}
                    className="rounded-md bg-blue-600 px-3 py-1 text-sm text-white"
                  >
                    {t('home.localHistoryOpen')}
                  </Link>
                  {pendingDeleteId === record.id ? (
                    <>
                      <button
                        type="button"
                        className="rounded-md border border-red-700 px-3 py-1 text-sm text-red-700"
                        onClick={() => { void confirmDelete(record.id); }}
                      >
                        {t('home.localHistoryConfirmYes')}
                      </button>
                      <button
                        type="button"
                        className="rounded-md border border-gray-400 px-3 py-1 text-sm"
                        onClick={() => setPendingDeleteId(null)}
                      >
                        {t('home.localHistoryCancel')}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="rounded-md border border-gray-400 px-3 py-1 text-sm"
                      aria-label={`${t('home.localHistoryDelete')} ${record.filename}`}
                      onClick={() => {
                        setDeleteFailed(false);
                        setPendingDeleteId(record.id);
                      }}
                    >
                      {t('home.localHistoryDelete')}
                    </button>
                  )}
                </div>
                {pendingDeleteId === record.id && (
                  <p className="mt-2 text-xs text-gray-700 dark:text-gray-200">{t('home.localHistoryConfirm')}</p>
                )}
              </li>
            ))}
          </ul>
          {paged.pageCount > 1 && (
            <div className="mt-4 flex items-center justify-between gap-3">
              <button
                type="button"
                className="rounded-md border border-gray-400 px-3 py-1 text-sm disabled:opacity-40"
                disabled={visiblePage === 0}
                onClick={() => setPageIndex(visiblePage - 1)}
              >
                {t('home.localHistoryPrevious')}
              </button>
              <p className="text-sm text-gray-700 dark:text-gray-200">
                {t('home.localHistoryPage', { page: visiblePage + 1, pages: paged.pageCount })}
              </p>
              <button
                type="button"
                className="rounded-md border border-gray-400 px-3 py-1 text-sm disabled:opacity-40"
                disabled={visiblePage >= paged.pageCount - 1}
                onClick={() => setPageIndex(visiblePage + 1)}
              >
                {t('home.localHistoryNext')}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
