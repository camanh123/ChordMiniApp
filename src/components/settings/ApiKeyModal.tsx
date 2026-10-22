'use client';

import React, { useState, useEffect } from 'react';
import { useTheme } from '@/contexts/ThemeContext';
import { ApiKeyModalProps, API_KEY_HELP_URLS } from '@/types/apiKeyTypes';
import { HiLightBulb, HiGift, HiInformationCircle } from 'react-icons/hi2';
import { useI18n } from '@/i18n/I18nProvider';

const SEGMENTATION_ACCESS_REQUEST_EMAIL = process.env.NEXT_PUBLIC_SEGMENTATION_ACCESS_REQUEST_EMAIL || 'phantrongnghia510@gmail.com';

const ApiKeyModal: React.FC<ApiKeyModalProps> = ({
  isOpen,
  onClose,
  service,
  required = false,
  onKeySubmitted,
  currentError
}) => {
  const { theme } = useTheme();
  const { t } = useI18n();
  const [apiKey, setApiKey] = useState('');
  const [isValidating, setIsValidating] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state when modal opens/closes
  useEffect(() => {
    if (isOpen) {
      setApiKey('');
      setError(null);
      setShowKey(false);
    }
  }, [isOpen]);

  // Update error from props
  useEffect(() => {
    setError(currentError || null);
  }, [currentError]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!apiKey.trim()) {
      setError(service === 'songformerAccess' ? t('settings.enterCode') : t('settings.enterKey'));
      return;
    }

    setIsValidating(true);
    setError(null);

    try {
      await onKeySubmitted(apiKey.trim());
      // Modal will be closed by parent component on success
    } catch (error) {
      const fallbackMessage = service === 'songformerAccess'
        ? t('settings.validateCodeFailed')
        : t('settings.validateKeyFailed');
      setError(error instanceof Error ? error.message : fallbackMessage);
    } finally {
      setIsValidating(false);
    }
  };

  const getServiceInfo = () => {
    switch (service) {
      case 'musicAi':
        return {
          name: 'Music.ai',
          description: t('settings.musicAiDescription'),
          features: 'lyrics transcription and chord generation',
          helpUrl: API_KEY_HELP_URLS.MUSIC_AI,
          placeholder: t('settings.musicAiPlaceholder'),
          keyFormat: t('settings.musicAiFormat'),
          freeInfo: t('settings.musicAiFree'),
          freeIcon: <HiLightBulb className="w-3 h-3 mt-0.5 flex-shrink-0" />,
          fieldLabel: t('settings.apiKeyLabel'),
          submitLabel: t('settings.saveApiKey'),
          helpLabel: t('settings.musicAiHelp'),
          storedNote: t('settings.storedKey'),
        };
      case 'gemini':
        return {
          name: 'Gemini',
          description: t('settings.geminiDescription'),
          features: 'lyrics translation',
          helpUrl: API_KEY_HELP_URLS.GEMINI,
          placeholder: t('settings.geminiPlaceholder'),
          keyFormat: t('settings.geminiFormat'),
          freeInfo: t('settings.geminiFree'),
          freeIcon: <HiGift className="w-3 h-3 mt-0.5 flex-shrink-0" />,
          fieldLabel: t('settings.apiKeyLabel'),
          submitLabel: t('settings.saveApiKey'),
          helpLabel: t('settings.geminiHelp'),
          storedNote: t('settings.storedKey'),
        };
      case 'songformerAccess':
        return {
          name: t('settings.segmentation'),
          description: t('settings.songformerDescription'),
          features: 'new SongFormer segmentation requests',
          helpUrl: `mailto:${SEGMENTATION_ACCESS_REQUEST_EMAIL}`,
          placeholder: t('settings.songformerPlaceholder'),
          keyFormat: t('settings.songformerFormat'),
          freeInfo: t('settings.songformerFree', { email: SEGMENTATION_ACCESS_REQUEST_EMAIL }),
          freeIcon: <HiInformationCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />,
          fieldLabel: t('settings.accessCode'),
          submitLabel: t('settings.saveAccessCode'),
          helpLabel: t('settings.requestCode'),
          storedNote: t('settings.storedCode'),
        };
      default:
        return {
          name: 'API',
          description: t('settings.genericDescription'),
          features: 'advanced features',
          helpUrl: '#',
          placeholder: t('settings.genericPlaceholder'),
          keyFormat: '',
          freeInfo: '',
          freeIcon: null,
          fieldLabel: t('settings.apiKeyLabel'),
          submitLabel: t('settings.saveApiKey'),
          helpLabel: t('settings.genericHelp'),
          storedNote: t('settings.storedKey'),
        };
    }
  };

  const serviceInfo = getServiceInfo();

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className={`
        max-w-md w-full rounded-lg shadow-xl
        ${theme === 'dark' 
          ? 'bg-content-bg border border-gray-600' 
          : 'bg-white border border-gray-200'
        }
      `}>
        {/* Header */}
        <div className="p-6 border-b border-gray-200 dark:border-gray-600">
          <div className="flex items-center justify-between">
            <h2 className={`text-xl font-semibold ${
              theme === 'dark' ? 'text-white' : 'text-gray-900'
            }`}>
              {t('settings.keyDialog', {
                name: serviceInfo.name,
                field: serviceInfo.fieldLabel,
                state: required ? t('settings.required') : t('settings.setupWord'),
              })}
            </h2>
            {!required && (
              <button
                onClick={onClose}
                aria-label={t('settings.closeDialog')}
                className={`p-1 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 ${
                  theme === 'dark' ? 'text-gray-400' : 'text-gray-500'
                }`}
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>

        {/* Content */}
        <div className="p-6">
          {/* Info Section */}
          <div className={`mb-6 p-4 rounded-lg ${
            theme === 'dark' ? 'bg-blue-900/20 border border-blue-800' : 'bg-blue-50 border border-blue-200'
          }`}>
            <div className="flex items-start space-x-3">
              <HiInformationCircle className="w-5 h-5 text-blue-500 mt-0.5 flex-shrink-0" />
              <div>
                <p className={`text-sm ${theme === 'dark' ? 'text-blue-200' : 'text-blue-800'}`}>
                  {serviceInfo.description}
                </p>
                {serviceInfo.freeInfo && (
                  <div className={`text-sm mt-2 font-medium ${theme === 'dark' ? 'text-green-300' : 'text-green-700'} flex items-start gap-2`}>
                    {serviceInfo.freeIcon}
                    <span>{serviceInfo.freeInfo}</span>
                  </div>
                )}
                <p className={`text-xs mt-1 ${theme === 'dark' ? 'text-blue-300' : 'text-blue-600'}`}>
                  {serviceInfo.storedNote}
                </p>
              </div>
            </div>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className={`block text-sm font-medium mb-2 ${
                theme === 'dark' ? 'text-gray-200' : 'text-gray-700'
              }`}>
                {serviceInfo.fieldLabel}
              </label>
              <div className="relative">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={serviceInfo.placeholder}
                  className={`
                    w-full px-3 py-2 pr-10 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500
                    ${theme === 'dark' 
                      ? 'bg-gray-700 border-gray-600 text-white placeholder-gray-400' 
                      : 'bg-white border-gray-300 text-gray-900 placeholder-gray-500'
                    }
                  `}
                  disabled={isValidating}
                />
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  aria-label={showKey ? t('settings.hideSecret') : t('settings.showSecret')}
                  className={`absolute right-2 top-2 p-1 ${
                    theme === 'dark' ? 'text-gray-400 hover:text-gray-300' : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {showKey ? (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L3 3m6.878 6.878L21 21" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    </svg>
                  )}
                </button>
              </div>
              {serviceInfo.keyFormat && (
                <p className={`text-xs mt-1 ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>
                  {serviceInfo.keyFormat}
                </p>
              )}
            </div>

            {/* Error Display */}
            {error && (
              <div className={`p-3 rounded-md ${
                theme === 'dark' ? 'bg-red-900/20 border border-red-800' : 'bg-red-50 border border-red-200'
              }`}>
                <p className={`text-sm ${theme === 'dark' ? 'text-red-200' : 'text-red-800'}`}>
                  {error}
                </p>
              </div>
            )}

            {/* Actions */}
            <div className="flex space-x-3 pt-4">
              <button
                type="submit"
                disabled={isValidating || !apiKey.trim()}
                className={`
                  flex-1 px-4 py-2 rounded-md font-medium transition-colors
                  ${isValidating || !apiKey.trim()
                    ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                    : 'bg-blue-600 hover:bg-blue-700 text-white'
                  }
                `}
              >
                {isValidating ? (
                  <span className="flex items-center justify-center">
                    <svg className="animate-spin -ml-1 mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    {t('settings.validating')}
                  </span>
                ) : (
                  serviceInfo.submitLabel
                )}
              </button>
              
              {!required && (
                <button
                  type="button"
                  onClick={onClose}
                  className={`
                    px-4 py-2 rounded-md font-medium transition-colors
                    ${theme === 'dark' 
                      ? 'bg-gray-700 hover:bg-gray-600 text-gray-200' 
                      : 'bg-gray-200 hover:bg-gray-300 text-gray-700'
                    }
                  `}
                >
                  {t('settings.cancel')}
                </button>
              )}
            </div>
          </form>

          {/* Help Link */}
          <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-600">
            <a
              href={serviceInfo.helpUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={`text-sm hover:underline ${
                theme === 'dark' ? 'text-blue-400' : 'text-blue-600'
              }`}
            >
              {serviceInfo.helpLabel}
            </a>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ApiKeyModal;
