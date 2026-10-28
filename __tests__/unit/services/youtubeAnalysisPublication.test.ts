import { handleAudioAnalysis } from '@/services/audio/audioProcessingExtracted';
import type { AudioProcessingServiceDependencies } from '@/services/audio/audioProcessingExtracted';
import { createYouTubeAnalysisSession } from '@/services/youtube/youtubeAnalysisSession';
import {
  createAnalysisSessionController,
  runGuardedAnalysis,
} from '@/components/analysis/localAnalysisSession';

jest.mock('@/config/api', () => ({
  apiPost: jest.fn(),
}));

jest.mock('@/services/firebase/firestoreService', () => ({
  getTranscription: jest.fn(),
}));

async function waitForCall(mock: jest.Mock): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (mock.mock.calls.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Expected the analysis request to start');
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const cachedA = {
  videoId: 'video-A',
  beatModel: 'madmom',
  chordModel: 'chord-cnn-lstm',
  chords: [{ chord: 'A', time: 0 }],
  beats: [{ time: 0, beatNum: 1 }],
  downbeats: [0],
  downbeats_with_measures: [0],
  synchronizedChords: [{ chord: 'A', beatIndex: 0 }],
  audioDuration: 30,
  timeSignature: 4,
  bpm: 100,
};

function createDeps(
  session: ReturnType<typeof createYouTubeAnalysisSession>,
  lease: ReturnType<ReturnType<typeof createYouTubeAnalysisSession>['observe']>,
  overrides: Partial<AudioProcessingServiceDependencies> = {},
): AudioProcessingServiceDependencies {
  return {
    setAudioProcessingState: jest.fn(),
    setAnalysisResults: jest.fn(),
    setDuration: jest.fn(),
    setShowExtractionNotification: jest.fn(),
    setLyrics: jest.fn(),
    setShowLyrics: jest.fn(),
    setHasCachedLyrics: jest.fn(),
    setActiveTab: jest.fn(),
    setIsTranscribingLyrics: jest.fn(),
    setLyricsError: jest.fn(),
    processingContext: {
      stage: '',
      progress: 0,
      setStage: jest.fn(),
      setProgress: jest.fn(),
      setStatusMessage: jest.fn(),
      startProcessing: jest.fn(),
      completeProcessing: jest.fn(),
      failProcessing: jest.fn(),
    },
    analyzeAudioFromService: jest.fn(),
    audioRef: { current: null },
    extractionLockRef: { current: false },
    beatDetectorRef: { current: 'madmom' },
    chordDetectorRef: { current: 'chord-cnn-lstm' },
    videoId: lease.videoId,
    titleFromSearch: null,
    durationFromSearch: null,
    channelFromSearch: null,
    thumbnailFromSearch: null,
    audioProcessingState: {
      isExtracting: false,
      isDownloading: false,
      isExtracted: true,
      isAnalyzing: false,
      isAnalyzed: false,
      error: null,
      audioUrl: 'https://example.com/a.mp3',
      fromCache: false,
      fromFirestoreCache: false,
    },
    beatDetector: 'madmom',
    chordDetector: 'chord-cnn-lstm',
    progress: 0,
    lyrics: null,
    requestId: `analysis-${lease.videoId}-${lease.generation}`,
    isRequestStillCurrent: () => session.isCurrent(lease),
    ...overrides,
  };
}

describe('YouTube analysis publication races', () => {
  it('drops video A results, errors and processing updates after navigation to B', async () => {
    const session = createYouTubeAnalysisSession({ videoId: 'video-A', source: 'youtube' });
    const leaseA = session.start('video-A', 'youtube');
    const analysis = deferred<{ audioDuration: number; chords: Array<{ chord: string; time: number }> }>();
    const deps = createDeps(session, leaseA, {
      analyzeAudioFromService: jest.fn(() => analysis.promise) as AudioProcessingServiceDependencies['analyzeAudioFromService'],
      loadTranscriptionSnapshot: jest.fn(async () => null),
    });

    const pending = handleAudioAnalysis(deps);
    await waitForCall(deps.analyzeAudioFromService as jest.Mock);
    session.adopt('video-B', 'youtube');
    analysis.resolve({ audioDuration: 12, chords: [{ chord: 'A', time: 0 }] });
    await pending;

    expect(deps.setAnalysisResults).not.toHaveBeenCalled();
    expect(deps.setAudioProcessingState).not.toHaveBeenCalled();
    expect(deps.setDuration).not.toHaveBeenCalled();
    expect(deps.processingContext.completeProcessing).not.toHaveBeenCalled();
    expect(deps.processingContext.failProcessing).not.toHaveBeenCalled();
    expect(deps.processingContext.setStage).not.toHaveBeenCalledWith('complete');
    expect(deps.processingContext.setProgress).not.toHaveBeenCalledWith(100);
  });

  it('drops a cache payload for A after navigation to B', async () => {
    const session = createYouTubeAnalysisSession({ videoId: 'video-A', source: 'youtube' });
    const leaseA = session.start('video-A', 'youtube');
    const cache = deferred<typeof cachedA>();
    const deps = createDeps(session, leaseA, {
      loadTranscriptionSnapshot: jest.fn(() => cache.promise),
    });

    const pending = handleAudioAnalysis(deps);
    session.adopt('video-B', 'youtube');
    cache.resolve(cachedA);
    await pending;

    expect(deps.setAnalysisResults).not.toHaveBeenCalled();
    expect(deps.setAudioProcessingState).not.toHaveBeenCalled();
    expect(deps.processingContext.setStage).not.toHaveBeenCalled();
    expect(deps.processingContext.completeProcessing).not.toHaveBeenCalled();
    expect(deps.processingContext.setProgress).not.toHaveBeenCalled();
  });

  it('drops video A after the source changes to SoundCloud', async () => {
    const session = createYouTubeAnalysisSession({ videoId: 'video-A', source: 'youtube' });
    const leaseA = session.start('video-A', 'youtube');
    const analysis = deferred<{ audioDuration: number }>();
    const deps = createDeps(session, leaseA, {
      analyzeAudioFromService: jest.fn(() => analysis.promise) as AudioProcessingServiceDependencies['analyzeAudioFromService'],
      loadTranscriptionSnapshot: jest.fn(async () => null),
    });

    const pending = handleAudioAnalysis(deps);
    await waitForCall(deps.analyzeAudioFromService as jest.Mock);
    session.adopt('video-A', 'soundcloud');
    analysis.resolve({ audioDuration: 8 });
    await pending;

    expect(deps.setAnalysisResults).not.toHaveBeenCalled();
    expect(deps.processingContext.completeProcessing).not.toHaveBeenCalled();
    expect(deps.processingContext.setStage).not.toHaveBeenCalledWith('complete');
    expect(deps.processingContext.setProgress).not.toHaveBeenCalledWith(100);
  });

  it('drops video A after the owning view unmounts', async () => {
    const session = createYouTubeAnalysisSession({ videoId: 'video-A', source: 'youtube' });
    const leaseA = session.start('video-A', 'youtube');
    const analysis = deferred<{ audioDuration: number }>();
    const deps = createDeps(session, leaseA, {
      analyzeAudioFromService: jest.fn(() => analysis.promise) as AudioProcessingServiceDependencies['analyzeAudioFromService'],
      loadTranscriptionSnapshot: jest.fn(async () => null),
    });

    const pending = handleAudioAnalysis(deps);
    await waitForCall(deps.analyzeAudioFromService as jest.Mock);
    session.setMounted(false);
    analysis.resolve({ audioDuration: 8 });
    await pending;

    expect(deps.setAnalysisResults).not.toHaveBeenCalled();
    expect(deps.processingContext.completeProcessing).not.toHaveBeenCalled();
    expect(deps.processingContext.failProcessing).not.toHaveBeenCalled();
    expect(deps.processingContext.setStage).not.toHaveBeenCalledWith('complete');
    expect(deps.processingContext.setProgress).not.toHaveBeenCalledWith(100);
  });

  it('ignores an error from A after B has become current', async () => {
    const session = createYouTubeAnalysisSession({ videoId: 'video-A', source: 'youtube' });
    const leaseA = session.start('video-A', 'youtube');
    const analysis = deferred<never>();
    const deps = createDeps(session, leaseA, {
      analyzeAudioFromService: jest.fn(() => analysis.promise) as AudioProcessingServiceDependencies['analyzeAudioFromService'],
      loadTranscriptionSnapshot: jest.fn(async () => null),
    });

    const pending = handleAudioAnalysis(deps);
    await waitForCall(deps.analyzeAudioFromService as jest.Mock);
    session.adopt('video-B', 'youtube');
    analysis.reject(new Error('backend failed for A'));
    await expect(pending).resolves.toBeUndefined();

    expect(deps.processingContext.failProcessing).not.toHaveBeenCalled();
    expect(deps.setAnalysisResults).not.toHaveBeenCalled();
    expect(deps.setAudioProcessingState).not.toHaveBeenCalled();
  });

  it('lets video B publish after a late resolution from A', async () => {
    const session = createYouTubeAnalysisSession({ videoId: 'video-A', source: 'youtube' });
    const leaseA = session.start('video-A', 'youtube');
    const analysisA = deferred<{ audioDuration: number; chords: Array<{ chord: string; time: number }> }>();
    const depsA = createDeps(session, leaseA, {
      analyzeAudioFromService: jest.fn(() => analysisA.promise) as AudioProcessingServiceDependencies['analyzeAudioFromService'],
      loadTranscriptionSnapshot: jest.fn(async () => null),
    });

    const pendingA = handleAudioAnalysis(depsA);
    await waitForCall(depsA.analyzeAudioFromService as jest.Mock);
    session.adopt('video-B', 'youtube');
    const leaseB = session.start('video-B', 'youtube');
    const analysisB = deferred<{ audioDuration: number; chords: Array<{ chord: string; time: number }> }>();
    const depsB = createDeps(session, leaseB, {
      videoId: 'video-B',
      analyzeAudioFromService: jest.fn(() => analysisB.promise) as AudioProcessingServiceDependencies['analyzeAudioFromService'],
      loadTranscriptionSnapshot: jest.fn(async () => null),
      audioProcessingState: {
        isExtracting: false,
        isDownloading: false,
        isExtracted: true,
        isAnalyzing: false,
        isAnalyzed: false,
        error: null,
        audioUrl: 'https://example.com/b.mp3',
        fromCache: false,
        fromFirestoreCache: false,
      },
    });
    const pendingB = handleAudioAnalysis(depsB);

    analysisA.resolve({ audioDuration: 10, chords: [{ chord: 'A', time: 0 }] });
    await pendingA;
    analysisB.resolve({ audioDuration: 20, chords: [{ chord: 'B', time: 1 }] });
    await pendingB;

    expect(depsA.setAnalysisResults).not.toHaveBeenCalled();
    expect(depsA.processingContext.completeProcessing).not.toHaveBeenCalled();
    expect(depsA.processingContext.setStage).not.toHaveBeenCalledWith('complete');
    expect(depsA.processingContext.setProgress).not.toHaveBeenCalledWith(100);
    expect(depsB.processingContext.completeProcessing).toHaveBeenCalledTimes(1);
    expect(depsB.setDuration).toHaveBeenCalledWith(20);
    expect(depsB.analyzeAudioFromService).toHaveBeenCalledWith(
      'https://example.com/b.mp3',
      'madmom',
      'chord-cnn-lstm',
      expect.objectContaining({
        persistAllowed: expect.any(Function),
      }),
    );
    const options = (depsB.analyzeAudioFromService as jest.Mock).mock.calls[0][3];
    expect(options.persistAllowed()).toBe(true);
  });

  it('loads a saved transcription without beat or chord inference stages', async () => {
    const session = createYouTubeAnalysisSession({ videoId: 'video-A', source: 'youtube' });
    const leaseA = session.start('video-A', 'youtube');
    const deps = createDeps(session, leaseA, {
      loadTranscriptionSnapshot: jest.fn(async () => cachedA),
    });

    const result = await handleAudioAnalysis(deps);

    expect(result?.chords).toEqual([{ chord: 'A', time: 0 }]);
    expect(deps.processingContext.setStage).toHaveBeenNthCalledWith(1, 'cache-loading');
    expect(deps.processingContext.setStage).toHaveBeenNthCalledWith(2, 'cache-loaded');
    expect(deps.processingContext.setStage).not.toHaveBeenCalledWith('beat-detection');
    expect(deps.processingContext.setStage).not.toHaveBeenCalledWith('chord-recognition');
    expect(deps.processingContext.setStage).not.toHaveBeenCalledWith('complete');
    expect(deps.processingContext.startProcessing).not.toHaveBeenCalled();
    expect(deps.processingContext.completeProcessing).not.toHaveBeenCalled();
    expect(deps.processingContext.setStatusMessage).toHaveBeenCalledWith('Loading saved analysis results');
    expect(deps.processingContext.setStatusMessage).toHaveBeenCalledWith('Saved analysis results loaded');
    expect(deps.analyzeAudioFromService).not.toHaveBeenCalled();
    const publish = (deps.setAudioProcessingState as jest.Mock).mock.calls[0][0] as (
      prev: { isAnalyzed: boolean; fromFirestoreCache: boolean },
    ) => { isAnalyzed: boolean; fromFirestoreCache: boolean };
    expect(publish({ isAnalyzed: false, fromFirestoreCache: false })).toMatchObject({
      isAnalyzed: true,
      fromFirestoreCache: true,
    });
    expect(deps.setAnalysisResults).toHaveBeenCalledWith(expect.objectContaining({
      chords: [{ chord: 'A', time: 0 }],
    }));
  });

  it('does not publish cached video A results when B becomes current during loading', async () => {
    const session = createYouTubeAnalysisSession({ videoId: 'video-A', source: 'youtube' });
    const leaseA = session.start('video-A', 'youtube');
    const deps = createDeps(session, leaseA, {
      loadTranscriptionSnapshot: jest.fn(async () => cachedA),
    });
    (deps.processingContext.setStage as jest.Mock).mockImplementation((stage: string) => {
      if (stage === 'cache-loading') session.adopt('video-B', 'youtube');
    });

    await handleAudioAnalysis(deps);

    expect(deps.setAnalysisResults).not.toHaveBeenCalled();
    expect(deps.setAudioProcessingState).not.toHaveBeenCalled();
    expect(deps.setDuration).not.toHaveBeenCalled();
    expect(deps.processingContext.setStage).not.toHaveBeenCalledWith('cache-loaded');
    expect(deps.processingContext.setStage).not.toHaveBeenCalledWith('beat-detection');
    expect(deps.processingContext.setStage).not.toHaveBeenCalledWith('chord-recognition');
    expect(deps.processingContext.setStage).not.toHaveBeenCalledWith('complete');
    expect(deps.processingContext.completeProcessing).not.toHaveBeenCalled();
  });

  it('keeps a late local-file result from replacing the newer file', async () => {
    const session = createAnalysisSessionController();
    const audioA = deferred<string>();
    const audioB = deferred<string>();
    const applied: string[] = [];

    const tokenA = session.start();
    const taskA = runGuardedAnalysis(
      session,
      tokenA,
      audioA.promise,
      (value) => applied.push(value),
      () => applied.push('error-A'),
    );
    session.invalidate();
    const tokenB = session.start();
    const taskB = runGuardedAnalysis(
      session,
      tokenB,
      audioB.promise,
      (value) => applied.push(value),
      () => applied.push('error-B'),
    );

    audioA.resolve('mp3-A');
    audioB.resolve('wav-B');
    await Promise.all([taskA, taskB]);

    expect(applied).toEqual(['wav-B']);
  });
});
