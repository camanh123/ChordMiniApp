/**
 * @jest-environment node
 */

import { NextRequest } from 'next/server';
import { spawn } from 'child_process';
import { fetchPythonBackend } from '@/server/desktopLoopback';
import { POST as extractAudio } from '@/app/api/extract-audio/route';
import { POST as nativeFallback } from '@/app/api/audio/native-ytdlp-fallback/route';
import { POST as finalizeExtraction } from '@/app/api/audio/finalize-browser-extraction/route';
import { POST as ytdlpExtract } from '@/app/api/ytdlp/extract/route';
import { POST as ytdlpDownload } from '@/app/api/ytdlp/download/route';
import { GET as ytdlpSearchGet, POST as ytdlpSearchPost } from '@/app/api/ytdlp/search/route';
import { GET as ytdlpHealth } from '@/app/api/ytdlp/health/route';
import { GET as youtubeInfo, POST as youtubeInfoPost } from '@/app/api/youtube/info/route';
import { GET as officialMetadata } from '@/app/api/youtube/official-metadata/route';
import { DESKTOP_EXTRACTION_DENIED_CODE } from '@/server/desktopExtractionGuard';

jest.mock('child_process', () => ({
  spawn: jest.fn(() => {
    throw new Error('extraction process started');
  }),
}));

jest.mock('@/server/desktopLoopback', () => ({
  decideDesktopLoopback: jest.fn(() => ({ scope: 'passthrough' })),
  fetchPythonBackend: jest.fn(async () => ({ state: 'refused' })),
}));

const VIDEO_ID = 'abcdefghijk';

function post(path: string, body: unknown = { videoId: VIDEO_ID, url: `https://www.youtube.com/watch?v=${VIDEO_ID}` }) {
  return new NextRequest(`http://127.0.0.1:3000${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('desktop extraction routes', () => {
  const originalDesktop = process.env.CHORDMINI_DESKTOP_MODE;

  beforeEach(() => {
    process.env.CHORDMINI_DESKTOP_MODE = '1';
    (spawn as unknown as jest.Mock).mockClear();
    (fetchPythonBackend as jest.Mock).mockClear();
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (!url.includes('https://www.youtube.com/oembed')) {
        throw new Error(`unexpected media request ${url}`);
      }
      return new Response(JSON.stringify({
        title: 'Official title',
        author_name: 'Author',
        thumbnail_url: `https://i.ytimg.com/vi/${VIDEO_ID}/hqdefault.jpg`,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
  });

  afterEach(() => {
    if (originalDesktop === undefined) delete process.env.CHORDMINI_DESKTOP_MODE;
    else process.env.CHORDMINI_DESKTOP_MODE = originalDesktop;
    jest.restoreAllMocks();
  });

  async function expectDenied(response: Response) {
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      code: DESKTOP_EXTRACTION_DENIED_CODE,
    });
    expect(spawn).not.toHaveBeenCalled();
  }

  it('denies direct extraction and download routes before any process or media fetch', async () => {
    await expectDenied(await extractAudio(post('/api/extract-audio', { videoId: VIDEO_ID, getInfoOnly: true })));
    await expectDenied(await nativeFallback(post('/api/audio/native-ytdlp-fallback')));
    await expectDenied(await finalizeExtraction(post('/api/audio/finalize-browser-extraction')));
    await expectDenied(await ytdlpExtract(post('/api/ytdlp/extract')));
    await expectDenied(await ytdlpDownload(post('/api/ytdlp/download')));
    await expectDenied(await ytdlpSearchPost(post('/api/ytdlp/search', { query: 'song' })));
    await expectDenied(await ytdlpSearchGet(new NextRequest(`http://127.0.0.1:3000/api/ytdlp/search?q=song`)));
    await expectDenied(await ytdlpHealth());
    expect(fetchPythonBackend).not.toHaveBeenCalled();
  });

  it('keeps official metadata and skips the Python extraction call', async () => {
    const info = await youtubeInfo(new NextRequest(`http://127.0.0.1:3000/api/youtube/info?videoId=${VIDEO_ID}`));
    const infoBody = await info.json();
    expect(info.status).toBe(200);
    expect(infoBody).toMatchObject({ success: true, title: 'Official title', videoId: VIDEO_ID });
    expect(fetchPythonBackend).not.toHaveBeenCalled();

    const posted = await youtubeInfoPost(post('/api/youtube/info'));
    expect(posted.status).toBe(200);
    await expect(posted.json()).resolves.toMatchObject({ success: true, title: 'Official title' });

    const metadata = await officialMetadata(new NextRequest(`http://127.0.0.1:3000/api/youtube/official-metadata?videoId=${VIDEO_ID}`));
    expect(metadata.status).toBe(200);
    await expect(metadata.json()).resolves.toMatchObject({
      success: true,
      title: 'Official title',
      source: 'youtube-oembed',
      durationSeconds: null,
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('still attempts the existing web extraction proxy when desktop mode is off', async () => {
    delete process.env.CHORDMINI_DESKTOP_MODE;
    const info = await youtubeInfo(new NextRequest(`http://127.0.0.1:3000/api/youtube/info?videoId=${VIDEO_ID}`));
    expect(info.status).toBe(200);
    expect(fetchPythonBackend).toHaveBeenCalledWith('/api/extract-audio', expect.objectContaining({ method: 'POST' }));
    const extract = await extractAudio(post('/api/extract-audio', { videoId: VIDEO_ID, getInfoOnly: true }));
    expect(extract.status).not.toBe(403);
    await expect(extract.json()).resolves.toMatchObject({ success: true, videoId: VIDEO_ID });
  });
});
