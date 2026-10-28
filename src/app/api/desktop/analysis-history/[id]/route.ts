import { deleteAnalysisRecord, readAnalysisRecord } from '@/desktop/analysisHistory';
import { AnalysisHistoryError } from '@/desktop/analysisHistory';
import {
  authorizeHistoryRequest,
  historyErrorResponse,
  historyJson,
  readHistoryBody,
} from '@/server/desktopHistoryHttp';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function recordId(context: { params: Promise<{ id: string }> | { id: string } }): Promise<string> {
  const params = await context.params;
  return params.id;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> | { id: string } },
) {
  const id = await recordId(context);
  const denied = authorizeHistoryRequest(request, `/api/desktop/analysis-history/${id}`);
  if (denied) return denied;
  try {
    const record = await readAnalysisRecord(id);
    return historyJson({ ok: true, record });
  } catch (error) {
    return historyErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> | { id: string } },
) {
  const id = await recordId(context);
  const denied = authorizeHistoryRequest(request, `/api/desktop/analysis-history/${id}`);
  if (denied) return denied;
  try {
    const body = await readHistoryBody(request);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new AnalysisHistoryError('RECORD_INVALID', 'Analysis history delete request is invalid.');
    }
    const keys = Object.keys(body as Record<string, unknown>);
    if (keys.length !== 2 || !keys.includes('recordId') || !keys.includes('confirmDelete')) {
      throw new AnalysisHistoryError('RECORD_INVALID', 'Analysis history delete request is invalid.');
    }
    const confirmation = body as { recordId?: unknown; confirmDelete?: unknown };
    if (confirmation.recordId !== id || confirmation.confirmDelete !== true) {
      throw new AnalysisHistoryError('DELETE_NOT_CONFIRMED', 'Deleting an analysis record requires an explicit confirmation for that record.');
    }
    await deleteAnalysisRecord({ recordId: id, confirmDelete: true });
    return historyJson({ ok: true, id });
  } catch (error) {
    return historyErrorResponse(error);
  }
}
