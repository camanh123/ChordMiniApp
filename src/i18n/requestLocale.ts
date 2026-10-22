import { cookies } from 'next/headers';
import { DEFAULT_LOCALE, isAppLocale, LOCALE_COOKIE, type AppLocale } from '@/i18n/locales';

export async function getRequestLocale(): Promise<AppLocale> {
  const store = await cookies();
  const value = store.get(LOCALE_COOKIE)?.value;
  return isAppLocale(value) ? value : DEFAULT_LOCALE;
}
