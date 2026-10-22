/**
 * Server-only classification of the Python analysis backend.
 * The full URL stays in process memory. Callers receive a hostname with no
 * userinfo, path, or query, and this module refuses to run in a browser.
 */

export type BackendDeploymentClass = 'remote' | 'loopback-fallback' | 'invalid';

export interface PythonBackendClassification {
  deploymentClass: BackendDeploymentClass;
  explicitlyConfigured: boolean;
  hostname: string | null;
}

export type BackendProbeStatus = 'reachable' | 'unreachable' | 'not-a-deployed-service';

export interface PythonBackendProbe {
  classification: PythonBackendClassification;
  status: BackendProbeStatus;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function assertServerBackendContext(): void {
  if (typeof window !== 'undefined') {
    throw new Error('Python backend configuration is server-only and cannot run in the browser.');
  }
}

export function classifyPythonBackend(
  env: NodeJS.ProcessEnv = process.env,
): PythonBackendClassification {
  assertServerBackendContext();

  const raw = env.PYTHON_API_URL?.trim();
  if (!raw) {
    return {
      deploymentClass: 'loopback-fallback',
      explicitlyConfigured: false,
      hostname: 'localhost',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return {
      deploymentClass: 'invalid',
      explicitlyConfigured: true,
      hostname: null,
    };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      deploymentClass: 'invalid',
      explicitlyConfigured: true,
      hostname: parsed.hostname || null,
    };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(hostname)) {
    return {
      deploymentClass: 'loopback-fallback',
      explicitlyConfigured: true,
      hostname,
    };
  }

  return {
    deploymentClass: 'remote',
    explicitlyConfigured: true,
    hostname: hostname || null,
  };
}

/**
 * A loopback or missing URL is the local development default. It is not
 * evidence of a deployed Flask service, so this probe does not connect to it.
 */
export async function probePythonBackend(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5000,
): Promise<PythonBackendProbe> {
  const classification = classifyPythonBackend(env);
  if (classification.deploymentClass !== 'remote') {
    return { classification, status: 'not-a-deployed-service' };
  }

  const raw = env.PYTHON_API_URL?.trim() ?? '';
  const origin = new URL(raw).origin;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const health = await fetchImpl(`${origin}/health`, {
      method: 'GET',
      signal: controller.signal,
    });
    if (health.ok) {
      return { classification, status: 'reachable' };
    }

    const root = await fetchImpl(`${origin}/`, {
      method: 'GET',
      signal: controller.signal,
    });
    return { classification, status: root.ok ? 'reachable' : 'unreachable' };
  } catch {
    return { classification, status: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}
