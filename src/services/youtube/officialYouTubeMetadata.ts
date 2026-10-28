/**
 * Official YouTube oEmbed lookup.
 * The video id is interpolated into a fixed youtube.com URL. Callers cannot
 * supply a fetch target. This module does not request media bytes.
 */

const VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/;

export interface OfficialYouTubeMetadata {
  videoId: string;
  title: string;
  author: string;
  thumbnail: string;
  durationSeconds: null;
  source: 'youtube-oembed';
}

export function officialYouTubeOEmbedUrl(videoId: string): string | null {
  if (!VIDEO_ID.test(videoId)) return null;
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  return `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`;
}

export async function loadOfficialYouTubeMetadata(
  videoId: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; metadata: OfficialYouTubeMetadata } | { ok: false; status: 400 | 502; error: string }> {
  const url = officialYouTubeOEmbedUrl(videoId);
  if (!url) {
    return { ok: false, status: 400, error: 'Invalid YouTube video id' };
  }

  let response: Response;
  try {
    const init: RequestInit = {};
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      init.signal = AbortSignal.timeout(5000);
    }
    response = await fetchImpl(url, init);
  } catch {
    return { ok: false, status: 502, error: 'YouTube metadata was not available' };
  }
  if (!response.ok) {
    return { ok: false, status: 502, error: 'YouTube metadata was not available' };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, status: 502, error: 'YouTube metadata was not available' };
  }
  if (!payload || typeof payload !== 'object') {
    return { ok: false, status: 502, error: 'YouTube metadata was not available' };
  }
  const record = payload as Record<string, unknown>;
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  if (!title) {
    return { ok: false, status: 502, error: 'YouTube metadata was not available' };
  }
  const author = typeof record.author_name === 'string' && record.author_name.trim()
    ? record.author_name.trim()
    : 'Unknown';
  const thumbnail = typeof record.thumbnail_url === 'string' && record.thumbnail_url.startsWith('https://')
    ? record.thumbnail_url
    : `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;

  return {
    ok: true,
    metadata: {
      videoId,
      title,
      author,
      thumbnail,
      durationSeconds: null,
      source: 'youtube-oembed',
    },
  };
}
