'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { useI18n } from '@/i18n/I18nProvider';
import {
  formatDiagnosticElapsed,
  getAnalysisDiagnosticsSnapshot,
  refreshDiagnosticClock,
  subscribeAnalysisDiagnostics,
} from '@/services/audio/analysisDiagnostics';
import { pollVerifiedBackendStatus } from '@/services/audio/backendReadiness';
import { desktopShellRequested } from '@/runtime/appRuntime';

/**
 * Compact session log beside the source controls.
 * Elapsed time is a clock reading. It is not a progress percentage.
 */
export default function AnalysisDiagnosticsPanel() {
  const { t } = useI18n();
  const snapshot = useSyncExternalStore(
    subscribeAnalysisDiagnostics,
    getAnalysisDiagnosticsSnapshot,
    getAnalysisDiagnosticsSnapshot,
  );

  useEffect(() => {
    if (!snapshot.sessionActive) return undefined;
    const timer = window.setInterval(() => refreshDiagnosticClock(), 500);
    return () => window.clearInterval(timer);
  }, [snapshot.sessionActive]);

  useEffect(() => {
    if (!desktopShellRequested()) return undefined;
    const sessionId = getAnalysisDiagnosticsSnapshot().currentSessionId;
    const controller = new AbortController();
    void pollVerifiedBackendStatus({ sessionId, signal: controller.signal });
    return () => controller.abort();
  }, []);

  const stateLabel = snapshot.sessionState
    ? t(`diagnostics.state.${snapshot.sessionState}`)
    : t('diagnostics.noSession');

  return (
    <details
      className="mb-3 rounded-md border border-gray-200 px-3 py-2 text-xs text-gray-700 dark:border-gray-700 dark:text-gray-300"
      data-testid="analysis-diagnostics"
    >
      <summary className="cursor-pointer font-medium">
        {t('diagnostics.title')}
        {' · '}
        {stateLabel}
        {snapshot.sessionActive ? ` · ${t('diagnostics.elapsed', { time: formatDiagnosticElapsed(snapshot.elapsedMs) })}` : ''}
      </summary>
      <p className="mt-2" data-testid="diagnostics-model-limitation">
        {t('diagnostics.modelLimitation')}
      </p>
      {snapshot.cancellationUnconfirmed ? (
        <p className="mt-1" data-testid="diagnostics-cancellation-unconfirmed">
          {t('diagnostics.cancellationUnconfirmed')}
        </p>
      ) : null}
      {snapshot.events.length === 0 ? (
        <p className="mt-2">{t('diagnostics.empty')}</p>
      ) : (
        <ol className="mt-2 space-y-1">
          {snapshot.events.map((event) => {
            const current = snapshot.currentSessionId !== null && event.sessionId === snapshot.currentSessionId;
            const staleCompletion = event.code === 'ANALYSIS_COMPLETED' && !event.applied;
            const earlier = (snapshot.currentSessionId !== null && !current) || staleCompletion;
            return (
              <li key={event.id} data-testid="diagnostic-event" data-code={event.code} data-current={current ? 'true' : 'false'}>
                <span className="font-medium">{event.code}</span>
                {' · '}
                <span>{event.sessionId}</span>
                {' · '}
                <span>{t('diagnostics.elapsed', { time: formatDiagnosticElapsed(event.elapsedMs) })}</span>
                {event.detail ? ` · ${event.detail}` : ''}
                {earlier ? ` · ${t('diagnostics.earlierSession')}` : ''}
              </li>
            );
          })}
        </ol>
      )}
    </details>
  );
}
