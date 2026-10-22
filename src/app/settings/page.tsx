'use client';

import React from 'react';
import { useTheme } from '@/contexts/ThemeContext';
import { useApiKeys } from '@/hooks/settings/useApiKeys';
import ApiKeySettings from '@/components/settings/ApiKeySettings';
import Navigation from '@/components/common/Navigation';
import { Card, CardBody, Switch, Tabs, Tab, Spinner, Divider } from '@heroui/react';
import { FiSettings, FiKey, FiLock, FiMoon, FiShield, FiDatabase, FiBarChart2, FiGlobe } from 'react-icons/fi';
import { ApiCredentialService } from '@/types/apiKeyTypes';
import { useI18n } from '@/i18n/I18nProvider';
import { APP_LOCALES, LOCALE_LABELS } from '@/i18n/locales';

export default function SettingsPage() {
  const { t, locale, setLocale } = useI18n();
  const { theme, toggleTheme } = useTheme();
  const {
    apiKeyStatus,
    isLoading,
    setApiKey,
    removeApiKey,
    refreshApiKeyStatus,
    isEncryptionSupported
  } = useApiKeys();

  const handleApiKeyUpdate = async (service: ApiCredentialService, key: string | null) => {
    try {
      if (key) {
        const validation = await setApiKey(service, key);
        if (!validation.isValid) {
          throw new Error(validation.error || 'Invalid API key');
        }
      } else {
        await removeApiKey(service);
      }
      await refreshApiKeyStatus();
    } catch (error) {
      console.error('Failed to update API key:', error);
      throw error;
    }
  };

  if (!isEncryptionSupported()) {
    return (
      <div className="min-h-screen bg-main-bg">
        <Navigation />
        <div className="container mx-auto px-4 py-8">
          <Card className="max-w-2xl mx-auto" shadow="sm">
            <CardBody className="gap-2">
              <h1 className="text-xl font-bold text-danger">{t('settings.encryptionTitle')}</h1>
              <p className="text-sm text-danger-600 dark:text-danger-400">
                {t('settings.encryptionBody')}
              </p>
            </CardBody>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen dark:bg-dark-bg">
      <Navigation />
      <div className="container mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2 text-foreground">{t('settings.title')}</h1>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {t('settings.subtitle')}
          </p>
        </div>

        <div className="max-w-4xl mx-auto">
          <Tabs
            defaultSelectedKey="general"
            variant="underlined"
            color="success"
            classNames={{
              tabList: "gap-6 w-full relative rounded-none p-0 border-b border-divider",
              cursor: "w-full bg-success",
              tab: "max-w-fit px-0 h-12 group",
              tabContent: "text-gray-600 dark:text-gray-400 group-data-[selected=true]:text-success group-data-[selected=true]:font-semibold"
            }}
          >
            {/* General Tab */}
            <Tab
              key="general"
              title={
                <div className="flex items-center space-x-2">
                  <FiSettings className="w-4 h-4" />
                  <span>{t('settings.general')}</span>
                </div>
              }
            >
              <div className="space-y-4 pt-1">
                <Card shadow="sm" className="border border-gray-200 dark:border-gray-700">
                  <CardBody className="p-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-primary-50 dark:bg-primary-900/20">
                          <FiGlobe className="w-4 h-4 text-blue" />
                        </div>
                        <div>
                          <h4 className="text-sm font-semibold text-gray-900 dark:text-white">{t('settings.language')}</h4>
                          <p className="text-xs text-gray-500 dark:text-gray-400">{t('settings.languageHelp')}</p>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('settings.language')}>
                        {APP_LOCALES.map((code) => (
                          <button
                            key={code}
                            type="button"
                            role="radio"
                            aria-checked={locale === code}
                            onClick={() => setLocale(code)}
                            className={`rounded-full border px-3 py-1 text-sm ${
                              locale === code
                                ? 'border-blue-600 bg-blue-600 text-white'
                                : 'border-gray-300 text-gray-800 dark:border-gray-600 dark:text-gray-100'
                            }`}
                          >
                            {LOCALE_LABELS[code]}
                          </button>
                        ))}
                      </div>
                    </div>
                  </CardBody>
                </Card>
                <Card shadow="sm" className="border border-gray-200 dark:border-gray-700">
                  <CardBody className="p-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-primary-50 dark:bg-primary-900/20">
                          <FiMoon className="w-4 h-4 text-blue" />
                        </div>
                        <div>
                          <h4 className="text-sm font-semibold text-gray-900 dark:text-white">{t('settings.darkMode')}</h4>
                          <p className="text-xs text-gray-500 dark:text-gray-400">{t('settings.darkModeHelp')}</p>
                        </div>
                      </div>
                      <Switch
                        aria-label={t('settings.darkMode')}
                        isSelected={theme === 'dark'}
                        onValueChange={toggleTheme}
                        color="primary"
                        size="sm"
                      />
                    </div>
                  </CardBody>
                </Card>
              </div>
            </Tab>

            {/* API Keys Tab */}
            <Tab
              key="apiKeys"
              title={
                <div className="flex items-center space-x-2">
                  <FiKey className="w-4 h-4" />
                  <span>{t('settings.apiKeys')}</span>
                </div>
              }
            >
              {isLoading ? (
                <Card shadow="sm" className="border border-gray-200 dark:border-gray-700">
                  <CardBody>
                    <div className="flex items-center justify-center py-8">
                      <Spinner color="primary" size="sm" />
                      <span className="ml-3 text-sm text-gray-500 dark:text-gray-400">
                        {t('settings.loadingKeys')}
                      </span>
                    </div>
                  </CardBody>
                </Card>
              ) : (
                <div className="pt-1">
                  <ApiKeySettings
                    onApiKeyUpdate={handleApiKeyUpdate}
                    apiKeyStatus={apiKeyStatus}
                  />
                </div>
              )}
            </Tab>

            {/* Privacy Tab */}
            <Tab
              key="privacy"
              title={
                <div className="flex items-center space-x-2">
                  <FiLock className="w-4 h-4" />
                  <span>{t('settings.privacy')}</span>
                </div>
              }
            >
              <div className="space-y-4 pt-1">
                <Card shadow="sm" className="border border-gray-200 dark:border-gray-700">
                  <CardBody className="p-4 gap-4">
                    <PrivacyItem
                      icon={<FiShield className="w-4 h-4 text-success" />}
                      iconBg="bg-success-50 dark:bg-success-900/20"
                      title={t('settings.apiStorage')}
                      description={t('settings.apiStorageHelp')}
                    />
                    <Divider />
                    <PrivacyItem
                      icon={<FiDatabase className="w-4 h-4 text-blue" />}
                      iconBg="bg-primary-50 dark:bg-primary-900/20"
                      title={t('settings.cache')}
                      description={t('settings.cacheHelp')}
                    />
                    <Divider />
                    <PrivacyItem
                      icon={<FiBarChart2 className="w-4 h-4 text-warning" />}
                      iconBg="bg-warning-50 dark:bg-warning-900/20"
                      title={t('settings.analytics')}
                      description={t('settings.analyticsHelp')}
                    />
                  </CardBody>
                </Card>
              </div>
            </Tab>
          </Tabs>
        </div>
      </div>
    </div>
  );
}

function PrivacyItem({ icon, iconBg, title, description }: {
  icon: React.ReactNode;
  iconBg: string;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className={`p-2 rounded-lg shrink-0 ${iconBg}`}>
        {icon}
      </div>
      <div>
        <h4 className="text-sm font-semibold text-gray-900 dark:text-white">{title}</h4>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{description}</p>
      </div>
    </div>
  );
}
