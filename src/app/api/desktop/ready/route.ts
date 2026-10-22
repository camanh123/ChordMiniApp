import { NextResponse } from 'next/server';
import { computeReadyProof } from '@/desktop/readyProof';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Readiness probe for the Electron-owned Next.js process.
 * /api/health stays a Flask proxy and is intentionally not used here: a missing
 * remote analysis backend must not keep the desktop window from opening.
 * The proof is derived from a server-only token and the caller's nonce.
 */
export async function GET(request: Request) {
  if (process.env.CHORDMINI_DESKTOP_MODE !== '1') {
    return NextResponse.json({ ok: false }, { status: 404 });
  }

  const token = process.env.CHORDMINI_READY_TOKEN ?? '';
  const nonce = request.headers.get('x-chordmini-nonce');
  if (!token || !nonce) {
    return NextResponse.json({ ok: false }, { status: 401, headers: { 'cache-control': 'no-store' } });
  }

  return NextResponse.json(
    { ok: true, role: 'next-standalone' },
    {
      status: 200,
      headers: {
        'cache-control': 'no-store',
        'x-chordmini-proof': computeReadyProof(token, nonce),
      },
    },
  );
}
