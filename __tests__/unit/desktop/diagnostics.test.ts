/**
 * @jest-environment node
 */
import { sanitizeDiagnostic } from '@/desktop/diagnostics';

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
});
