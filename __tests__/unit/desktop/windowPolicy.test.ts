/**
 * @jest-environment node
 */
import {
  classifyNavigation,
  createBrowserWindowOptions,
  singleInstanceDecision,
  windowOpenDecision,
} from '@/desktop/windowPolicy';

const origin = 'http://127.0.0.1:4312';

describe('desktop window policy', () => {
  it('uses a sandboxed window and does not expose a preload bridge', () => {
    const options = createBrowserWindowOptions();

    expect(options.webPreferences).toEqual({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      nodeIntegrationInSubFrames: false,
    });
    expect(options).not.toHaveProperty('webPreferences.preload');
    expect(Object.keys(options.webPreferences)).not.toContain('preload');
  });

  it('keeps navigation inside the owned loopback origin', () => {
    expect(classifyNavigation(`${origin}/analyze`, origin)).toBe('allow');
    expect(classifyNavigation('https://www.youtube.com/watch?v=abc', origin)).toBe('external');
    expect(classifyNavigation('http://127.0.0.1:9999/', origin)).toBe('deny');
    expect(classifyNavigation('http://localhost:4312/', origin)).toBe('deny');
    expect(classifyNavigation('file:///etc/passwd', origin)).toBe('deny');
    expect(classifyNavigation('not a url', origin)).toBe('deny');
  });

  it('denies new windows and only hands https links to the OS', () => {
    expect(windowOpenDecision('https://example.com/help', origin)).toEqual({
      action: 'deny',
      openExternal: 'https://example.com/help',
    });
    expect(windowOpenDecision(`${origin}/`, origin)).toEqual({ action: 'deny' });
    expect(windowOpenDecision('http://evil.test/', origin)).toEqual({ action: 'deny' });
  });

  it('quits a second process when the instance lock is already held', () => {
    expect(singleInstanceDecision(true)).toBe('continue');
    expect(singleInstanceDecision(false)).toBe('quit');
  });
});
