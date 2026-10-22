export {
  APP_LOCALES,
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  LOCALE_LABELS,
  LOCALE_STORAGE_KEY,
  applyLocaleToDocument,
  isAppLocale,
  localeCookieAssignment,
  readLocaleFromCookieHeader,
  writeLocalePreference,
  type AppLocale,
} from '@/i18n/locales';
export { catalog, type MessageKey } from '@/i18n/catalog';
export { I18nProvider, useI18n } from '@/i18n/I18nProvider';
export {
  createTranslator,
  englishTranslator,
  translate,
  type Translator,
  type TranslateVars,
} from '@/i18n/translate';
