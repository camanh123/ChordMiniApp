import {
  applyRouteIntent,
  armMicrophoneContinue,
  capturePublicationSnapshot,
  publishLocalAnalysisAllowed,
  resetAnalysisInputSource,
  useAnalysisInputSourceStore,
} from '@/stores/analysisInputSourceStore';
import {
  holdReadyRecordingForNavigation,
  readRecordingSnapshot,
  rememberRecordingTrack,
  resetMicrophoneRecordingState,
} from '@/services/audio/microphoneRecording';

describe('analysis source route initialization', () => {
  beforeEach(() => {
    resetAnalysisInputSource();
  });

  afterEach(() => {
    resetMicrophoneRecordingState();
  });

  it('opens local analysis on MP3/WAV and a video route on YouTube', () => {
    expect(useAnalysisInputSourceStore.getState().source).toBe('youtube');
    applyRouteIntent('analyze', 'local-audio');
    expect(useAnalysisInputSourceStore.getState().source).toBe('local-audio');

    useAnalysisInputSourceStore.getState().setSource('soundcloud');
    applyRouteIntent('analyze', 'local-audio');
    expect(useAnalysisInputSourceStore.getState().source).toBe('soundcloud');

    applyRouteIntent('video:abcdefghijk', 'youtube');
    expect(useAnalysisInputSourceStore.getState().source).toBe('youtube');
    applyRouteIntent('video:abcdefghijk', 'youtube');
    useAnalysisInputSourceStore.getState().setSource('soundcloud');
    applyRouteIntent('video:abcdefghijk', 'youtube');
    expect(useAnalysisInputSourceStore.getState().source).toBe('soundcloud');
  });

  it('keeps the homepage on YouTube until the visitor chooses another source', () => {
    applyRouteIntent('home', 'youtube');
    expect(useAnalysisInputSourceStore.getState().source).toBe('youtube');
    useAnalysisInputSourceStore.getState().setSource('local-audio');
    applyRouteIntent('home', 'youtube');
    expect(useAnalysisInputSourceStore.getState().source).toBe('local-audio');
  });

  it('keeps a microphone take when local analysis is opened from the recorder', () => {
    useAnalysisInputSourceStore.getState().setSource('microphone');
    const stop = jest.fn();
    rememberRecordingTrack({ stop } as unknown as MediaStreamTrack);
    armMicrophoneContinue();
    applyRouteIntent('analyze', 'local-audio');
    expect(useAnalysisInputSourceStore.getState().source).toBe('microphone');
    expect(stop).not.toHaveBeenCalled();
  });

  it('discards a held take when the route chooses a different source', () => {
    useAnalysisInputSourceStore.getState().setSource('microphone');
    holdReadyRecordingForNavigation();
    const stop = jest.fn();
    rememberRecordingTrack({ stop } as unknown as MediaStreamTrack);
    applyRouteIntent('analyze', 'local-audio');
    expect(useAnalysisInputSourceStore.getState().source).toBe('local-audio');
    expect(stop).toHaveBeenCalled();
    expect(readRecordingSnapshot().phase).toBe('idle');
  });

  it('does not let a microphone run publish after the source changes', () => {
    useAnalysisInputSourceStore.getState().setSource('microphone');
    const publication = capturePublicationSnapshot();
    expect(publishLocalAnalysisAllowed(publication)).toBe(true);
    useAnalysisInputSourceStore.getState().setSource('local-audio');
    expect(publishLocalAnalysisAllowed(publication)).toBe(false);
    expect(publishLocalAnalysisAllowed()).toBe(true);
    useAnalysisInputSourceStore.getState().setSource('youtube');
    expect(publishLocalAnalysisAllowed()).toBe(false);
  });

  it('resets to YouTube for an explicit store reset', () => {
    applyRouteIntent('analyze', 'local-audio');
    useAnalysisInputSourceStore.getState().setSource('microphone');
    resetAnalysisInputSource();
    expect(useAnalysisInputSourceStore.getState()).toMatchObject({
      source: 'youtube',
      appliedRouteKey: null,
      captureGeneration: 0,
    });
  });

  it('does not cancel a recording when the same source is selected again', () => {
    useAnalysisInputSourceStore.getState().setSource('microphone');
    const stop = jest.fn();
    rememberRecordingTrack({ stop } as unknown as MediaStreamTrack);
    useAnalysisInputSourceStore.getState().setSource('microphone');
    expect(stop).not.toHaveBeenCalled();
  });
});
