/**
 * One YouTube link parser for search and desktop playback.
 * A playlist without a video id is rejected. The video id is never used as an
 * audio address.
 */

const VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/;

export type YouTubeLinkKind = 'watch' | 'shorts' | 'youtu.be' | 'embed' | 'v' | 'bare-id';

export type ParsedYouTubeLink =
  | { ok: true; videoId: string; kind: YouTubeLinkKind }
  | { ok: false; reason: 'empty' | 'invalid' | 'playlist-only' };

function asUrl(input: string): URL | null {
  try {
    return new URL(input.includes('://') ? input : `https://${input}`);
  } catch {
    return null;
  }
}

function allowedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === 'youtu.be'
    || host === 'youtube.com'
    || host === 'www.youtube.com'
    || host === 'm.youtube.com'
    || host === 'music.youtube.com'
    || host === 'www.youtube-nocookie.com'
    || host === 'youtube-nocookie.com';
}

export function parseYouTubeLink(input: string): ParsedYouTubeLink {
  const raw = input.trim();
  if (!raw) return { ok: false, reason: 'empty' };
  if (VIDEO_ID.test(raw)) return { ok: true, videoId: raw, kind: 'bare-id' };

  const url = asUrl(raw);
  if (!url || !allowedHost(url.hostname)) return { ok: false, reason: 'invalid' };

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0] ?? '';
    return VIDEO_ID.test(id)
      ? { ok: true, videoId: id, kind: 'youtu.be' }
      : { ok: false, reason: 'invalid' };
  }

  const segments = url.pathname.split('/').filter(Boolean);
  const videoParam = url.searchParams.get('v');
  if ((segments[0] === 'playlist' || url.pathname === '/playlist') && !VIDEO_ID.test(videoParam ?? '')) {
    return { ok: false, reason: 'playlist-only' };
  }
  if (!videoParam && url.searchParams.has('list') && segments.length === 0) {
    return { ok: false, reason: 'playlist-only' };
  }

  const pathKind = segments[0];
  if (pathKind === 'shorts' || pathKind === 'embed' || pathKind === 'v' || pathKind === 'live') {
    const id = segments[1] ?? '';
    if (!VIDEO_ID.test(id)) return { ok: false, reason: 'invalid' };
    const kind: YouTubeLinkKind = pathKind === 'shorts'
      ? 'shorts'
      : pathKind === 'embed'
        ? 'embed'
        : 'v';
    return { ok: true, videoId: id, kind };
  }

  if (videoParam && VIDEO_ID.test(videoParam)) {
    return { ok: true, videoId: videoParam, kind: 'watch' };
  }
  if (url.searchParams.has('list')) return { ok: false, reason: 'playlist-only' };
  return { ok: false, reason: 'invalid' };
}

export function extractYouTubeVideoId(input: string): string | null {
  const parsed = parseYouTubeLink(input);
  return parsed.ok ? parsed.videoId : null;
}
