import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';

import { useAnalyzePageOrchestrator } from '@/hooks/analyze/useAnalyzePageOrchestrator';
import { handleAudioAnalysis } from '@/services/audio/audioProcessingExtracted';
import { getTranscription, updateTranscriptionEnrichment } from '@/services/firebase/firestoreService';
import { getCachedAudioFile } from '@/services/firebase/firebaseStorageService';
import { detectKey } from '@/services/audio/keyDetectionService';
import {
  resetAnalysisInputSource,
  useAnalysisInputSourceStore,
} from '@/stores/analysisInputSourceStore';

jest.mock('@/services/audio/audioProcessingExtracted', () => ({
  extractAudioFromYouTube: jest.fn(),
  handleAudioAnalysis: jest.fn(),
}));

jest.mock('@/services/firebase/firestoreService', () => ({
  getTranscription: jest.fn(),
  updateTranscriptionEnrichment: jest.fn(),
}));

jest.mock('@/services/audio/keyDetectionService', () => ({
  detectKey: jest.fn(),
}));

jest.mock('@/config/firebase', () => ({
  ensureFirebaseInitialized: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/utils/firebaseConnectionManager', () => ({
  withFirebaseConnectionCheck: jest.fn((operation: () => unknown) => operation()),
}));

jest.mock('@/services/firebase/firebaseStorageService', () => ({
  getCachedAudioFile: jest.fn(),
}));

const mockHandleAudioAnalysis = handleAudioAnalysis as jest.MockedFunction<typeof handleAudioAnalysis>;
const mockGetTranscription = getTranscription as jest.MockedFunction<typeof getTranscription>;
const mockGetCachedAudioFile = getCachedAudioFile as jest.MockedFunction<typeof getCachedAudioFile>;
const mockUpdateTranscriptionEnrichment = updateTranscriptionEnrichment as jest.MockedFunction<typeof updateTranscriptionEnrichment>;
const mockDetectKey = detectKey as jest.MockedFunction<typeof detectKey>;

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  };
};

const createProps = (overrides: Record<string, unknown> = {}) => ({
  videoId: 'video-A',
  titleFromSearch: null,
  durationFromSearch: null,
  channelFromSearch: null,
  thumbnailFromSearch: null,
  firebaseReady: false,
  modelsInitialized: true,
  beatDetector: 'madmom' as const,
  chordDetector: 'chord-cnn-lstm' as const,
  beatDetectorRef: { current: 'madmom' as const },
  chordDetectorRef: { current: 'chord-cnn-lstm' as const },
  audioRef: { current: null },
  audioProcessingState: {
    isExtracting: false,
    isDownloading: false,
    isExtracted: false,
    isAnalyzing: false,
    isAnalyzed: false,
    error: null,
    suggestion: null,
    audioUrl: null,
    fromCache: false,
    fromFirestoreCache: false,
  },
  analysisResults: null,
  lyrics: null,
  showRomanNumerals: false,
  setShowExtractionNotification: jest.fn(),
  setAudioProcessingState: jest.fn(),
  setAnalysisResults: jest.fn(),
  setDuration: jest.fn(),
  setVideoTitle: jest.fn(),
  setLyrics: jest.fn(),
  setShowLyrics: jest.fn(),
  setHasCachedLyrics: jest.fn(),
  stage: 'idle' as const,
  setStage: jest.fn(),
  setProgress: jest.fn(),
  setStatusMessage: jest.fn(),
  startProcessing: jest.fn(),
  completeProcessing: jest.fn(),
  failProcessing: jest.fn(),
  updateRomanNumeralData: jest.fn(),
  analyzeAudioFromService: jest.fn(),
  skipInitialCacheBootstrap: true,
  ...overrides,
});

describe('YouTube analysis session guard in the page orchestrator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetAnalysisInputSource();
    mockGetTranscription.mockResolvedValue(null);
    mockGetCachedAudioFile.mockResolvedValue(null);
    mockUpdateTranscriptionEnrichment.mockResolvedValue(true);
    mockHandleAudioAnalysis.mockResolvedValue(undefined);
  });

  it('invalidates an in-flight analysis when the video changes and accepts the new video', async () => {
    const reads: Array<() => boolean> = [];
    const gate = deferred<void>();
    mockHandleAudioAnalysis.mockImplementation(async (deps) => {
      reads.push(() => deps.isRequestStillCurrent(deps.requestId));
      await gate.promise;
      return undefined;
    });

    const setAnalysisResults = jest.fn();
    const { result, rerender } = renderHook(
      (props: ReturnType<typeof createProps>) => useAnalyzePageOrchestrator(props as never),
      { wrapper: createWrapper(), initialProps: createProps({ setAnalysisResults }) },
    );

    void result.current.handleAudioAnalysis();
    await waitFor(() => expect(reads).toHaveLength(1));
    expect(reads[0]()).toBe(true);

    rerender(createProps({ videoId: 'video-B', setAnalysisResults, analysisResults: null }));
    expect(reads[0]()).toBe(false);
    expect(setAnalysisResults).toHaveBeenCalledWith(null);

    void result.current.handleAudioAnalysis();
    await waitFor(() => expect(reads).toHaveLength(2));
    expect(reads[1]()).toBe(true);
    expect(reads[0]()).toBe(false);
    gate.resolve();
  });

  it('invalidates an in-flight analysis when the source switches to SoundCloud', async () => {
    const reads: Array<() => boolean> = [];
    mockHandleAudioAnalysis.mockImplementation(async (deps) => {
      reads.push(() => deps.isRequestStillCurrent(deps.requestId));
      await new Promise(() => {});
      return undefined;
    });
    const setAnalysisResults = jest.fn();
    const { result } = renderHook(
      () => useAnalyzePageOrchestrator(createProps({ setAnalysisResults }) as never),
      { wrapper: createWrapper() },
    );

    void result.current.handleAudioAnalysis();
    await waitFor(() => expect(reads).toHaveLength(1));
    act(() => {
      useAnalysisInputSourceStore.getState().setSource('soundcloud');
    });
    await waitFor(() => expect(reads[0]()).toBe(false));
    expect(setAnalysisResults).not.toHaveBeenCalled();
  });

  it('invalidates an in-flight analysis when the view unmounts', async () => {
    const reads: Array<() => boolean> = [];
    mockHandleAudioAnalysis.mockImplementation(async (deps) => {
      reads.push(() => deps.isRequestStillCurrent(deps.requestId));
      await new Promise(() => {});
      return undefined;
    });
    const { result, unmount } = renderHook(
      () => useAnalyzePageOrchestrator(createProps() as never),
      { wrapper: createWrapper() },
    );

    void result.current.handleAudioAnalysis();
    await waitFor(() => expect(reads).toHaveLength(1));
    expect(reads[0]()).toBe(true);
    unmount();
    expect(reads[0]()).toBe(false);
  });

  it('does not apply a cached audio URL from A after navigation to B', async () => {
    const cache = deferred<{ audioUrl: string; duration: number; title: string } | null>();
    mockGetCachedAudioFile.mockImplementationOnce(() => cache.promise as never);
    mockGetCachedAudioFile.mockImplementation(() => new Promise(() => undefined) as never);
    const setAudioProcessingState = jest.fn();
    const setStage = jest.fn();
    const setDuration = jest.fn();
    const { rerender } = renderHook(
      (props: ReturnType<typeof createProps>) => useAnalyzePageOrchestrator(props as never),
      {
        wrapper: createWrapper(),
        initialProps: createProps({
          firebaseReady: true,
          skipInitialCacheBootstrap: false,
          setAudioProcessingState,
          setStage,
          setDuration,
        }),
      },
    );

    await waitFor(() => expect(mockGetCachedAudioFile).toHaveBeenCalled());
    rerender(createProps({
      videoId: 'video-B',
      firebaseReady: true,
      skipInitialCacheBootstrap: false,
      setAudioProcessingState,
      setStage,
      setDuration,
    }));
    await act(async () => {
      cache.resolve({ audioUrl: 'https://cdn.example/a.mp3', duration: 40, title: 'Song A' });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const publishedA = setAudioProcessingState.mock.calls.some(([updater]) => {
      if (typeof updater !== 'function') return false;
      const next = updater({
        isExtracting: false,
        isDownloading: false,
        isExtracted: false,
        isAnalyzing: false,
        isAnalyzed: false,
        error: null,
        fromCache: false,
        fromFirestoreCache: false,
      });
      return next?.audioUrl === 'https://cdn.example/a.mp3';
    });
    expect(publishedA).toBe(false);
    expect(setDuration).not.toHaveBeenCalledWith(40);
  });

  it('does not write Firestore enrichment for A after B is current', async () => {
    const detection = deferred<{
      primaryKey: string;
      modulation: null;
      corrections: Record<string, string>;
      romanNumerals: null;
    }>();
    mockDetectKey.mockImplementation(() => detection.promise as never);
    mockGetTranscription.mockResolvedValue(null);
    const { result, rerender } = renderHook(
      (props: ReturnType<typeof createProps>) => useAnalyzePageOrchestrator(props as never),
      {
        wrapper: createWrapper(),
        initialProps: createProps({
          showRomanNumerals: false,
          analysisResults: {
            chords: [
              { chord: 'C', time: 0 },
              { chord: 'G', time: 1 },
              { chord: 'C', time: 2 },
            ],
          },
        }),
      },
    );

    await waitFor(() => expect(mockDetectKey).toHaveBeenCalledTimes(1));
    rerender(createProps({
      videoId: 'video-B',
      analysisResults: null,
      showRomanNumerals: false,
    }));
    await act(async () => {
      detection.resolve({
        primaryKey: 'C major',
        modulation: null,
        corrections: {},
        romanNumerals: null,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mockUpdateTranscriptionEnrichment).not.toHaveBeenCalled();
    expect(result.current.keySignature).toBeNull();
  });
});
