/**
 * @jest-environment node
 */

import { NextResponse } from 'next/server';
import {
  analysisServiceGateResponse,
  desktopAnalysisConnectionResponse,
} from '@/server/analysisServiceAvailability';
import {
  buildPrivacySafeDiagnostics,
  readAnalysisServiceFailure,
  redactDiagnosticsText,
} from '@/utils/analysisServiceError';

describe('desktop analysis service availability', () => {
  const originalUrl = process.env.PYTHON_API_URL;
  const originalMode = process.env.CHORDMINI_DESKTOP_MODE;

  afterEach(() => {
    if (originalUrl === undefined) {
      delete process.env.PYTHON_API_URL;
    } else {
      process.env.PYTHON_API_URL = originalUrl;
    }
    if (originalMode === undefined) {
      delete process.env.CHORDMINI_DESKTOP_MODE;
    } else {
      process.env.CHORDMINI_DESKTOP_MODE = originalMode;
    }
  });

  async function bodyOf(response: NextResponse | null) {
    expect(response).not.toBeNull();
    return response!.json() as Promise<Record<string, string>>;
  }

  it('leaves web and local Next.js requests on the existing proxy path', async () => {
    delete process.env.CHORDMINI_DESKTOP_MODE;
    delete process.env.PYTHON_API_URL;
    const fetchImpl = jest.fn();

    await expect(analysisServiceGateResponse(process.env, fetchImpl, 50)).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('tells the desktop app that an unset analysis service is not configured', async () => {
    process.env.CHORDMINI_DESKTOP_MODE = '1';
    delete process.env.PYTHON_API_URL;
    const fetchImpl = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:5001'));

    const response = await analysisServiceGateResponse(process.env, fetchImpl, 50);
    const body = await bodyOf(response);

    expect(response?.status).toBe(503);
    expect(body).toMatchObject({
      success: false,
      code: 'ANALYSIS_SERVICE_NOT_CONFIGURED',
      error: 'Required service configuration missing',
    });
    expect(JSON.stringify(body)).not.toMatch(/localhost|127\.0\.0\.1|https?:\/\//i);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localhost:5001/health',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('allows a desktop request through when the loopback service actually answers', async () => {
    process.env.CHORDMINI_DESKTOP_MODE = '1';
    delete process.env.PYTHON_API_URL;
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });

    await expect(analysisServiceGateResponse(process.env, fetchImpl, 50)).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not echo an explicit loopback address when that service is down', async () => {
    process.env.CHORDMINI_DESKTOP_MODE = '1';
    process.env.PYTHON_API_URL = 'http://127.0.0.1:5001/private';
    const fetchImpl = jest.fn().mockRejectedValue(new Error('offline'));

    const body = await bodyOf(await analysisServiceGateResponse(process.env, fetchImpl, 50));

    expect(body.code).toBe('ANALYSIS_SERVICE_UNAVAILABLE');
    expect(JSON.stringify(body)).not.toContain('127.0.0.1');
    expect(JSON.stringify(body)).not.toContain('5001');
    expect(JSON.stringify(body)).not.toContain('private');
  });

  it('does not probe a configured remote service before the real analysis request', async () => {
    process.env.CHORDMINI_DESKTOP_MODE = '1';
    process.env.PYTHON_API_URL = 'https://user:secret@ml.example.com/internal';
    const fetchImpl = jest.fn();

    await expect(analysisServiceGateResponse(process.env, fetchImpl, 50)).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an invalid desktop service URL without returning the value', async () => {
    process.env.CHORDMINI_DESKTOP_MODE = '1';
    process.env.PYTHON_API_URL = 'not a url';
    const fetchImpl = jest.fn();

    const body = await bodyOf(await analysisServiceGateResponse(process.env, fetchImpl, 50));

    expect(body.code).toBe('ANALYSIS_SERVICE_NOT_CONFIGURED');
    expect(JSON.stringify(body)).not.toContain('not a url');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('replaces a desktop connection error without copying the address into the response', async () => {
    process.env.CHORDMINI_DESKTOP_MODE = '1';
    const response = desktopAnalysisConnectionResponse(
      new Error('fetch failed: connect ECONNREFUSED http://secret.internal:5001'),
    );
    const body = await bodyOf(response);

    expect(response?.status).toBe(503);
    expect(body.code).toBe('ANALYSIS_SERVICE_UNAVAILABLE');
    expect(JSON.stringify(body)).not.toContain('secret.internal');

    delete process.env.CHORDMINI_DESKTOP_MODE;
    expect(desktopAnalysisConnectionResponse(new Error('fetch failed'))).toBeNull();
  });
});

describe('privacy-safe analysis diagnostics', () => {
  it('reads the service code and strips addresses from copied diagnostics', () => {
    const failure = readAnalysisServiceFailure({
      error: 'Analysis service unavailable',
      code: 'ANALYSIS_SERVICE_UNAVAILABLE',
      suggestion: 'See http://127.0.0.1:5001/health for details.',
    });

    expect(failure?.code).toBe('ANALYSIS_SERVICE_UNAVAILABLE');
    expect(failure?.message).not.toMatch(/127\.0\.0\.1|https?:\/\//i);
    expect(redactDiagnosticsText('host localhost:5001')).toContain('[redacted-host]');

    const copied = buildPrivacySafeDiagnostics({
      code: failure?.code,
      message: failure?.message || '',
      runtime: 'electron',
      version: '0.6.5',
    });
    expect(copied).toContain('"feature":"audio-analysis"');
    expect(copied).not.toMatch(/localhost|127\.0\.0\.1|https?:\/\//i);
  });
});
