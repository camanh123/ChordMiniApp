import { NextResponse } from 'next/server';

export const DESKTOP_EXTRACTION_DENIED_CODE = 'DESKTOP_EXTRACTION_DENIED';

/**
 * Desktop mode refuses YouTube audio extraction before any downloader,
 * cache write, or media fetch. Web and PWA processes leave the flag unset.
 */
export function isDesktopExtractionBlocked(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CHORDMINI_DESKTOP_MODE === '1';
}

export function desktopExtractionDenied(
  env: NodeJS.ProcessEnv = process.env,
): NextResponse | null {
  if (!isDesktopExtractionBlocked(env)) return null;
  return NextResponse.json(
    {
      success: false,
      available: false,
      code: DESKTOP_EXTRACTION_DENIED_CODE,
      error: 'YouTube audio extraction is unavailable in the desktop app.',
    },
    { status: 403, headers: { 'cache-control': 'no-store' } },
  );
}
