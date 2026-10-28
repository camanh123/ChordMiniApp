import { NextResponse } from 'next/server';
import { decideDesktopRequest, DESKTOP_COOKIE_NAME } from '@/desktop/desktopSecurity';
import { AnalysisHistoryError, isAnalysisHistoryError } from '@/desktop/analysisHistory';
import type { AnalysisHistoryErrorCode } from '@/desktop/analysisHistory';

export const HISTORY_COLLECTION_PATH = '/api/desktop/analysis-history';
export const DEFAULT_HISTORY_BODY_BYTES = 2 * 1024 * 1024;
export const DEFAULT_HISTORY_PAGE_SIZE = 20;
export const MAX_HISTORY_PAGE_SIZE = 50;

const ERROR_STATUS: Record<AnalysisHistoryErrorCode, number> = {
  STORAGE_ROOT_UNSAFE: 503,
  PATH_UNSAFE: 400,
  RECORD_INVALID: 400,
  PAYLOAD_TOO_LARGE: 413,
  SCHEMA_UNSUPPORTED: 400,
  CAPACITY_EXCEEDED: 409,
  STORAGE_UNAVAILABLE: 503,
  RECORD_NOT_FOUND: 404,
  DELETE_NOT_CONFIRMED: 400,
  RECORD_CORRUPT: 422,
  LYRIC_PARENT_MISMATCH: 409,
};

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

export function historyBodyLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CHORDMINI_ANALYSIS_HISTORY_MAX_BODY_BYTES;
  if (!raw) return DEFAULT_HISTORY_BODY_BYTES;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_HISTORY_BODY_BYTES;
  return Math.min(parsed, DEFAULT_HISTORY_BODY_BYTES);
}

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    const value = part.slice(separator + 1).trim();
    if (!value) return null;
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Desktop cookie, loopback host, and origin must all agree. Web mode is 404.
 * A caller on the same machine still needs the desktop cookie. Mutations also
 * need an Origin that matches the loopback host, which is the CSRF check.
 */
export function authorizeHistoryRequest(request: Request, pathname: string): NextResponse | null {
  if (process.env.CHORDMINI_DESKTOP_MODE !== '1') {
    return json({ ok: false }, 404);
  }
  const method = request.method.toUpperCase();
  const decision = decideDesktopRequest({
    desktopMode: true,
    method,
    hostHeader: request.headers.get('host'),
    origin: request.headers.get('origin'),
    secFetchSite: request.headers.get('sec-fetch-site'),
    secFetchDest: request.headers.get('sec-fetch-dest'),
    pathname,
    cookieToken: cookieValue(request.headers.get('cookie'), DESKTOP_COOKIE_NAME),
    expectedCookie: process.env.CHORDMINI_DESKTOP_COOKIE ?? null,
  });
  if (decision.action !== 'allow') {
    return json({ ok: false, code: 'FORBIDDEN' }, 403);
  }
  if ((method === 'POST' || method === 'DELETE') && !request.headers.get('origin')) {
    return json({ ok: false, code: 'FORBIDDEN' }, 403);
  }
  return null;
}

export async function readHistoryBody(request: Request): Promise<unknown> {
  const limit = historyBodyLimit();
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared.trim()) || Number(declared) > limit)) {
    throw new AnalysisHistoryError('PAYLOAD_TOO_LARGE', 'Analysis history request exceeds the size limit.');
  }
  if (!request.body) {
    throw new AnalysisHistoryError('RECORD_INVALID', 'Analysis history request is missing a body.');
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      if (!step.value) continue;
      total += step.value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new AnalysisHistoryError('PAYLOAD_TOO_LARGE', 'Analysis history request exceeds the size limit.');
      }
      chunks.push(step.value);
    }
  } finally {
    reader.releaseLock();
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') {
    throw new AnalysisHistoryError('RECORD_INVALID', 'Analysis history request is missing a body.');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AnalysisHistoryError('RECORD_INVALID', 'Analysis history request is not valid JSON.');
  }
}

export function historyErrorResponse(error: unknown): NextResponse {
  if (isAnalysisHistoryError(error)) {
    return json({ ok: false, code: error.code }, ERROR_STATUS[error.code] ?? 503);
  }
  return json({ ok: false, code: 'STORAGE_UNAVAILABLE' }, 503);
}

export function historyJson(body: unknown, status = 200): NextResponse {
  return json(body, status);
}

export function historyPageSize(raw: string | null): number {
  if (raw === null) return DEFAULT_HISTORY_PAGE_SIZE;
  if (!/^\d+$/.test(raw)) {
    throw new AnalysisHistoryError('RECORD_INVALID', 'Analysis history page size is invalid.');
  }
  const parsed = Number(raw);
  if (parsed < 1 || parsed > MAX_HISTORY_PAGE_SIZE) {
    throw new AnalysisHistoryError('RECORD_INVALID', 'Analysis history page size is invalid.');
  }
  return parsed;
}
