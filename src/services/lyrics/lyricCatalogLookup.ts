/**
 * Catalog lyric lookup. The request carries artist, title, and duration only.
 * It does not upload audio and it does not start beat or chord inference.
 */

import { searchLyricsWithFallback } from '@/services/lyrics/lyricsService';
import {
  candidateFromLrclib,
  type CatalogLyricCandidate,
} from '@/services/lyrics/lyricChordAlignment';

export interface CatalogSearchParams {
  artist: string;
  title: string;
  duration: number;
  prefer_synchronized: true;
}

export interface CatalogLookupResult {
  ok: boolean;
  candidates: CatalogLyricCandidate[];
  error?: string;
}

export function catalogSearchParams(input: {
  artist: string;
  title: string;
  audioDurationSeconds: number;
}): CatalogSearchParams {
  return {
    artist: input.artist.trim(),
    title: input.title.trim(),
    duration: input.audioDurationSeconds,
    prefer_synchronized: true,
  };
}

export async function lookupCatalogLyrics(input: {
  artist: string;
  title: string;
  audioDurationSeconds: number;
}): Promise<CatalogLookupResult> {
  const params = catalogSearchParams(input);
  if (!params.artist || !params.title) {
    return { ok: false, candidates: [], error: 'missing-query' };
  }
  try {
    const response = await searchLyricsWithFallback(params);
    const listed = response.candidates && response.candidates.length > 0
      ? response.candidates
      : response.synchronized_lyrics
        ? [{
            id: response.metadata.lrclib_id,
            trackName: response.metadata.title,
            artistName: response.metadata.artist,
            duration: response.metadata.duration,
            instrumental: false,
            lyric_mode: response.lyric_mode,
            synchronized_lyrics: response.synchronized_lyrics,
            lyrics: response.lyrics,
          }]
        : [];
    const candidates = listed.map((candidate) => candidateFromLrclib(candidate));
    return {
      ok: candidates.length > 0,
      candidates,
      error: candidates.length > 0 ? undefined : response.error,
    };
  } catch {
    return { ok: false, candidates: [], error: 'lookup-failed' };
  }
}
