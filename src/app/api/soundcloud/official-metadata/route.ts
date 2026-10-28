import { NextRequest, NextResponse } from 'next/server';
import { loadOfficialSoundCloudMetadata } from '@/services/soundcloud/officialSoundCloudMetadata';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Title, author, and official player URL for one validated SoundCloud track.
 * The response is playback metadata. It does not extract audio or run inference.
 */
export async function GET(request: NextRequest) {
  const raw = new URL(request.url).searchParams.get('url') ?? '';
  const loaded = await loadOfficialSoundCloudMetadata(raw, fetch);
  if (!loaded.ok) {
    return NextResponse.json(
      { success: false, inference: false, error: loaded.error },
      { status: loaded.status, headers: { 'cache-control': 'no-store' } },
    );
  }
  return NextResponse.json(
    { success: true, ...loaded.metadata },
    { headers: { 'cache-control': 'no-store' } },
  );
}
