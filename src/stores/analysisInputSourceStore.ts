/**
 * One selected analysis input for the initial picker and the results strip.
 * Changing the source does not read or write analysis results.
 * SoundCloud lookup is metadata only. It does not call chord or beat inference.
 */

import { create } from 'zustand';
import {
  clearRecordingHold,
  holdReadyRecordingForNavigation,
  releaseRecordingTracks,
  resetMicrophoneRecordingState,
} from '@/services/audio/microphoneRecording';
import { noteSourceSelected, resetAnalysisDiagnostics } from '@/services/audio/analysisDiagnostics';
import {
  isOfficialSoundCloudPlayerUrl,
  isSafeSoundCloudThumbnail,
  parseSoundCloudLink,
} from '@/services/soundcloud/soundCloudLink';

export const ANALYSIS_INPUT_SOURCES = ['youtube', 'soundcloud', 'local-audio', 'microphone'] as const;
export type AnalysisInputSource = typeof ANALYSIS_INPUT_SOURCES[number];

export type SoundCloudLookup =
  | { status: 'idle' }
  | { status: 'invalid' }
  | { status: 'loading'; url: string }
  | { status: 'unavailable'; url: string }
  | {
      status: 'ready';
      url: string;
      title: string;
      author: string;
      thumbnail: string | null;
      playerUrl: string;
    };

interface AnalysisInputSourceState {
  source: AnalysisInputSource;
  appliedRouteKey: string | null;
  captureGeneration: number;
  soundCloudInput: string;
  soundCloudLookup: SoundCloudLookup;
  setSource: (source: AnalysisInputSource) => void;
  setSoundCloudInput: (value: string) => void;
}

let lookupToken = 0;
let pendingRouteSource: AnalysisInputSource | null = null;

export const useAnalysisInputSourceStore = create<AnalysisInputSourceState>((set, get) => ({
  source: 'youtube',
  appliedRouteKey: null,
  captureGeneration: 0,
  soundCloudInput: '',
  soundCloudLookup: { status: 'idle' },
  setSource: (source) => {
    if (get().source === source) return;
    pendingRouteSource = null;
    clearRecordingHold();
    releaseRecordingTracks();
    set({ source, captureGeneration: get().captureGeneration + 1 });
    noteSourceSelected(source);
  },
  setSoundCloudInput: (value) => set({ soundCloudInput: value }),
}));

export function useAnalysisInputSource(): AnalysisInputSource {
  return useAnalysisInputSourceStore((state) => state.source);
}

export function capturePublicationSnapshot(): { source: AnalysisInputSource; generation: number } {
  const state = useAnalysisInputSourceStore.getState();
  return { source: state.source, generation: state.captureGeneration };
}

export function publishLocalAnalysisAllowed(
  expected?: { source: AnalysisInputSource; generation: number },
): boolean {
  const state = useAnalysisInputSourceStore.getState();
  if (state.source !== 'local-audio' && state.source !== 'microphone') return false;
  if (!expected) return true;
  return state.source === expected.source && state.captureGeneration === expected.generation;
}

export function armMicrophoneContinue(): void {
  pendingRouteSource = 'microphone';
  holdReadyRecordingForNavigation();
}

export function applyRouteIntent(routeKey: string, fallback: AnalysisInputSource): void {
  const state = useAnalysisInputSourceStore.getState();
  if (state.appliedRouteKey === routeKey) return;
  const armedMicrophone = pendingRouteSource === 'microphone';
  pendingRouteSource = null;
  const chosen = armedMicrophone ? 'microphone' : fallback;
  if (state.source !== chosen) {
    if (!armedMicrophone) clearRecordingHold();
    releaseRecordingTracks();
    useAnalysisInputSourceStore.setState({
      source: chosen,
      appliedRouteKey: routeKey,
      captureGeneration: state.captureGeneration + 1,
    });
    noteSourceSelected(chosen);
    return;
  }
  useAnalysisInputSourceStore.setState({ appliedRouteKey: routeKey });
}

export function startYouTubeAnalysisAllowed(): boolean {
  return useAnalysisInputSourceStore.getState().source === 'youtube';
}

export function resetAnalysisInputSource(): void {
  lookupToken += 1;
  pendingRouteSource = null;
  resetMicrophoneRecordingState();
  resetAnalysisDiagnostics();
  useAnalysisInputSourceStore.setState({
    source: 'youtube',
    appliedRouteKey: null,
    captureGeneration: 0,
    soundCloudInput: '',
    soundCloudLookup: { status: 'idle' },
  });
}

function readLookupPayload(payload: unknown, expectedUrl: string): Extract<SoundCloudLookup, { status: 'ready' }> | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  if (record.success !== true || record.inference !== false) return null;
  if (record.canonicalUrl !== expectedUrl) return null;
  if (typeof record.title !== 'string' || !record.title.trim()) return null;
  if (typeof record.playerUrl !== 'string' || !isOfficialSoundCloudPlayerUrl(record.playerUrl)) return null;
  const author = typeof record.author === 'string' && record.author.trim()
    ? record.author.trim()
    : 'SoundCloud';
  const thumbnail = typeof record.thumbnail === 'string' && isSafeSoundCloudThumbnail(record.thumbnail)
    ? record.thumbnail
    : null;
  return {
    status: 'ready',
    url: expectedUrl,
    title: record.title.trim(),
    author,
    thumbnail,
    playerUrl: record.playerUrl,
  };
}

export async function requestSoundCloudLookup(raw: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const parsed = parseSoundCloudLink(raw);
  if (!parsed.ok) {
    lookupToken += 1;
    useAnalysisInputSourceStore.setState({ soundCloudLookup: { status: 'invalid' } });
    return;
  }
  const current = useAnalysisInputSourceStore.getState().soundCloudLookup;
  if (
    (current.status === 'ready' || current.status === 'loading')
    && current.url === parsed.url
  ) {
    return;
  }
  const token = ++lookupToken;
  useAnalysisInputSourceStore.setState({ soundCloudLookup: { status: 'loading', url: parsed.url } });
  const endpoint = `/api/soundcloud/official-metadata?url=${encodeURIComponent(parsed.url)}`;
  try {
    const response = await fetchImpl(endpoint, { cache: 'no-store' });
    if (token !== lookupToken) return;
    if (!response.ok) {
      useAnalysisInputSourceStore.setState({ soundCloudLookup: { status: 'unavailable', url: parsed.url } });
      return;
    }
    const ready = readLookupPayload(await response.json(), parsed.url);
    if (token !== lookupToken) return;
    useAnalysisInputSourceStore.setState({
      soundCloudLookup: ready ?? { status: 'unavailable', url: parsed.url },
    });
  } catch {
    if (token !== lookupToken) return;
    useAnalysisInputSourceStore.setState({ soundCloudLookup: { status: 'unavailable', url: parsed.url } });
  }
}
