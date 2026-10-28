export type AnalysisHistoryErrorCode =
  | 'STORAGE_ROOT_UNSAFE'
  | 'PATH_UNSAFE'
  | 'RECORD_INVALID'
  | 'PAYLOAD_TOO_LARGE'
  | 'SCHEMA_UNSUPPORTED'
  | 'CAPACITY_EXCEEDED'
  | 'STORAGE_UNAVAILABLE'
  | 'RECORD_NOT_FOUND'
  | 'DELETE_NOT_CONFIRMED'
  | 'RECORD_CORRUPT'
  | 'LYRIC_PARENT_MISMATCH';

export class AnalysisHistoryError extends Error {
  readonly code: AnalysisHistoryErrorCode;

  constructor(code: AnalysisHistoryErrorCode, message: string) {
    super(message);
    this.name = 'AnalysisHistoryError';
    this.code = code;
  }
}

export function isAnalysisHistoryError(error: unknown): error is AnalysisHistoryError {
  return error instanceof AnalysisHistoryError;
}
