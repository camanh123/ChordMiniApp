/**
 * @jest-environment node
 */

import { NextRequest } from 'next/server';
import { GET as officialMetadata } from '@/app/api/soundcloud/official-metadata/route';
import {
  officialSoundCloudPlayerUrl,
  parseSoundCloudLink,
} from '@/services/soundcloud/soundCloudLink';

const TRACK = 'https://soundcloud.com/artist/track';

describe('SoundCloud links and official metadata', () => {
  const originalFetch = global.fetch;
  const originalDesktop = process.env.CHORDMINI_DESKTOP_MODE;

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalDesktop === undefined) delete process.env.CHORDMINI_DESKTOP_MODE;
    else process.env.CHORDMINI_DESKTOP_MODE = originalDesktop;
  });

  it('accepts a track link and rejects other addresses', () => {
    expect(parseSoundCloudLink('https://soundcloud.com/artist/track?si=tracking')).toEqual({
      ok: true,
      url: TRACK,
    });
    expect(parseSoundCloudLink('http://m.soundcloud.com/artist/track')).toEqual({ ok: true, url: TRACK });
    expect(parseSoundCloudLink('https://on.soundcloud.com/Ab12cd')).toEqual({
      ok: true,
      url: 'https://on.soundcloud.com/Ab12cd',
    });
    expect(parseSoundCloudLink('https://soundcloud.com/artist/sets/playlist').ok).toBe(false);
    expect(parseSoundCloudLink('https://soundcloud.com/artist').ok).toBe(false);
    expect(parseSoundCloudLink('https://example.com/artist/track').ok).toBe(false);
    expect(parseSoundCloudLink('https://user:pass@soundcloud.com/artist/track').ok).toBe(false);
    expect(parseSoundCloudLink('javascript:alert(1)').ok).toBe(false);
    const player = officialSoundCloudPlayerUrl(TRACK);
    expect(player).toContain('https://w.soundcloud.com/player/');
    expect(player).toContain('auto_play=false');
    expect(player).toContain(encodeURIComponent(TRACK));
  });

  it('loads official oEmbed metadata and does not fetch media', async () => {
    const fetchMock = jest.fn(async (input: unknown) => {
      const target = String(input);
      expect(new URL(target).hostname).toBe('soundcloud.com');
      expect(new URL(target).pathname).toBe('/oembed');
      expect(target).not.toMatch(/extract|googlevideo|ytdlp/i);
      return {
        ok: true,
        json: async () => ({
          title: 'Official track',
          author_name: 'Official artist',
          thumbnail_url: 'https://evil.example/art.jpg',
          html: '<iframe src="https://evil.example/player"></iframe>',
        }),
      } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    process.env.CHORDMINI_DESKTOP_MODE = '1';

    const response = await officialMetadata(new NextRequest(
      `http://127.0.0.1:3000/api/soundcloud/official-metadata?url=${encodeURIComponent(TRACK)}`,
    ));
    const body = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(body.inference).toBe(false);
    expect(body.title).toBe('Official track');
    expect(body.author).toBe('Official artist');
    expect(body.thumbnail).toBeNull();
    expect(body.html).toBeUndefined();
    expect(String(body.playerUrl)).toContain('https://w.soundcloud.com/player/');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not call the network for an invalid link', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const response = await officialMetadata(new NextRequest(
      'http://127.0.0.1:3000/api/soundcloud/official-metadata?url=https%3A%2F%2Fexample.com%2Fa%2Fb',
    ));
    expect(response.status).toBe(400);
    const body = await response.json() as { inference?: boolean };
    expect(body.inference).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
