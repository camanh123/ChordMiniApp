import { NextResponse } from 'next/server';
import { practiceInferenceNotice } from '@/server/practiceInferenceNotice';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET() {
  return NextResponse.json(
    { notice: practiceInferenceNotice(process.env) },
    {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  );
}
