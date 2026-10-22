export const APP_LOCALES = ['vi-VN', 'en-US', 'zh-CN', 'ja-JP', 'ko-KR'] as const;

export type AppLocale = (typeof APP_LOCALES)[number];

export const DEFAULT_LOCALE: AppLocale = 'vi-VN';

export const LOCALE_COOKIE = 'chordmini_locale';

export const LOCALE_STORAGE_KEY = 'chordmini_locale';

export const LOCALE_MAX_AGE_SECONDS = 60 * 60 * 24 * 400;

export const LOCALE_LABELS: Record<AppLocale, string> = {
  'vi-VN': 'Tiếng Việt',
  'en-US': 'English',
  'zh-CN': '简体中文',
  'ja-JP': '日本語',
  'ko-KR': '한국어',
};

export function isAppLocale(value: string | null | undefined): value is AppLocale {
  return APP_LOCALES.includes(value as AppLocale);
}

export function readLocaleFromCookieHeader(header: string | null | undefined): AppLocale | null {
  if (!header) {
    return null;
  }

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    if (name !== LOCALE_COOKIE) {
      continue;
    }
    const raw = part.slice(separator + 1).trim();
    try {
      const value = decodeURIComponent(raw);
      return isAppLocale(value) ? value : null;
    } catch {
      return null;
    }
  }

  return null;
}

export function localeCookieAssignment(locale: AppLocale): string {
  return `${LOCALE_COOKIE}=${encodeURIComponent(locale)}; Path=/; Max-Age=${LOCALE_MAX_AGE_SECONDS}; SameSite=Strict`;
}

export function writeLocalePreference(locale: AppLocale): void {
  if (typeof document === 'undefined') {
    return;
  }
  document.cookie = localeCookieAssignment(locale);
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Private mode can reject storage. The cookie still survives a new port.
  }
}

export function applyLocaleToDocument(locale: AppLocale): void {
  if (typeof document === 'undefined') {
    return;
  }
  document.documentElement.lang = locale;
  document.documentElement.dataset.locale = locale;
}
