import { AnalysisHistoryError, deleteLyricSidecar, readLyricSidecar, saveLyricSidecar } from '@/desktop/analysisHistory';
import {
  authorizeHistoryRequest,
  historyErrorResponse,
  historyJson,
  readHistoryBody,
} from '@/server/desktopHistoryHttp';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function recordId(context: { params: Promise<{ id: string }> }): Promise<string> {
  const params = await context.params;
  return params.id;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const id = await recordId(context);
  const denied = authorizeHistoryRequest(request, `/api/desktop/analysis-history/${id}/lyrics`);
  if (denied) return denied;
  try {
    const lyrics = await readLyricSidecar(id);
    return historyJson({ ok: true, lyrics });
  } catch (error) {
    return historyErrorResponse(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const id = await recordId(context);
  const denied = authorizeHistoryRequest(request, `/api/desktop/analysis-history/${id}/lyrics`);
  if (denied) return denied;
  try {
    const body = await readHistoryBody(request);
    const saved = await saveLyricSidecar(id, body);
    return historyJson({ ok: true, lyrics: saved.lyrics }, saved.created ? 201 : 200);
  } catch (error) {
    return historyErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const id = await recordId(context);
  const denied = authorizeHistoryRequest(request, `/api/desktop/analysis-history/${id}/lyrics`);
  if (denied) return denied;
  try {
    const body = await readHistoryBody(request);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new AnalysisHistoryError('RECORD_INVALID', 'Lyric sidecar delete request is invalid.');
    }
    const keys = Object.keys(body as Record<string, unknown>);
    if (keys.length !== 2 || !keys.includes('parentId') || !keys.includes('confirmDelete')) {
      throw new AnalysisHistoryError('RECORD_INVALID', 'Lyric sidecar delete request is invalid.');
    }
    const confirmation = body as { parentId?: unknown; confirmDelete?: unknown };
    if (confirmation.parentId !== id || confirmation.confirmDelete !== true) {
      throw new AnalysisHistoryError('DELETE_NOT_CONFIRMED', 'Deleting lyrics requires an explicit confirmation for that analysis.');
    }
    await deleteLyricSidecar(id);
    return historyJson({ ok: true, parentId: id });
  } catch (error) {
    return historyErrorResponse(error);
  }
}
