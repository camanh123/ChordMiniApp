/**
 * @jest-environment jsdom
 */

import { classifyPythonBackend } from '@/runtime/backendConnectivity';

describe('Python backend classification in the browser', () => {
  it('refuses to read the server URL from renderer code', () => {
    expect(typeof window).toBe('object');
    expect(() => classifyPythonBackend()).toThrow(/server-only/);
  });
});
