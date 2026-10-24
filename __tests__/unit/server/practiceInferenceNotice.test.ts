/**
 * @jest-environment node
 */

import { GET } from '@/app/api/practice-inference-notice/route';
import { practiceInferenceNotice } from '@/server/practiceInferenceNotice';

describe('practice inference notice', () => {
  const originalDesktop = process.env.CHORDMINI_DESKTOP_MODE;
  const originalUrl = process.env.PYTHON_API_URL;

  afterEach(() => {
    if (originalDesktop === undefined) {
      delete process.env.CHORDMINI_DESKTOP_MODE;
    } else {
      process.env.CHORDMINI_DESKTOP_MODE = originalDesktop;
    }
    if (originalUrl === undefined) {
      delete process.env.PYTHON_API_URL;
    } else {
      process.env.PYTHON_API_URL = originalUrl;
    }
    jest.restoreAllMocks();
  });

  it('does not contact a remote inference service or return its address', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    process.env.CHORDMINI_DESKTOP_MODE = '1';
    process.env.PYTHON_API_URL = 'https://user:secret@inference.example/private';

    expect(practiceInferenceNotice()).toBe('not_configured');
    const response = GET();
    const body = await response.json();

    expect(body).toEqual({ notice: 'not_configured' });
    expect(JSON.stringify(body)).not.toMatch(/secret|inference\.example|localhost|127\.0\.0\.1/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports an invalid desktop configuration without probing', () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    process.env.CHORDMINI_DESKTOP_MODE = '1';
    process.env.PYTHON_API_URL = 'not a url';

    expect(practiceInferenceNotice()).toBe('not_configured');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('treats an unset desktop URL as not configured and does not imply localhost', () => {
    process.env.CHORDMINI_DESKTOP_MODE = '1';
    delete process.env.PYTHON_API_URL;

    expect(practiceInferenceNotice()).toBe('not_configured');
  });

  it('keeps an explicit 127.0.0.1 desktop URL on the neutral requirement', () => {
    process.env.CHORDMINI_DESKTOP_MODE = '1';
    process.env.PYTHON_API_URL = 'http://127.0.0.1:5001';

    expect(practiceInferenceNotice()).toBe('requirement');
  });

  it('leaves the website on the neutral requirement even when the URL is invalid', () => {
    delete process.env.CHORDMINI_DESKTOP_MODE;
    process.env.PYTHON_API_URL = 'not a url';

    expect(practiceInferenceNotice()).toBe('requirement');
  });
});
