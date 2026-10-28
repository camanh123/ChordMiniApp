import { NextRequest, NextResponse } from 'next/server';
import { loadOfficialYouTubeMetadata } from '@/services/youtube/officialYouTubeMetadata';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Title, author, and thumbnail for one validated video id.
 * Duration stays null because oEmbed does not provide it. The player clock
 * supplies duration after the embed loads. This route does not extract audio.
 */
export async function GET(request: NextRequest) {
  const videoId = new URL(request.url).searchParams.get('videoId') ?? '';
  const loaded = await loadOfficialYouTubeMetadata(videoId, fetch);
  if (!loaded.ok) {
    return NextResponse.json(
      { success: false, error: loaded.error },
      { status: loaded.status, headers: { 'cache-control': 'no-store' } },
    );
  }
  return NextResponse.json(
    { success: true, ...loaded.metadata },
    { headers: { 'cache-control': 'no-store' } },
  );
}
