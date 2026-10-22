'use client';

import React from 'react';
import { useI18n } from '@/i18n/I18nProvider';
import type { LyricTextColors } from '@/components/lyrics/lyricsTheme';

interface NoLyricsMessageProps {
  error?: string;
  textColors: LyricTextColors;
}

/**
 * NoLyricsMessage component - extracted from LeadSheetDisplay
 * Handles error state rendering when no lyrics are available
 */
export const NoLyricsMessage: React.FC<NoLyricsMessageProps> = ({
  error,
  textColors
}) => {
  const { t } = useI18n();
  const rawError = error || '';
  const errorMessage = rawError || t('lyrics.defaultMissing');
  const isNoLyricsDetected = rawError.includes('No lyrics detected');

  return (
    <div className="lead-sheet-container p-4 rounded-lg shadow" style={{ backgroundColor: textColors.background }}>
      <div className="text-center p-8" style={{ color: textColors.unplayed }}>
        <div className="mb-4 text-xl font-semibold">{t('lyrics.unavailableHeading')}</div>
        <div className="text-base">{errorMessage}</div>
        <div className="mt-6 text-sm opacity-75">
          {t('lyrics.mayBeDue')}
          <ul className="list-disc list-inside mt-2 text-left max-w-md mx-auto">
            {isNoLyricsDetected && (
              <>
                <li className="font-medium">{t('lyrics.reasonNone')}</li>
                <li>{t('lyrics.reasonInstrumental')}</li>
                <li>{t('lyrics.reasonQuality')}</li>
              </>
            )}
            {!isNoLyricsDetected && (
              <>
                <li>{t('lyrics.reasonNone')}</li>
                <li>{t('lyrics.reasonService')}</li>
                <li>{t('lyrics.reasonInstrumental')}</li>
                <li>{t('lyrics.reasonQuality')}</li>
              </>
            )}
            {rawError.includes('API') && (
              <li className="text-red-500">{t('lyrics.reasonConnection')}</li>
            )}
            {rawError.includes('transcribe') && (
              <li className="text-red-500">{t('lyrics.reasonTranscription')}</li>
            )}
            {rawError.includes('connection') && (
              <li className="text-red-500">{t('lyrics.reasonNetwork')}</li>
            )}
            {rawError.includes('timeout') && (
              <li className="text-red-500">{t('lyrics.reasonTimeout')}</li>
            )}
            {rawError.includes('workflow') && (
              <li className="text-red-500">{t('lyrics.reasonWorkflowMissing')}</li>
            )}
            {rawError.includes('No workflows available') && (
              <li className="text-red-500">{t('lyrics.reasonNoWorkflows')}</li>
            )}
            {rawError.includes('not configured') && (
              <li className="text-red-500">{t('lyrics.reasonWrongWorkflow')}</li>
            )}
            {rawError.includes('Job failed') && (
              <li className="text-red-500">{t('lyrics.reasonJobFailed')}</li>
            )}
            {rawError.includes('Unknown error') && (
              <li className="text-red-500">{t('lyrics.reasonUnknownApi')}</li>
            )}
          </ul>
        </div>
        <div className="mt-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
          <p className="text-blue-700 font-medium">{t('lyrics.troubleshooting')}</p>
          <ul className="list-disc list-inside mt-2 text-left max-w-md mx-auto text-blue-600">
            {!isNoLyricsDetected ? (
              <>
                <li>{t('lyrics.tipKey')}</li>
                <li>{t('lyrics.tipWorkflow')}</li>
                <li>{t('lyrics.tipFile')}</li>
                <li>{t('lyrics.tipConsole')}</li>
              </>
            ) : (
              <>
                <li>{t('lyrics.tipVocals')}</li>
                <li>{t('lyrics.tipInstrumental')}</li>
                <li>{t('lyrics.tipLowQuality')}</li>
                <li>{t('lyrics.tipQuiet')}</li>
              </>
            )}
          </ul>
        </div>
      </div>
    </div>
  );
};

export default NoLyricsMessage;
