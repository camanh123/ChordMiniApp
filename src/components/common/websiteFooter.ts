import { getHydrationSafeRuntime } from '@/runtime/appRuntime';

/**
 * The desktop server sets CHORDMINI_DESKTOP_MODE before it renders and writes
 * the same choice onto the document. The footer is absent from that HTML.
 * Web and PWA renders leave it in. A public env var compiled into an older
 * client bundle is not required.
 */
export function shouldRenderWebsiteFooter(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return getHydrationSafeRuntime(env) !== 'electron';
}
