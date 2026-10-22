'use client';

import React, { useEffect, useRef } from 'react';
import { addToast } from '@heroui/react';
import { mergeToastClassNames } from '@/utils/toastStyles';
import { useI18n } from '@/i18n/I18nProvider';

interface ExtractionNotificationProps {
  isVisible: boolean;
  fromCache: boolean;
  onDismiss: () => void;
  onRefresh: () => void;
}

const ExtractionNotification: React.FC<ExtractionNotificationProps> = ({
  isVisible,
  fromCache,
  onDismiss,
}) => {
  const { t } = useI18n();
  const hasShownRef = useRef(false);

  useEffect(() => {
    if (isVisible && !hasShownRef.current) {
      hasShownRef.current = true;

      const accentClass = fromCache
        ? 'text-primary-600 dark:text-blue-400'
        : 'text-success-600 dark:text-success-400';

      addToast({
        title: fromCache ? t('analyze.cacheLoadedTitle') : t('analyze.extractedTitle'),
        description: fromCache
          ? t('analyze.cacheLoadedBody')
          : t('analyze.extractedBody'),
        color: 'default',
        timeout: 5000, // Auto-dismiss after 5 seconds (matching original)
        shouldShowTimeoutProgress: true,
        classNames: mergeToastClassNames({
          icon: accentClass,
          title: accentClass,
        }),
        onClose: onDismiss,
      });

      if (!fromCache) {
        addToast({
          title: t('analyze.readyTitle'),
          description: t('analyze.readyBody', { action: t('analyze.actionRun') }),
          color: 'default',
          timeout: 7000,
          shouldShowTimeoutProgress: true,
          classNames: mergeToastClassNames({
            icon: 'text-primary-600 dark:text-blue-400',
            title: 'text-primary-600 dark:text-blue-400',
          }),
        });
      }
    }

    if (!isVisible) {
      hasShownRef.current = false;
    }
  }, [fromCache, isVisible, onDismiss, t]);

  return null;
};

export default ExtractionNotification;
