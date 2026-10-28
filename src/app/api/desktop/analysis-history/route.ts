import { assertRecordId, listAnalysisRecords, saveAnalysisRecord } from '@/desktop/analysisHistory';
import type { AnalysisHistoryRecord } from '@/desktop/analysisHistory';
import { AnalysisHistoryError } from '@/desktop/analysisHistory';
import {
  HISTORY_COLLECTION_PATH,
  authorizeHistoryRequest,
  historyErrorResponse,
  historyJson,
  historyPageSize,
  readHistoryBody,
} from '@/server/desktopHistoryHttp';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Local analysis history for the desktop shell.
 * source.contentSha256 is supplied by the caller. This server does not see
 * the audio bytes, so it cannot attest that the hash matches a file.
 */

function summary(record: AnalysisHistoryRecord) {
  return {
    schemaVersion: record.schemaVersion,
    id: record.id,
    source: record.source,
    analyzedAt: record.analyzedAt,
    lastOpenedAt: record.lastOpenedAt,
    audioDurationSeconds: record.audioDurationSeconds,
    models: record.models,
    meter: record.meter,
    bpm: record.bpm,
    key: record.key,
    status: record.status,
    provenance: record.provenance,
    resultSha256: record.resultSha256,
    chordPreview: chordPreview(record),
  };
}

function chordPreview(record: AnalysisHistoryRecord): string[] {
  const labels: string[] = [];
  for (const chord of record.chords) {
    const label = chord.chord;
    if (!label || labels[labels.length - 1] === label) continue;
    labels.push(label);
    if (labels.length >= 8) break;
  }
  return labels;
}

export async function GET(request: Request) {
  const denied = authorizeHistoryRequest(request, HISTORY_COLLECTION_PATH);
  if (denied) return denied;
  try {
    const url = new URL(request.url);
    for (const key of url.searchParams.keys()) {
      if (key !== 'limit' && key !== 'cursor') {
        throw new AnalysisHistoryError('RECORD_INVALID', 'Analysis history query is not supported.');
      }
    }
    const limit = historyPageSize(url.searchParams.get('limit'));
    const cursor = url.searchParams.get('cursor');
    if (cursor !== null) assertRecordId(cursor);
    const listed = await listAnalysisRecords();
    let start = 0;
    if (cursor) {
      const index = listed.records.findIndex((record) => record.id === cursor);
      if (index < 0) {
        throw new AnalysisHistoryError('RECORD_INVALID', 'Analysis history page cursor was not found.');
      }
      start = index + 1;
    }
    const page = listed.records.slice(start, start + limit);
    const nextCursor = start + limit < listed.records.length ? page[page.length - 1]?.id ?? null : null;
    return historyJson({
      ok: true,
      records: page.map(summary),
      nextCursor,
      isolatedCount: listed.isolated.length,
    });
  } catch (error) {
    return historyErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const denied = authorizeHistoryRequest(request, HISTORY_COLLECTION_PATH);
  if (denied) return denied;
  try {
    const body = await readHistoryBody(request);
    const saved = await saveAnalysisRecord(body);
    return historyJson({
      ok: true,
      created: saved.created,
      id: saved.record.id,
      record: saved.record,
    }, saved.created ? 201 : 200);
  } catch (error) {
    return historyErrorResponse(error);
  }
}
