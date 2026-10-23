/**
 * @jest-environment node
 */
import { sanitizeDiagnostic, secretsFromEnv } from '@/desktop/diagnostics';

describe('desktop diagnostics', () => {
  it('redacts ready tokens and backend URLs before they reach a log', () => {
    const token = 'ready-token-value';
    const backend = 'https://analysis.example/private-token-value';
    const text = `failed CHORDMINI_READY_TOKEN=${token} PYTHON_API_URL=${backend} port=4312`;

    const sanitized = sanitizeDiagnostic(text, [token, backend]);

    expect(sanitized).not.toContain(token);
    expect(sanitized).not.toContain(backend);
    expect(sanitized).toContain('port=4312');
    expect(sanitized).toContain('CHORDMINI_READY_TOKEN=[redacted]');
    expect(sanitized).toContain('PYTHON_API_URL=[redacted]');
  });

  it('redacts an inference secret from diagnostics', () => {
    const secret = 'inference-secret-value-0123456789abcdef';
    const env = { CHORDMINI_INFERENCE_SECRET: secret };
    const sanitized = sanitizeDiagnostic(
      `failed CHORDMINI_INFERENCE_SECRET=${secret} ready`,
      secretsFromEnv(env),
    );

    expect(secretsFromEnv(env)).toContain(secret);
    expect(sanitized).not.toContain(secret);
    expect(sanitized).toContain('CHORDMINI_INFERENCE_SECRET=[redacted]');
    expect(sanitized).toContain('ready');
  });

  it('redacts a hosted gateway URL from diagnostics', () => {
    const gateway = 'https://gateway.example.test';
    const env = { CHORDMINI_HOSTED_GATEWAY_URL: gateway };
    const sanitized = sanitizeDiagnostic(
      `CHORDMINI_HOSTED_GATEWAY_URL=${gateway} ready`,
      secretsFromEnv(env),
    );

    expect(sanitized).not.toContain(gateway);
    expect(sanitized).toContain('CHORDMINI_HOSTED_GATEWAY_URL=[redacted]');
  });

  it('redacts a staging uid allowlist from diagnostics', () => {
    const allowlist = 'owner-uid-0123456789abcdef';
    const env = { CHORDMINI_STAGING_ALLOWED_UIDS: allowlist };
    const sanitized = sanitizeDiagnostic(
      `CHORDMINI_STAGING_ALLOWED_UIDS=${allowlist} ready`,
      secretsFromEnv(env),
    );

    expect(sanitized).not.toContain(allowlist);
    expect(sanitized).toContain('CHORDMINI_STAGING_ALLOWED_UIDS=[redacted]');
  });
});
