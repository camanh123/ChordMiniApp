/**
 * Desktop history client for one lyric sidecar.
 * The renderer only calls the analysis-history lyrics route. It does not
 * receive a filesystem path and it does not start chord, beat, or lyric inference.
 */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface LyricHistoryWord {
  text: string;
  startTime: number;
  endTime: number;
}

export interface LyricHistoryRow {
  time: number;
  text: string;
  words: LyricHistoryWord[] | null;
}

export interface LyricHistoryDraft {
  parentResultSha256: string;
  source: 'lrclib' | 'local-lrc';
  trackTitle: string;
  artist: string;
  catalogDurationSeconds: number | null;
  audioDurationSeconds: number;
  granularity: 'line' | 'word';
  sourceOffsetSeconds: number;
  offsetSeconds: number;
  confirmedEdition: true;
  recognizesAudio: false;
  userModified: boolean;
  rows: LyricHistoryRow[];
}

export interface StoredLyricSidecar extends LyricHistoryDraft {
  schemaVersion: 1;
  parentId: string;
  savedAt: string;
}

export type LyricHistoryRead =
  | { state: 'ready'; lyrics: StoredLyricSidecar | null }
  | { state: 'mismatch' }
  | { state: 'missing-parent' }
  | { state: 'unavailable' };

export type LyricHistoryWrite =
  | { ok: true }
  | { ok: false; reason: 'mismatch' | 'invalid' | 'unavailable' };

function lyricsUrl(parentId: string): string {
  return `/api/desktop/analysis-history/${parentId}/lyrics`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSidecar(value: unknown, parentId: string): value is StoredLyricSidecar {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== 1 || value.parentId !== parentId) return false;
  if (value.source !== 'lrclib' && value.source !== 'local-lrc') return false;
  if (value.recognizesAudio !== false || value.confirmedEdition !== true) return false;
  if (typeof value.parentResultSha256 !== 'string' || !SHA256_HEX.test(value.parentResultSha256)) return false;
  if (!Array.isArray(value.rows)) return false;
  return true;
}

async function readBody(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const body = await response.json();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

export async function fetchLyricSidecar(
  parentId: string,
  fetchImpl: typeof fetch = fetch,
  expectedResultSha256?: string | null,
): Promise<LyricHistoryRead> {
  if (!UUID_V4.test(parentId)) return { state: 'unavailable' };
  let response: Response;
  try {
    response = await fetchImpl(lyricsUrl(parentId), {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
  } catch {
    return { state: 'unavailable' };
  }
  const body = await readBody(response);
  if (!response.ok) {
    if (body?.code === 'LYRIC_PARENT_MISMATCH') return { state: 'mismatch' };
    if (body?.code === 'RECORD_NOT_FOUND') return { state: 'missing-parent' };
    return { state: 'unavailable' };
  }
  if (!body || body.ok !== true || !('lyrics' in body)) return { state: 'unavailable' };
  if (body.lyrics === null) return { state: 'ready', lyrics: null };
  if (!isSidecar(body.lyrics, parentId)) return { state: 'unavailable' };
  if (
    expectedResultSha256
    && (!SHA256_HEX.test(expectedResultSha256) || body.lyrics.parentResultSha256 !== expectedResultSha256)
  ) {
    return { state: 'mismatch' };
  }
  if (!expectedResultSha256) return { state: 'mismatch' };
  return { state: 'ready', lyrics: body.lyrics };
}

export async function saveLyricHistory(
  parentId: string,
  draft: LyricHistoryDraft,
  fetchImpl: typeof fetch = fetch,
): Promise<LyricHistoryWrite> {
  if (!UUID_V4.test(parentId) || draft.parentResultSha256.length !== 64) {
    return { ok: false, reason: 'invalid' };
  }
  let response: Response;
  try {
    response = await fetchImpl(lyricsUrl(parentId), {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(draft),
    });
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  const body = await readBody(response);
  if (!response.ok) {
    if (body?.code === 'LYRIC_PARENT_MISMATCH') return { ok: false, reason: 'mismatch' };
    if (response.status === 400 || response.status === 413) return { ok: false, reason: 'invalid' };
    return { ok: false, reason: 'unavailable' };
  }
  if (!body || !isSidecar(body.lyrics, parentId) || body.lyrics.parentResultSha256 !== draft.parentResultSha256) {
    return { ok: false, reason: 'mismatch' };
  }
  return { ok: true };
}

export async function deleteLyricHistory(
  parentId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LyricHistoryWrite> {
  if (!UUID_V4.test(parentId)) return { ok: false, reason: 'invalid' };
  let response: Response;
  try {
    response = await fetchImpl(lyricsUrl(parentId), {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ parentId, confirmDelete: true }),
    });
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  if (response.ok) return { ok: true };
  const body = await readBody(response);
  if (body?.code === 'LYRIC_PARENT_MISMATCH') return { ok: false, reason: 'mismatch' };
  return { ok: false, reason: 'unavailable' };
}
