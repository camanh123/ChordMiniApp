'use client';

import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import {
  applyLocaleToDocument,
  DEFAULT_LOCALE,
  isAppLocale,
  writeLocalePreference,
  type AppLocale,
} from '@/i18n/locales';
import { createTranslator, englishTranslator, type Translator } from '@/i18n/translate';

type I18nContextValue = {
  locale: AppLocale;
  setLocale: (locale: AppLocale) => void;
  t: Translator;
};

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({
  initialLocale,
  children,
}: {
  initialLocale?: string | null;
  children: React.ReactNode;
}) {
  const [locale, setLocaleState] = useState<AppLocale>(
    isAppLocale(initialLocale) ? initialLocale : DEFAULT_LOCALE,
  );

  const setLocale = useCallback((next: AppLocale) => {
    setLocaleState(next);
    writeLocalePreference(next);
    applyLocaleToDocument(next);
  }, []);

  const value = useMemo<I18nContextValue>(() => ({
    locale,
    setLocale,
    t: createTranslator(locale),
  }), [locale, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) {
    return {
      locale: 'en-US',
      setLocale: () => {},
      t: englishTranslator,
    };
  }
  return context;
}
