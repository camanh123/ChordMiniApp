/**
 * SoundCloud track links and the official player URL.
 * The player always points at w.soundcloud.com. A link is never an audio address.
 */

const RESERVED = new Set([
  'discover',
  'you',
  'stream',
  'search',
  'upload',
  'messages',
  'settings',
  'feed',
  'charts',
  'pages',
  'stations',
  'tags',
  'groups',
  'people',
  'popular',
  'tracks',
]);

export type ParsedSoundCloudLink =
  | { ok: true; url: string }
  | { ok: false; reason: 'empty' | 'invalid' };

function isSlug(value: string): boolean {
  if (!value || value === '.' || value === '..' || value.length > 120) return false;
  return /^[\p{L}\p{N}_-]+$/u.test(value);
}

export function parseSoundCloudLink(input: string): ParsedSoundCloudLink {
  const raw = input.trim();
  if (!raw) return { ok: false, reason: 'empty' };
  if (/[\s<>]/.test(raw)) return { ok: false, reason: 'invalid' };

  let url: URL;
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (url.username || url.password) return { ok: false, reason: 'invalid' };
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: 'invalid' };

  const host = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  const segments = url.pathname.split('/').filter(Boolean);
  if (host === 'on.soundcloud.com') {
    if (segments.length !== 1 || !/^[A-Za-z0-9]{4,32}$/.test(segments[0])) {
      return { ok: false, reason: 'invalid' };
    }
    return { ok: true, url: `https://on.soundcloud.com/${segments[0]}` };
  }
  if (host !== 'soundcloud.com' && host !== 'm.soundcloud.com') {
    return { ok: false, reason: 'invalid' };
  }
  if (segments.length !== 2) return { ok: false, reason: 'invalid' };
  const [user, track] = segments;
  if (!isSlug(user) || !isSlug(track)) return { ok: false, reason: 'invalid' };
  if (RESERVED.has(user.toLowerCase())) return { ok: false, reason: 'invalid' };
  const blocked = new Set(['sets', 'likes', 'reposts', 'albums']);
  if (blocked.has(track.toLowerCase())) return { ok: false, reason: 'invalid' };

  const canonical = new URL('https://soundcloud.com');
  canonical.pathname = `/${user}/${track}`;
  return { ok: true, url: canonical.toString() };
}

export function officialSoundCloudPlayerUrl(canonicalUrl: string): string | null {
  const parsed = parseSoundCloudLink(canonicalUrl);
  if (!parsed.ok) return null;
  const player = new URL('https://w.soundcloud.com/player/');
  player.searchParams.set('url', parsed.url);
  player.searchParams.set('auto_play', 'false');
  player.searchParams.set('hide_related', 'true');
  player.searchParams.set('show_comments', 'false');
  player.searchParams.set('show_user', 'true');
  player.searchParams.set('show_reposts', 'false');
  player.searchParams.set('show_teaser', 'false');
  player.searchParams.set('visual', 'false');
  return player.toString();
}

export function isOfficialSoundCloudPlayerUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.origin !== 'https://w.soundcloud.com' || url.pathname !== '/player/') return false;
  if (url.searchParams.get('auto_play') === 'true') return false;
  const target = url.searchParams.get('url');
  if (!target) return false;
  const parsed = parseSoundCloudLink(target);
  return parsed.ok && parsed.url === target;
}

export function isSafeSoundCloudThumbnail(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return host === 'sndcdn.com'
    || host.endsWith('.sndcdn.com')
    || host === 'soundcloud.com'
    || host.endsWith('.soundcloud.com');
}
