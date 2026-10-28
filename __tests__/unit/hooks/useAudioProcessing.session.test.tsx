import { act, renderHook, waitFor } from '@testing-library/react';

import { useAudioProcessing } from '@/hooks/audio/useAudioProcessing';
import { resetAnalysisInputSource } from '@/stores/analysisInputSourceStore';

const mockAnalyzeAudioFile = jest.fn();

jest.mock('@/services/audio/audioProcessingService', () => ({
  AudioProcessingService: {
    getInstance: () => ({
      analyzeAudioFile: (...args: unknown[]) => mockAnalyzeAudioFile(...args),
      createInitialState: () => ({
        isDownloading: false,
        isExtracting: false,
        isExtracted: false,
        isAnalyzing: false,
        isAnalyzed: false,
        error: null,
        fromCache: false,
        fromFirestoreCache: false,
      }),
      updateStateForAnalysisStart: (prev: { isAnalyzing: boolean }) => ({ ...prev, isAnalyzing: true }),
      updateStateForAnalysisSuccess: (prev: { isAnalyzed: boolean }) => ({
        ...prev,
        isAnalyzing: false,
        isAnalyzed: true,
      }),
      updateStateForAnalysisError: (prev: { error: string | null }, message: string) => ({
        ...prev,
        isAnalyzing: false,
        error: message,
      }),
    }),
  },
}));

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useAudioProcessing session publication', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetAnalysisInputSource();
  });

  it('does not publish results or errors after the session is no longer current', async () => {
    const analysis = deferred<{ chords: Array<{ chord: string }> }>();
    mockAnalyzeAudioFile.mockImplementation(() => analysis.promise);
    let allowed = true;
    const { result } = renderHook(() => useAudioProcessing('video-A'));

    await act(async () => {
      const pending = result.current.analyzeAudio(
        'https://example.com/a.mp3',
        'madmom',
        'chord-cnn-lstm',
        { persistAllowed: () => allowed },
      );
      allowed = false;
      analysis.resolve({ chords: [{ chord: 'A' }] });
      await pending;
    });

    expect(result.current.analysisResults).toBeNull();
    expect(result.current.state.isAnalyzed).toBe(false);
  });

  it('does not publish an error that arrives after invalidation', async () => {
    const analysis = deferred<never>();
    mockAnalyzeAudioFile.mockImplementation(() => analysis.promise);
    let allowed = true;
    const { result } = renderHook(() => useAudioProcessing('video-A'));

    await act(async () => {
      const pending = result.current.analyzeAudio(
        'https://example.com/a.mp3',
        'madmom',
        'chord-cnn-lstm',
        { persistAllowed: () => allowed },
      );
      allowed = false;
      analysis.reject(new Error('A failed'));
      await expect(pending).rejects.toThrow('A failed');
    });
    await waitFor(() => expect(result.current.state.error).toBeNull());
    expect(result.current.analysisResults).toBeNull();
    expect(result.current.state.isAnalyzed).toBe(false);
  });

  it('publishes results while the same video session remains current', async () => {
    mockAnalyzeAudioFile.mockResolvedValue({ chords: [{ chord: 'G' }] });
    const { result } = renderHook(() => useAudioProcessing('video-B'));

    await act(async () => {
      await result.current.analyzeAudio(
        'https://example.com/b.mp3',
        'madmom',
        'chord-cnn-lstm',
        { persistAllowed: () => true },
      );
    });

    await waitFor(() => expect(result.current.analysisResults).toEqual({ chords: [{ chord: 'G' }] }));
    expect(result.current.state.isAnalyzed).toBe(true);
  });
});
