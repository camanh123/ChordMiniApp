/**
 * @jest-environment node
 */
import fs from 'fs';
import path from 'path';
import {
  classifyNavigation,
  createBrowserWindowOptions,
  microphonePermissionGranted,
  nonMediaPermissionCheckAllowed,
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

  it('grants microphone audio only for the owned main frame', () => {
    const allowed = {
      permission: 'media',
      isMainFrame: true,
      mediaTypes: ['audio'],
      requestingUrl: `${origin}/analyze`,
    };
    expect(microphonePermissionGranted(allowed, origin)).toBe(true);
    expect(microphonePermissionGranted({ ...allowed, mediaTypes: ['video'] }, origin)).toBe(false);
    expect(microphonePermissionGranted({ ...allowed, mediaTypes: ['audio', 'video'] }, origin)).toBe(false);
    expect(microphonePermissionGranted({ ...allowed, mediaTypes: undefined }, origin)).toBe(false);
    expect(microphonePermissionGranted({ ...allowed, permission: 'display-capture' }, origin)).toBe(false);
    expect(microphonePermissionGranted({ ...allowed, isMainFrame: false }, origin)).toBe(false);
    expect(microphonePermissionGranted({ ...allowed, requestingUrl: 'https://127.0.0.1/analyze' }, origin)).toBe(false);
    expect(microphonePermissionGranted({ ...allowed, requestingUrl: 'http://localhost:4312/analyze' }, origin)).toBe(false);
    expect(microphonePermissionGranted({ ...allowed, requestingUrl: 'http://127.0.0.1:9999/analyze' }, origin)).toBe(false);
    expect(microphonePermissionGranted({ ...allowed, requestingUrl: undefined }, origin)).toBe(false);
  });

  it('does not pre-grant media or display capture', () => {
    expect(nonMediaPermissionCheckAllowed({
      permission: 'media',
      requestingOrigin: origin,
      isMainFrame: true,
    }, origin)).toBe(false);
    expect(nonMediaPermissionCheckAllowed({
      permission: 'display-capture',
      requestingOrigin: origin,
      isMainFrame: true,
    }, origin)).toBe(false);
    expect(nonMediaPermissionCheckAllowed({
      permission: 'notifications',
      requestingOrigin: origin,
      isMainFrame: true,
    }, origin)).toBe(true);
    expect(nonMediaPermissionCheckAllowed({
      permission: 'geolocation',
      requestingOrigin: 'https://evil.test',
      isMainFrame: true,
    }, origin)).toBe(false);
    expect(nonMediaPermissionCheckAllowed({
      permission: 'notifications',
      requestingOrigin: 'http://localhost:4312',
      isMainFrame: true,
    }, origin)).toBe(false);
    expect(nonMediaPermissionCheckAllowed({
      permission: 'notifications',
      requestingOrigin: origin,
      isMainFrame: false,
    }, origin)).toBe(false);
    expect(nonMediaPermissionCheckAllowed({
      permission: 'notifications',
      requestingOrigin: '',
      isMainFrame: true,
    }, origin)).toBe(false);
  });

  it('installs microphone permission handlers before the window loads', () => {
    const main = fs.readFileSync(path.join(process.cwd(), 'src/desktop/electronMain.ts'), 'utf8');
    const policy = fs.readFileSync(path.join(process.cwd(), 'src/desktop/windowPolicy.ts'), 'utf8');
    const attach = main.indexOf('attachMicrophonePermission(owned.origin)');
    const load = main.indexOf('window.loadURL');
    expect(attach).toBeGreaterThan(0);
    expect(attach).toBeLessThan(load);
    expect(main).toContain('setPermissionRequestHandler');
    expect(main).toContain('setPermissionCheckHandler');
    expect(main).toContain('setDisplayMediaRequestHandler');
    expect(main).toContain('callback(null)');
    expect(main).not.toMatch(/preload|contextBridge/);
    expect(policy).not.toMatch(/preload|contextBridge/);
    expect(createBrowserWindowOptions().webPreferences.sandbox).toBe(true);
  });
});
