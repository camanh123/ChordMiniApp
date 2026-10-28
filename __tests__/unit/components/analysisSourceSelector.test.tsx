import React, { useState } from 'react';
import fs from 'fs';
import path from 'path';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import AnalysisSourceSelector from '@/components/analysis/AnalysisSourceSelector';
import AnalysisSourceDetail from '@/components/analysis/AnalysisSourceDetail';
import SoundCloudSourcePanel from '@/components/analysis/SoundCloudSourcePanel';
import MicrophoneSourceNotice from '@/components/analysis/MicrophoneSourceNotice';
import YouTubeSourceDraft from '@/components/analysis/YouTubeSourceDraft';
import LocalPracticeEntry from '@/components/analysis/LocalPracticeEntry';
import {
  activeRecordingTrackCount,
  microphoneRecordingAvailable,
  rememberRecordingTrack,
} from '@/services/audio/microphoneRecording';
import { officialSoundCloudPlayerUrl } from '@/services/soundcloud/soundCloudLink';
import {
  requestSoundCloudLookup,
  resetAnalysisInputSource,
  useAnalysisInputSourceStore,
} from '@/stores/analysisInputSourceStore';

const mockPush = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

const TRACK = 'https://soundcloud.com/artist/track';

function BothSelectors() {
  const [chord] = useState('C');
  return (
    <>
      <AnalysisSourceSelector context="input" />
      <AnalysisSourceSelector context="results" />
      <span data-testid="chord">{chord}</span>
    </>
  );
}

describe('analysis source selector', () => {
  const getUserMedia = jest.fn();

  beforeEach(() => {
    resetAnalysisInputSource();
    mockPush.mockReset();
    getUserMedia.mockReset();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
  });

  it('shows all four sources in the input and results selectors', () => {
    render(<BothSelectors />);
    for (const context of ['input', 'results'] as const) {
      const group = screen.getByTestId(`analysis-source-selector-${context}`);
      expect(within(group).getByRole('radio', { name: 'YouTube' })).toBeInTheDocument();
      expect(within(group).getByRole('radio', { name: 'SoundCloud' })).toBeInTheDocument();
      expect(within(group).getByRole('radio', { name: 'MP3/WAV' })).toBeInTheDocument();
      expect(within(group).getByRole('radio', { name: 'Record' })).toBeInTheDocument();
    }
  });

  it('keeps one source selection and leaves the displayed chord untouched', () => {
    render(<BothSelectors />);
    fireEvent.click(screen.getByTestId('analysis-source-input-soundcloud'));
    expect(screen.getByTestId('analysis-source-selector-input')).toHaveAttribute('data-selected', 'soundcloud');
    expect(screen.getByTestId('analysis-source-selector-results')).toHaveAttribute('data-selected', 'soundcloud');
    expect(screen.getByTestId('analysis-source-results-soundcloud')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('chord')).toHaveTextContent('C');
    expect(useAnalysisInputSourceStore.getState().source).toBe('soundcloud');
  });

  it('opens an existing YouTube playback route without calling media capture', () => {
    render(<YouTubeSourceDraft />);
    fireEvent.change(screen.getByTestId('youtube-url'), {
      target: { value: 'https://www.youtube.com/watch?v=abcdefghijk' },
    });
    fireEvent.click(screen.getByTestId('youtube-open-playback'));
    expect(mockPush).toHaveBeenCalledWith('/analyze/abcdefghijk');
    expect(getUserMedia).not.toHaveBeenCalled();

    mockPush.mockClear();
    fireEvent.change(screen.getByTestId('youtube-url'), {
      target: { value: 'https://www.youtube.com/playlist?list=PL1234567890' },
    });
    fireEvent.click(screen.getByTestId('youtube-open-playback'));
    expect(mockPush).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/YouTube video link/);
  });

  it('rejects an invalid SoundCloud link and embeds a valid one without an analysis action', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const playerUrl = officialSoundCloudPlayerUrl(TRACK);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        inference: false,
        canonicalUrl: TRACK,
        title: 'Official track',
        author: 'Official artist',
        thumbnail: null,
        playerUrl,
      }),
    });

    render(
      <>
        <SoundCloudSourcePanel />
        <SoundCloudSourcePanel compact />
      </>,
    );

    fireEvent.change(screen.getAllByTestId('soundcloud-url')[0], {
      target: { value: 'https://example.com/artist/track' },
    });
    fireEvent.click(screen.getAllByTestId('soundcloud-check-link')[0]);
    expect((await screen.findAllByRole('alert'))[0]).toHaveTextContent(/not a SoundCloud track link/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('soundcloud-player')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /analy/i })).not.toBeInTheDocument();

    fireEvent.change(screen.getAllByTestId('soundcloud-url')[0], {
      target: { value: 'https://soundcloud.com/artist/sets/playlist' },
    });
    fireEvent.click(screen.getAllByTestId('soundcloud-check-link')[1]);
    expect(screen.getAllByTestId('soundcloud-url')[1]).toHaveValue('https://soundcloud.com/artist/sets/playlist');
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(screen.getAllByTestId('soundcloud-url')[0], { target: { value: TRACK } });
    fireEvent.click(screen.getAllByTestId('soundcloud-check-link')[0]);
    expect((await screen.findAllByText('Official track')).length).toBe(2);
    const player = screen.getAllByTestId('soundcloud-player')[0];
    expect(player).toHaveAttribute('src', playerUrl);
    expect(player.getAttribute('src')).toContain('https://w.soundcloud.com/player/');
    expect(player.getAttribute('src')).toContain('auto_play=false');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/^\/api\/soundcloud\/official-metadata\?url=/);
    expect(screen.getAllByText(/does not run from a SoundCloud link/).length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('soundcloud-source-panel')[0]).toHaveAttribute('data-inference', 'false');
  });

  it('leaves microphone recording unavailable and releases tracks on switch and unmount', () => {
    expect(microphoneRecordingAvailable()).toBe(false);
    const stop = jest.fn();
    rememberRecordingTrack({ stop } as unknown as MediaStreamTrack);
    const selector = render(<AnalysisSourceSelector context="input" />);
    fireEvent.click(screen.getByTestId('analysis-source-input-microphone'));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(activeRecordingTrackCount()).toBe(0);
    expect(getUserMedia).not.toHaveBeenCalled();
    selector.unmount();

    const second = jest.fn();
    rememberRecordingTrack({ stop: second } as unknown as MediaStreamTrack);
    const notice = render(<MicrophoneSourceNotice />);
    expect(screen.getByTestId('microphone-unavailable')).toHaveTextContent(/does not open the microphone/);
    expect(screen.queryByRole('button', { name: /start|stop|cancel|analy/i })).not.toBeInTheDocument();
    notice.unmount();
    expect(second).toHaveBeenCalledTimes(1);
    expect(activeRecordingTrackCount()).toBe(0);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('reuses the local practice entry only while MP3/WAV is selected', () => {
    useAnalysisInputSourceStore.getState().setSource('local-audio');
    const onFileSelected = jest.fn();
    const view = render(
      <AnalysisSourceDetail
        context="input"
        localPractice={(
          <LocalPracticeEntry file={null} onFileSelected={onFileSelected} serviceState="requirement" />
        )}
      />,
    );
    expect(screen.getByTestId('local-practice-entry')).toBeInTheDocument();
    expect(screen.getByTestId('open-audio-input')).toBeInTheDocument();
    view.rerender(
      <AnalysisSourceDetail
        context="input"
        localPractice={(
          <LocalPracticeEntry file={null} onFileSelected={onFileSelected} serviceState="requirement" />
        )}
      />,
    );
    act(() => {
      useAnalysisInputSourceStore.getState().setSource('microphone');
    });
    view.rerender(
      <AnalysisSourceDetail
        context="input"
        localPractice={(
          <LocalPracticeEntry file={null} onFileSelected={onFileSelected} serviceState="requirement" />
        )}
      />,
    );
    expect(screen.queryByTestId('open-audio-input')).not.toBeInTheDocument();
    expect(screen.getByTestId('microphone-unavailable')).toBeInTheDocument();
    expect(onFileSelected).not.toHaveBeenCalled();
  });

  it('deduplicates an in-flight SoundCloud metadata lookup', async () => {
    let release: (value: { ok: boolean; json: () => Promise<unknown> }) => void = () => undefined;
    const fetchMock = jest.fn(() => new Promise<{ ok: boolean; json: () => Promise<unknown> }>((resolve) => {
      release = resolve;
    }));
    const playerUrl = officialSoundCloudPlayerUrl(TRACK);
    const first = requestSoundCloudLookup(TRACK, fetchMock as unknown as typeof fetch);
    const second = requestSoundCloudLookup(TRACK, fetchMock as unknown as typeof fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release({
      ok: true,
      json: async () => ({
        success: true,
        inference: false,
        canonicalUrl: TRACK,
        title: 'Official track',
        author: 'Official artist',
        thumbnail: null,
        playerUrl,
      }),
    });
    await first;
    await second;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useAnalysisInputSourceStore.getState().soundCloudLookup).toMatchObject({
      status: 'ready',
      title: 'Official track',
    });
  });

  it('keeps the original local pipeline and does not let another source publish it', () => {
    const page = fs.readFileSync(path.join(process.cwd(), 'src/app/analyze/page.tsx'), 'utf8');
    const videoPage = fs.readFileSync(path.join(process.cwd(), 'src/app/analyze/[videoId]/page.tsx'), 'utf8');
    const home = fs.readFileSync(path.join(process.cwd(), 'src/components/homepage/IntegratedSearchContainer.tsx'), 'utf8');
    const viewModel = fs.readFileSync(
      path.join(process.cwd(), 'src/app/analyze/[videoId]/_hooks/useAnalyzePageViewModel.ts'),
      'utf8',
    );
    const store = fs.readFileSync(path.join(process.cwd(), 'src/stores/analysisInputSourceStore.ts'), 'utf8');
    const microphone = fs.readFileSync(path.join(process.cwd(), 'src/services/audio/microphoneRecording.ts'), 'utf8');
    const start = page.indexOf('const processAudioFile');
    const guard = page.indexOf('publishLocalAnalysisAllowed(publication)', start);
    const call = page.indexOf('analyzeAudioWithRateLimit(selectedFile, beatDetector, chordDetector)', start);
    const applyGuard = page.indexOf('publishLocalAnalysisAllowed(publication)', call);
    const publish = page.indexOf('setAnalysisResults(results)', call);
    expect(guard).toBeGreaterThan(start);
    expect(guard).toBeLessThan(call);
    expect(applyGuard).toBeGreaterThan(call);
    expect(applyGuard).toBeLessThan(publish);
    expect(page).toContain('context="input"');
    expect(page).toContain('context="results"');
    expect(videoPage).toContain('context="results"');
    expect(videoPage).toContain('YouTubeAuthorizedSourcePanel');
    expect(home).toContain('context="input"');
    const youtubeStart = viewModel.indexOf('const handleStartAnalysis');
    expect(viewModel.indexOf('startYouTubeAnalysisAllowed()', youtubeStart)).toBeLessThan(
      viewModel.indexOf('handleAudioAnalysis()', youtubeStart),
    );
    expect(store).not.toContain('setAnalysisResults');
    expect(store).not.toContain('analyzeAudio');
    expect(store).not.toContain('getUserMedia');
    expect(microphone).toMatch(/navigator\.mediaDevices\?\.getUserMedia/);
    expect(microphone).not.toMatch(/getDisplayMedia|chromeMediaSource/);
    expect(page.indexOf("applyRouteIntent('analyze', 'local-audio')")).toBeGreaterThan(0);
    expect(page.indexOf("applyRouteIntent('analyze', 'local-audio')")).toBeLessThan(page.indexOf('useAnalysisInputSource()'));
    expect(home.indexOf("applyRouteIntent('home', 'youtube')")).toBeGreaterThan(0);
    expect(home.indexOf("applyRouteIntent('home', 'youtube')")).toBeLessThan(home.indexOf('useAnalysisInputSource()'));
    expect(videoPage).toContain('applyRouteIntent(`video:${videoId}`, \'youtube\')');

    const protectedNames = ['ChordGrid', 'GuitarChordsTab', 'PianoVisualizer', 'LyricsSection', 'BeatTimeline'];
    for (const relative of [
      'src/components/analysis/AnalysisSourceSelector.tsx',
      'src/components/analysis/AnalysisSourceDetail.tsx',
      'src/components/analysis/SoundCloudSourcePanel.tsx',
      'src/components/analysis/MicrophoneSourceNotice.tsx',
      'src/components/analysis/YouTubeSourceDraft.tsx',
      'src/components/analysis/LocalAudioSourceHint.tsx',
    ]) {
      const text = fs.readFileSync(path.join(process.cwd(), relative), 'utf8');
      for (const name of protectedNames) {
        expect(text).not.toContain(name);
      }
    }
  });
});
