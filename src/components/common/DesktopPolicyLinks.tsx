'use client';

import Link from 'next/link';
import { useI18n } from '@/i18n/I18nProvider';
import { useAppRuntime } from '@/runtime/useAppRuntime';

/**
 * Privacy policy and terms stay reachable from Settings when the website
 * footer is not mounted. The website settings page renders nothing here.
 */
export default function DesktopPolicyLinks() {
  const { runtime, hydrated } = useAppRuntime();
  const { t } = useI18n();

  if (!hydrated || runtime !== 'electron') {
    return null;
  }

  return (
    <nav aria-label={t('footer.legal')} className="flex flex-wrap gap-4 border-t border-gray-200 pt-4 text-sm dark:border-gray-700">
      <Link
        href="/privacy"
        className="text-gray-600 underline decoration-gray-300 underline-offset-2 hover:text-blue-600 dark:text-gray-300 dark:hover:text-blue-400"
      >
        {t('footer.privacy')}
      </Link>
      <Link
        href="/terms"
        className="text-gray-600 underline decoration-gray-300 underline-offset-2 hover:text-blue-600 dark:text-gray-300 dark:hover:text-blue-400"
      >
        {t('footer.terms')}
      </Link>
    </nav>
  );
}
