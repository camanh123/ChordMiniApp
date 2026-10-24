/**
 * @jest-environment node
 *
 * CONTRACT (mocked fetch): desktop PYTHON_API_URL refusal.
 * These cases do not run Chord-CNN-LSTM or Madmom.
 */

import {
  auxiliaryTarget,
  decideDesktopLoopback,
  fetchPythonBackend,
  requirePythonBackendResponse,
  DesktopPythonFetchError,
  sheetSageTarget,
} from '@/server/desktopLoopback';

describe('CONTRACT desktop loopback policy', () => {
  const originalUrl = process.env.PYTHON_API_URL;
  const originalMode = process.env.CHORDMINI_DESKTOP_MODE;

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.PYTHON_API_URL;
    else process.env.PYTHON_API_URL = originalUrl;
    if (originalMode === undefined) delete process.env.CHORDMINI_DESKTOP_MODE;
    else process.env.CHORDMINI_DESKTOP_MODE = originalMode;
  });

  it('accepts an explicit http://127.0.0.1 origin and a valid port', () => {
    process.env.CHORDMINI_DESKTOP_MODE = '1';
    process.env.PYTHON_API_URL = 'http://127.0.0.1:5001';
    expect(decideDesktopLoopback()).toEqual({ scope: 'accepted', origin: 'http://127.0.0.1:5001' });

    process.env.PYTHON_API_URL = 'HTTP://127.0.0.1/';
    expect(decideDesktopLoopback()).toEqual({ scope: 'accepted', origin: 'http://127.0.0.1' });
  });

  it.each([
    undefined,
    '',
    'http://localhost:5001',
    'https://203.0.113.10/analyze',
    'https://127.0.0.1:5001',
    'http://user:secret@127.0.0.1:5001',
    'http://127.0.0.1:5001/api',
    'http://127.0.0.1:5001?x=1',
    'http://127.0.0.1:5001#x',
    'http://[::1]:5001',
    'http://127.1',
    'http://2130706433',
    'http://0177.0.0.1',
    'http://127.0.0.1.example.com',
    'http://127.0.0.1.',
    'file:///tmp/model',
    'not a url',
    'http://127.0.0.1:0',
    'http://127.0.0.1:65536',
    'http://127.0.0.1:05001',
  ])('rejects %s in desktop mode', (candidate) => {
    process.env.CHORDMINI_DESKTOP_MODE = '1';
    if (candidate === undefined) delete process.env.PYTHON_API_URL;
    else process.env.PYTHON_API_URL = candidate;
    expect(decideDesktopLoopback().scope).toBe('rejected');
  });

  it('keeps non-desktop forwarding on the existing URL, including redirects', async () => {
    delete process.env.CHORDMINI_DESKTOP_MODE;
    process.env.PYTHON_API_URL = 'https://ml.example/internal';
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });

    const outcome = await fetchPythonBackend('/api/recognize-chords', { method: 'POST' }, process.env, fetchImpl);

    expect(outcome.state).toBe('response');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://ml.example/internal/api/recognize-chords',
      { method: 'POST' },
    );
  });

  it('does not call fetch for a rejected desktop URL', async () => {
    process.env.CHORDMINI_DESKTOP_MODE = '1';
    process.env.PYTHON_API_URL = 'https://user:secret@ml.example/private';
    const fetchImpl = jest.fn();

    await expect(fetchPythonBackend('/api/detect-beats', { method: 'POST' }, process.env, fetchImpl))
      .resolves.toEqual({ state: 'refused' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a desktop redirect without reading or requesting Location', async () => {
    process.env.CHORDMINI_DESKTOP_MODE = '1';
    process.env.PYTHON_API_URL = 'http://127.0.0.1:5001';
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      status: 302,
      type: 'default',
      headers: { get: (name: string) => (name.toLowerCase() === 'location' ? 'https://evil.example/steal' : null) },
    });

    const outcome = await fetchPythonBackend('/api/detect-beats', { method: 'POST' }, process.env, fetchImpl);

    expect(outcome.state).toBe('redirect');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('http://127.0.0.1:5001/api/detect-beats');
    expect(fetchImpl.mock.calls[0][1].redirect).toBe('manual');
    await expect(requirePythonBackendResponse('/api/detect-beats', {}, process.env, fetchImpl))
      .rejects.toBeInstanceOf(DesktopPythonFetchError);
  });

  it('skips a production service fallback when desktop mode rejects the python URL', () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousSheetSage = process.env.SHEETSAGE_API_URL;
    process.env.CHORDMINI_DESKTOP_MODE = '1';
    process.env.NODE_ENV = 'production';
    process.env.PYTHON_API_URL = 'https://evil.example/models';
    delete process.env.SHEETSAGE_API_URL;

    try {
      expect(sheetSageTarget().action).toBe('skip');
      expect(auxiliaryTarget('https://evil.example/models/api/songformer/segment', true).action).toBe('skip');

      process.env.SHEETSAGE_API_URL = 'https://sheetsage.example';
      expect(sheetSageTarget()).toEqual({ action: 'direct', url: 'https://sheetsage.example' });
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      if (previousSheetSage === undefined) delete process.env.SHEETSAGE_API_URL;
      else process.env.SHEETSAGE_API_URL = previousSheetSage;
    }
  });

  it('refuses a desktop path that leaves the accepted origin', async () => {
    process.env.CHORDMINI_DESKTOP_MODE = '1';
    process.env.PYTHON_API_URL = 'http://127.0.0.1:5001';
    const fetchImpl = jest.fn();

    await expect(fetchPythonBackend('https://evil.example/api', {}, process.env, fetchImpl))
      .resolves.toEqual({ state: 'refused' });
    await expect(fetchPythonBackend('//evil.example/api', {}, process.env, fetchImpl))
      .resolves.toEqual({ state: 'refused' });
    await expect(fetchPythonBackend('/\\evil.example', {}, process.env, fetchImpl))
      .resolves.toEqual({ state: 'refused' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
