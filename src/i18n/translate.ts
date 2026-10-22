import { catalog, type MessageKey } from '@/i18n/catalog';
import type { AppLocale } from '@/i18n/locales';

export type TranslateVars = Record<string, string | number>;

export type Translator = (key: MessageKey, vars?: TranslateVars) => string;

export function translate(locale: AppLocale, key: MessageKey, vars?: TranslateVars): string {
  const entry = catalog[key];
  const template = entry[locale] || entry['en-US'];
  if (!vars) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}

export function createTranslator(locale: AppLocale): Translator {
  return (key, vars) => translate(locale, key, vars);
}

export const englishTranslator = createTranslator('en-US');
