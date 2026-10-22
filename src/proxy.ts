import { NextRequest, NextResponse } from 'next/server';
import { decideDesktopRequest, DESKTOP_COOKIE_NAME } from '@/desktop/desktopSecurity';

const SERVER_ACTION_HEADER = 'next-action';

export function proxy(request: NextRequest) {
  const decision = decideDesktopRequest({
    desktopMode: process.env.CHORDMINI_DESKTOP_MODE === '1',
    method: request.method,
    hostHeader: request.headers.get('host'),
    origin: request.headers.get('origin'),
    secFetchSite: request.headers.get('sec-fetch-site'),
    secFetchDest: request.headers.get('sec-fetch-dest'),
    pathname: request.nextUrl.pathname,
    cookieToken: request.cookies.get(DESKTOP_COOKIE_NAME)?.value ?? null,
    expectedCookie: process.env.CHORDMINI_DESKTOP_COOKIE ?? null,
  });

  if (decision.action === 'deny') {
    return new NextResponse('Forbidden', {
      status: decision.status,
      headers: {
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8',
      },
    });
  }

  if (request.method === 'POST' && request.headers.has(SERVER_ACTION_HEADER)) {
    return new NextResponse('Server action not found.', {
      status: 404,
      headers: {
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8',
        'x-nextjs-action-not-found': '1',
      },
    });
  }

  if (decision.action === 'allow-document') {
    const response = NextResponse.next();
    const cookie = process.env.CHORDMINI_DESKTOP_COOKIE;
    if (cookie) {
      response.cookies.set(DESKTOP_COOKIE_NAME, cookie, {
        httpOnly: true,
        sameSite: 'strict',
        secure: false,
        path: '/',
      });
    }
    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
