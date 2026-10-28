/**
 * Official SoundCloud oEmbed lookup.
 * The fetch target is the fixed soundcloud.com oEmbed endpoint. Callers cannot
 * choose another host. This module does not request media bytes.
 */

import {
  isSafeSoundCloudThumbnail,
  officialSoundCloudPlayerUrl,
  parseSoundCloudLink,
} from '@/services/soundcloud/soundCloudLink';

export interface OfficialSoundCloudMetadata {
  canonicalUrl: string;
  title: string;
  author: string;
  thumbnail: string | null;
  playerUrl: string;
  source: 'soundcloud-oembed';
  inference: false;
}

export function officialSoundCloudOEmbedUrl(canonicalUrl: string): string | null {
  const parsed = parseSoundCloudLink(canonicalUrl);
  if (!parsed.ok) return null;
  const endpoint = new URL('https://soundcloud.com/oembed');
  endpoint.searchParams.set('format', 'json');
  endpoint.searchParams.set('url', parsed.url);
  return endpoint.toString();
}

export async function loadOfficialSoundCloudMetadata(
  input: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; metadata: OfficialSoundCloudMetadata } | { ok: false; status: 400 | 502; error: string }> {
  const parsed = parseSoundCloudLink(input);
  if (!parsed.ok) {
    return { ok: false, status: 400, error: 'Invalid SoundCloud track link' };
  }
  const endpoint = officialSoundCloudOEmbedUrl(parsed.url);
  const playerUrl = officialSoundCloudPlayerUrl(parsed.url);
  if (!endpoint || !playerUrl || !endpoint.startsWith('https://soundcloud.com/oembed?')) {
    return { ok: false, status: 400, error: 'Invalid SoundCloud track link' };
  }

  let response: Response;
  try {
    const init: RequestInit = { cache: 'no-store' };
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      init.signal = AbortSignal.timeout(5000);
    }
    response = await fetchImpl(endpoint, init);
  } catch {
    return { ok: false, status: 502, error: 'SoundCloud metadata was not available' };
  }
  if (!response.ok) {
    return { ok: false, status: 502, error: 'SoundCloud metadata was not available' };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, status: 502, error: 'SoundCloud metadata was not available' };
  }
  if (!payload || typeof payload !== 'object') {
    return { ok: false, status: 502, error: 'SoundCloud metadata was not available' };
  }
  const record = payload as Record<string, unknown>;
  const title = typeof record.title === 'string' ? record.title.trim().slice(0, 200) : '';
  if (!title) {
    return { ok: false, status: 502, error: 'SoundCloud metadata was not available' };
  }
  const author = typeof record.author_name === 'string' && record.author_name.trim()
    ? record.author_name.trim().slice(0, 120)
    : 'SoundCloud';
  const thumbnail = typeof record.thumbnail_url === 'string' && isSafeSoundCloudThumbnail(record.thumbnail_url)
    ? record.thumbnail_url
    : null;

  return {
    ok: true,
    metadata: {
      canonicalUrl: parsed.url,
      title,
      author,
      thumbnail,
      playerUrl,
      source: 'soundcloud-oembed',
      inference: false,
    },
  };
}
