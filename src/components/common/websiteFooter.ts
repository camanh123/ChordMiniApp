import { getHydrationSafeRuntime } from '@/runtime/appRuntime';

/**
 * The Windows server sets NEXT_PUBLIC_APP_RUNTIME=electron before it renders.
 * That value is read while the document is produced, so the footer is absent
 * from the HTML the Electron window paints. Web and PWA renders leave it in.
 */
export function shouldRenderWebsiteFooter(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return getHydrationSafeRuntime(env) !== 'electron';
}
