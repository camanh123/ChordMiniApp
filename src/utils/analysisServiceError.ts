export const ANALYSIS_SERVICE_UNAVAILABLE = 'ANALYSIS_SERVICE_UNAVAILABLE';
export const ANALYSIS_SERVICE_NOT_CONFIGURED = 'ANALYSIS_SERVICE_NOT_CONFIGURED';

const ANALYSIS_SERVICE_CODES = new Set<string>([
  ANALYSIS_SERVICE_UNAVAILABLE,
  ANALYSIS_SERVICE_NOT_CONFIGURED,
]);

export interface AnalysisServiceFailure {
  code: string;
  message: string;
}

export function redactDiagnosticsText(value: string): string {
  return value
    .replace(/https?:\/\/\S+/gi, '[redacted-url]')
    .replace(/\b(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\b/gi, '[redacted-host]');
}

export function readAnalysisServiceFailure(payload: unknown): AnalysisServiceFailure | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const code = typeof record.code === 'string' ? record.code : '';
  if (!ANALYSIS_SERVICE_CODES.has(code)) {
    return null;
  }
  const error = typeof record.error === 'string' ? record.error : 'Analysis service unavailable';
  const suggestion = typeof record.suggestion === 'string' ? record.suggestion : '';
  return {
    code,
    message: redactDiagnosticsText([error, suggestion].filter(Boolean).join(' ')),
  };
}

export function analysisServiceError(failure: AnalysisServiceFailure): Error & { code: string } {
  const error = new Error(failure.message) as Error & { code: string };
  error.code = failure.code;
  return error;
}

export function analysisServiceCodeFrom(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && ANALYSIS_SERVICE_CODES.has(code) ? code : null;
}

export function isAnalysisServiceError(error: unknown): boolean {
  return analysisServiceCodeFrom(error) !== null;
}

export function buildPrivacySafeDiagnostics(input: {
  code?: string | null;
  message: string;
  runtime: string;
  version: string;
}): string {
  return JSON.stringify({
    app: 'ChordMini',
    version: input.version,
    runtime: input.runtime === 'electron' ? 'electron' : 'web',
    feature: 'audio-analysis',
    code: input.code || 'unknown',
    message: redactDiagnosticsText(input.message),
  });
}
