export {
  ANALYSIS_HISTORY_MAX_AUDIO_BYTES,
  ANALYSIS_HISTORY_MAX_RECORD_BYTES,
  ANALYSIS_HISTORY_MAX_RECORDS,
  ANALYSIS_HISTORY_MAX_TIMELINE_SECONDS,
  ANALYSIS_HISTORY_MAX_TOTAL_BYTES,
  ANALYSIS_HISTORY_PIPELINE,
  ANALYSIS_HISTORY_SCHEMA_VERSION,
  analysisIdentity,
  assertRecordId,
  hashAnalysisResult,
  validateAnalysisDraft,
} from './schema';
export type {
  AnalysisHistoryRecord,
  HistoryBeat,
  HistoryChord,
  HistoryDownbeats,
  HistoryMeter,
  HistoryModels,
  HistorySource,
  HistorySynchronizedChord,
  ProvenanceValue,
} from './schema';
export { ANALYSIS_HISTORY_DIRECTORY, analysisHistoryDir } from './location';
export { AnalysisHistoryError, isAnalysisHistoryError } from './errors';
export type { AnalysisHistoryErrorCode } from './errors';
export {
  LYRIC_SIDECAR_MAX_BYTES,
  LYRIC_SIDECAR_SCHEMA_VERSION,
  buildLyricSidecar,
  lyricSidecarFileName,
  parseLyricSidecar,
  serializeLyricSidecar,
  validateLyricSidecarDraft,
} from './lyricSidecar';
export type { LyricSidecar, LyricSidecarDraft, LyricSidecarRow, LyricSidecarWord } from './lyricSidecar';
export {
  deleteAnalysisRecord,
  deleteLyricSidecar,
  listAnalysisRecords,
  readAnalysisRecord,
  readLyricSidecar,
  recoverInterruptedWrites,
  saveAnalysisRecord,
  saveLyricSidecar,
  touchAnalysisRecord,
} from './store';
export type { SaveLyricSidecarResult } from './store';
export type {
  DeleteAnalysisRecordRequest,
  HistoryList,
  HistoryStoreOptions,
  IsolatedHistoryRecord,
  SaveAnalysisResult,
} from './store';
