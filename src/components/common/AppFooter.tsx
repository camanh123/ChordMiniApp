'use client';

import Footer from '@/components/common/Footer';
import { useAppRuntime } from '@/runtime/useAppRuntime';

/**
 * Web and PWA sessions keep this mounted. The desktop server omits it before
 * HTML is sent. If a web document is later opened in Electron, the existing
 * runtime hook removes it after hydration.
 */
export default function AppFooter() {
  const { runtime, hydrated } = useAppRuntime();
  if (hydrated && runtime === 'electron') {
    return null;
  }
  return <Footer />;
}
