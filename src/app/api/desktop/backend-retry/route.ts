import { NextResponse } from 'next/server';
import { requestBackendRetry } from '@/desktop/localBackend';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Asks the Electron main process to try the local analysis service again.
 * The renderer cannot choose an executable, a directory, or a port. The
 * desktop cookie gate still applies to this POST.
 */
export async function POST() {
  if (process.env.CHORDMINI_DESKTOP_MODE !== '1') {
    return NextResponse.json({ ok: false }, { status: 404 });
  }

  const wrote = requestBackendRetry(
    process.env.CHORDMINI_BACKEND_RETRY_FILE ?? '',
    process.env.CHORDMINI_BACKEND_RETRY_TOKEN ?? '',
  );
  if (!wrote) {
    return NextResponse.json({ ok: false }, { status: 404 });
  }

  return NextResponse.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
}
