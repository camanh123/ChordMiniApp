/**
 * @jest-environment node
 */

import { classifyPythonBackend, probePythonBackend } from '@/runtime/backendConnectivity';

describe('server-only Python backend classification', () => {
  const originalUrl = process.env.PYTHON_API_URL;

  afterEach(() => {
    if (originalUrl === undefined) {
      delete process.env.PYTHON_API_URL;
    } else {
      process.env.PYTHON_API_URL = originalUrl;
    }
  });

  it('treats a missing URL as the loopback default, not a deployed service', async () => {
    delete process.env.PYTHON_API_URL;
    const fetchImpl = jest.fn();

    expect(classifyPythonBackend()).toEqual({
      deploymentClass: 'loopback-fallback',
      explicitlyConfigured: false,
      hostname: 'localhost',
    });
    await expect(probePythonBackend(process.env, fetchImpl)).resolves.toMatchObject({
      status: 'not-a-deployed-service',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not treat an explicit localhost URL as a remote deployment', () => {
    process.env.PYTHON_API_URL = 'http://127.0.0.1:5001';

    expect(classifyPythonBackend()).toMatchObject({
      deploymentClass: 'loopback-fallback',
      explicitlyConfigured: true,
      hostname: '127.0.0.1',
    });
  });

  it('classifies a remote URL without returning userinfo or the path', async () => {
    process.env.PYTHON_API_URL = 'https://user:secret@ml.example.com:8443/internal?token=abc';
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });

    expect(classifyPythonBackend()).toEqual({
      deploymentClass: 'remote',
      explicitlyConfigured: true,
      hostname: 'ml.example.com',
    });

    await expect(probePythonBackend(process.env, fetchImpl, 1000)).resolves.toMatchObject({
      status: 'reachable',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://ml.example.com:8443/health',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(JSON.stringify(classifyPythonBackend())).not.toContain('secret');
  });

  it('reports an unreachable remote service and rejects invalid URLs', async () => {
    process.env.PYTHON_API_URL = 'https://ml.example.com';
    const fetchImpl = jest.fn().mockRejectedValue(new Error('offline'));

    await expect(probePythonBackend(process.env, fetchImpl, 1000)).resolves.toMatchObject({
      status: 'unreachable',
    });

    process.env.PYTHON_API_URL = 'not a url';
    expect(classifyPythonBackend().deploymentClass).toBe('invalid');
  });
});
