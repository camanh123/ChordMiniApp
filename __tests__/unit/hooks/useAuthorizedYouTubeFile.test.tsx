import React, { useState } from 'react';
import { act, render } from '@testing-library/react';
import { useAuthorizedYouTubeFile } from '@/hooks/youtube/useAuthorizedYouTubeFile';
import { analyzeAudioWithRateLimit } from '@/services/audio/audioAnalysisService';
import { saveCompletedLocalAnalysis } from '@/services/audio/localAnalysisHistory';
import { DESKTOP_RUNTIME_MARKER } from '@/runtime/appRuntime';
import { resetAnalysisInputSource, useAnalysisInputSourceStore } from '@/stores/analysisInputSourceStore';
import type { AnalysisResult } from '@/types/audioAnalysis';
import type { AudioProcessingState } from '@/services/audio/audioProcessingService';

jest.mock('@/services/audio/audioAnalysisService', () => ({
  analyzeAudioWithRateLimit: jest.fn(),
}));

jest.mock('@/services/audio/keyDetectionService', () => ({
  detectKey: jest.fn(async () => ({ fromHeuristicFallback: false, key: 'A minor' })),
}));

jest.mock('@/services/audio/localAnalysisHistory', () => ({
  keyFactFromDetection: jest.fn(() => null),
  saveCompletedLocalAnalysis: jest.fn(async () => ({ state: 'skipped', reason: 'not-desktop', visible: false })),
}));

const VIDEO_A = 'abcdefghijk';
const VIDEO_B = 'zyxwvutsrqp';

function wavFile(): File {
  const bytes = new Uint8Array(46);
  const view = new DataView(bytes.buffer);
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
  };
  write(0, 'RIFF');
  view.setUint32(4, 38, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, 2, true);
  return new File([bytes], 'take.wav', { type: 'audio/wav' });
}

function cachedResult(): AnalysisResult {
  return {
    chords: [{ chord: 'C', start: 0, end: 2, time: 0 }],
    beats: [{ time: 0, strength: 1, beatNum: 1 }],
    synchronizedChords: [{ chord: 'C', beatIndex: 0 }],
    beatModel: 'madmom',
    chordModel: 'chord-cnn-lstm',
    beatDetectionResult: { bpm: 88, time_signature: 4 },
  };
}

function fileResult(): AnalysisResult {
  return {
    chords: [{ chord: 'G', start: 4, end: 6, time: 4 }],
    beats: [{ time: 4, strength: 1, beatNum: 1 }],
    synchronizedChords: [{ chord: 'G', beatIndex: 0 }],
    beatModel: 'madmom',
    chordModel: 'chord-cnn-lstm',
    desktopHistory: {
      requestedBeat: 'madmom',
      beatReported: 'madmom',
      chordModel: 'chord-cnn-lstm',
      modelBpm: 96,
      meter: { beatsPerBar: 4, provenance: 'madmom-candidate-selection', downbeats: [4] },
      downbeats: [4],
    },
    beatDetectionResult: { time_signature: 4 },
  };
}

const processingSeed: AudioProcessingState = {
  isDownloading: false,
  isExtracting: false,
  isExtracted: false,
  isAnalyzing: false,
  isAnalyzed: true,
  fromCache: true,
  fromFirestoreCache: true,
  error: null,
};

interface Sink {
  results: AnalysisResult | null;
  processing: AudioProcessingState;
  run: ReturnType<typeof useAuthorizedYouTubeFile>['run'];
  publish: ReturnType<typeof useAuthorizedYouTubeFile>['publish'];
  applied: Array<AnalysisResult | null>;
}

function Host({ videoId, sink }: { videoId: string; sink: Sink }) {
  const [results, setResults] = useState<AnalysisResult | null>(cachedResult());
  const [processing, setProcessing] = useState<AudioProcessingState>(processingSeed);
  const api = useAuthorizedYouTubeFile({
    videoId,
    beatDetector: 'madmom',
    chordDetector: 'chord-cnn-lstm',
    setAnalysisResults: (value) => {
      setResults((previous) => {
        const next = typeof value === 'function' ? value(previous) : value;
        sink.applied.push(next);
        return next;
      });
    },
    setAudioProcessingState: setProcessing,
  });
  sink.results = results;
  sink.processing = processing;
  sink.run = api.run;
  sink.publish = api.publish;
  return null;
}

describe('authorized file results stay isolated', () => {
  beforeEach(() => {
    resetAnalysisInputSource();
    delete process.env.NEXT_PUBLIC_APP_RUNTIME;
    document.documentElement.setAttribute(DESKTOP_RUNTIME_MARKER, 'electron');
    (analyzeAudioWithRateLimit as jest.Mock).mockReset();
    (saveCompletedLocalAnalysis as jest.Mock).mockClear();
  });

  afterAll(() => {
    document.documentElement.removeAttribute(DESKTOP_RUNTIME_MARKER);
  });

  it('keeps the open cache for an unconfirmed file, an invalid file, and a failed analysis', async () => {
    const sink = { applied: [] } as unknown as Sink;
    render(<Host videoId={VIDEO_A} sink={sink} />);
    (analyzeAudioWithRateLimit as jest.Mock).mockResolvedValue(fileResult());

    await act(async () => {
      await sink.run({ file: wavFile(), offsetSeconds: 0, syncAllowed: false });
    });
    expect(sink.results?.chords[0].chord).toBe('C');
    expect(sink.processing.isAnalyzed).toBe(true);
    expect(sink.processing.fromFirestoreCache).toBe(true);
    expect(sink.applied).toEqual([]);

    sink.publish(1, false);
    expect(sink.results?.chords[0].chord).toBe('C');

    await act(async () => {
      await expect(sink.run({
        file: new File(['text'], 'notes.mp3', { type: 'audio/mpeg' }),
        offsetSeconds: 0,
        syncAllowed: true,
      })).rejects.toThrow(/not a supported audio format/);
    });
    expect(analyzeAudioWithRateLimit).toHaveBeenCalledTimes(1);
    expect(sink.results?.chords[0].chord).toBe('C');
    expect(sink.processing.isAnalyzed).toBe(true);

    (analyzeAudioWithRateLimit as jest.Mock).mockRejectedValue(new Error('Analysis service unavailable'));
    await act(async () => {
      await expect(sink.run({ file: wavFile(), offsetSeconds: 0, syncAllowed: true })).rejects.toThrow(/unavailable/);
    });
    expect(sink.results?.chords[0].chord).toBe('C');
    expect(sink.processing.isAnalyzed).toBe(true);
    expect(sink.processing.isAnalyzing).toBe(false);
    expect(sink.processing.error).toMatch(/unavailable/);
  });

  it('replaces the cache only when the confirmed analysis belongs to this video', async () => {
    const sink = { applied: [] } as unknown as Sink;
    render(<Host videoId={VIDEO_A} sink={sink} />);
    (analyzeAudioWithRateLimit as jest.Mock).mockResolvedValue(fileResult());
    const file = wavFile();

    await act(async () => {
      await sink.run({ file, offsetSeconds: 2, syncAllowed: true });
    });

    expect(sink.applied).toHaveLength(1);
    expect(sink.applied[0]?.chords[0]).toMatchObject({ chord: 'G', start: 2, time: 2 });
    expect(sink.processing.isAnalyzed).toBe(true);
    expect(sink.processing.fromFirestoreCache).toBe(false);
    expect(saveCompletedLocalAnalysis).toHaveBeenCalledTimes(1);
    expect(saveCompletedLocalAnalysis).toHaveBeenCalledWith(expect.not.objectContaining({ videoId: expect.anything() }));
    expect((saveCompletedLocalAnalysis as jest.Mock).mock.calls[0][0].file).toBe(file);
    expect(analyzeAudioWithRateLimit).toHaveBeenCalledWith(
      file,
      'madmom',
      'chord-cnn-lstm',
      undefined,
      expect.stringMatching(/^analysis-/),
    );
  });

  it('drops a late video A result after the page has moved to video B', async () => {
    const sink = { applied: [] } as unknown as Sink;
    let release: (result: AnalysisResult) => void = () => undefined;
    let started: () => void = () => undefined;
    const analysisStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    (analyzeAudioWithRateLimit as jest.Mock).mockImplementation(() => new Promise((resolve) => {
      release = resolve;
      started();
    }));
    const view = render(<Host videoId={VIDEO_A} sink={sink} />);
    let pending: Promise<unknown> = Promise.resolve();
    await act(async () => {
      pending = sink.run({ file: wavFile(), offsetSeconds: 2, syncAllowed: true });
      await analysisStarted;
    });
    await act(async () => {
      view.rerender(<Host videoId={VIDEO_B} sink={sink} />);
    });
    await act(async () => {
      release(fileResult());
      await pending;
    });
    expect(sink.results).toBeNull();
    expect(sink.applied.filter((result) => result?.chords[0]?.chord === 'G')).toEqual([]);
  });

  it('does not replace the open grid when the selected source changes first', async () => {
    const sink = { applied: [] } as unknown as Sink;
    let release: (result: AnalysisResult) => void = () => undefined;
    let started: () => void = () => undefined;
    const analysisStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    (analyzeAudioWithRateLimit as jest.Mock).mockImplementation(() => new Promise((resolve) => {
      release = resolve;
      started();
    }));
    render(<Host videoId={VIDEO_A} sink={sink} />);
    let pending: Promise<unknown> = Promise.resolve();
    await act(async () => {
      pending = sink.run({ file: wavFile(), offsetSeconds: 2, syncAllowed: true });
      await analysisStarted;
    });
    act(() => {
      useAnalysisInputSourceStore.getState().setSource('soundcloud');
    });
    await act(async () => {
      release(fileResult());
      await pending;
    });
    expect(sink.results?.chords[0].chord).toBe('C');
    expect(sink.processing.isAnalyzed).toBe(true);
    expect(sink.applied.filter((result) => result?.chords[0]?.chord === 'G')).toEqual([]);
    sink.publish(2, true);
    expect(sink.results?.chords[0].chord).toBe('C');
  });
});
