import { NextResponse } from 'next/server';
import { readBackendStatus } from '@/desktop/localBackend';
import { toPublicBackendReadiness, unverifiedReadiness } from '@/services/audio/backendReadiness';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Sanitized supervisor status for the in-app diagnostics panel.
 * The desktop cookie gate remains on the proxy. This response never includes
 * paths, cookies, tokens, or model file locations, and it never reports
 * inference as verified.
 */
export async function GET() {
  if (process.env.CHORDMINI_DESKTOP_MODE !== '1') {
    return NextResponse.json(unverifiedReadiness('NOT_DESKTOP'), {
      status: 404,
      headers: { 'cache-control': 'no-store' },
    });
  }

  const status = readBackendStatus();
  const body = status ? toPublicBackendReadiness(status) : unverifiedReadiness('STATUS_UNVERIFIED');
  return NextResponse.json(body, { headers: { 'cache-control': 'no-store' } });
}
