/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server';
import { GET as readyGet } from '@/app/api/desktop/ready/route';
import { decideDesktopRequest, DESKTOP_COOKIE_NAME } from '@/desktop/desktopSecurity';
import { computeReadyProof } from '@/desktop/readyProof';
import { proxy } from '@/proxy';

const host = '127.0.0.1:4312';
const origin = `http://${host}`;

function request(overrides: Partial<Parameters<typeof decideDesktopRequest>[0]> = {}) {
  return decideDesktopRequest({
    desktopMode: true,
    method: 'GET',
    hostHeader: host,
    origin: null,
    secFetchSite: 'same-origin',
    secFetchDest: 'empty',
    pathname: '/api/recognize-chords',
    cookieToken: 'desktop-cookie-value',
    expectedCookie: 'desktop-cookie-value',
    ...overrides,
  });
}

describe('desktop request gate', () => {
  const previous = {
    mode: process.env.CHORDMINI_DESKTOP_MODE,
    cookie: process.env.CHORDMINI_DESKTOP_COOKIE,
    token: process.env.CHORDMINI_READY_TOKEN,
  };

  afterEach(() => {
    process.env.CHORDMINI_DESKTOP_MODE = previous.mode;
    process.env.CHORDMINI_DESKTOP_COOKIE = previous.cookie;
    process.env.CHORDMINI_READY_TOKEN = previous.token;
  });

  it('leaves production web requests on the existing path', () => {
    expect(request({ desktopMode: false, origin: 'https://evil.test', secFetchSite: 'cross-site' })).toEqual({
      action: 'bypass',
    });
  });

  it('rejects foreign origins, other loopback ports, and non-loopback hosts', () => {
    expect(request({ origin: 'https://evil.test' }).action).toBe('deny');
    expect(request({ origin: 'http://127.0.0.1:9999' })).toMatchObject({ reason: 'foreign-origin' });
    expect(request({ origin: 'not a url' })).toMatchObject({ reason: 'bad-origin' });
    expect(request({ hostHeader: 'localhost:4312' })).toMatchObject({ reason: 'non-loopback-host' });
    expect(request({ secFetchSite: 'cross-site' })).toMatchObject({ reason: 'cross-site' });
    expect(request({ secFetchSite: 'same-site' })).toMatchObject({ reason: 'cross-site' });
  });

  it('allows the readiness probe without the session cookie and requires the cookie for APIs', () => {
    expect(request({
      pathname: '/api/desktop/ready',
      cookieToken: null,
      expectedCookie: null,
      secFetchSite: null,
    })).toEqual({ action: 'allow' });
    expect(request({ cookieToken: null })).toMatchObject({ reason: 'missing-desktop-cookie' });
    expect(request({ origin })).toEqual({ action: 'allow' });
  });

  it('marks the first document navigation so the proxy can set the cookie', () => {
    expect(request({
      pathname: '/',
      secFetchDest: 'document',
      secFetchSite: 'none',
      cookieToken: null,
      origin: null,
    })).toEqual({ action: 'allow-document' });
  });

  it('preserves the hosted web proxy when desktop mode is off', () => {
    delete process.env.CHORDMINI_DESKTOP_MODE;
    delete process.env.CHORDMINI_DESKTOP_COOKIE;

    const home = new NextRequest('https://chordmini.example/', {
      headers: {
        host: 'chordmini.example',
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
      },
    });
    const homeResponse = proxy(home);
    expect(homeResponse.status).not.toBe(403);
    expect(homeResponse.cookies.get(DESKTOP_COOKIE_NAME)).toBeUndefined();

    const post = new NextRequest('https://chordmini.example/api/recognize-chords', {
      method: 'POST',
      headers: {
        host: 'chordmini.example',
        origin: 'https://chordmini.example',
      },
    });
    const postResponse = proxy(post);
    expect(postResponse.status).not.toBe(403);
    expect(postResponse.status).not.toBe(404);

    const action = new NextRequest('https://chordmini.example/', {
      method: 'POST',
      headers: {
        host: 'chordmini.example',
        'next-action': 'existing-action',
      },
    });
    const actionResponse = proxy(action);
    expect(actionResponse.status).toBe(404);
    expect(actionResponse.headers.get('x-nextjs-action-not-found')).toBe('1');
  });

  it('sets the desktop cookie on a document and blocks a cross-site API call', () => {
    process.env.CHORDMINI_DESKTOP_MODE = '1';
    process.env.CHORDMINI_DESKTOP_COOKIE = 'desktop-cookie-value';

    const document = new NextRequest(`${origin}/`, {
      headers: {
        host,
        'sec-fetch-dest': 'document',
        'sec-fetch-site': 'none',
      },
    });
    const documentResponse = proxy(document);
    expect(documentResponse.cookies.get(DESKTOP_COOKIE_NAME)?.value).toBe('desktop-cookie-value');

    const crossSite = new NextRequest(`${origin}/api/recognize-chords`, {
      headers: {
        host,
        origin: 'http://127.0.0.1:9999',
        'sec-fetch-site': 'cross-site',
      },
    });
    const denied = proxy(crossSite);
    expect(denied.status).toBe(403);
  });
});

describe('desktop readiness route', () => {
  const previous = {
    mode: process.env.CHORDMINI_DESKTOP_MODE,
    token: process.env.CHORDMINI_READY_TOKEN,
  };

  afterEach(() => {
    process.env.CHORDMINI_DESKTOP_MODE = previous.mode;
    process.env.CHORDMINI_READY_TOKEN = previous.token;
  });

  it('stays hidden unless this process is the desktop server', async () => {
    delete process.env.CHORDMINI_DESKTOP_MODE;
    const response = await readyGet(new Request('http://127.0.0.1/api/desktop/ready'));
    expect(response.status).toBe(404);
  });

  it('returns a proof for the caller nonce without revealing the token', async () => {
    process.env.CHORDMINI_DESKTOP_MODE = '1';
    process.env.CHORDMINI_READY_TOKEN = 'owned-ready-token';
    const missing = await readyGet(new Request('http://127.0.0.1/api/desktop/ready'));
    expect(missing.status).toBe(401);

    const response = await readyGet(new Request('http://127.0.0.1/api/desktop/ready', {
      headers: { 'x-chordmini-nonce': 'nonce-1' },
    }));
    const body = await response.json() as { ok: boolean; role: string };

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, role: 'next-standalone' });
    expect(JSON.stringify(body)).not.toContain('owned-ready-token');
    expect(response.headers.get('x-chordmini-proof')).toBe(computeReadyProof('owned-ready-token', 'nonce-1'));
  });
});
