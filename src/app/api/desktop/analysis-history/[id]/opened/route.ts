import { touchAnalysisRecord } from '@/desktop/analysisHistory';
import { AnalysisHistoryError } from '@/desktop/analysisHistory';
import {
  authorizeHistoryRequest,
  historyErrorResponse,
  historyJson,
  readHistoryBody,
} from '@/server/desktopHistoryHttp';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> | { id: string } },
) {
  const params = await context.params;
  const id = params.id;
  const denied = authorizeHistoryRequest(request, `/api/desktop/analysis-history/${id}/opened`);
  if (denied) return denied;
  try {
    const body = await readHistoryBody(request);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new AnalysisHistoryError('RECORD_INVALID', 'Analysis history open request is invalid.');
    }
    const record = body as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length !== 1 || keys[0] !== 'openedAt' || typeof record.openedAt !== 'string') {
      throw new AnalysisHistoryError('RECORD_INVALID', 'Analysis history open request is invalid.');
    }
    const updated = await touchAnalysisRecord(id, record.openedAt);
    return historyJson({
      ok: true,
      id: updated.id,
      lastOpenedAt: updated.lastOpenedAt,
      resultSha256: updated.resultSha256,
    });
  } catch (error) {
    return historyErrorResponse(error);
  }
}
