import { spawnSync } from 'child_process';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import MicrophoneSourceNotice from '@/components/analysis/MicrophoneSourceNotice';
import { sniffDirectAudio } from '@/services/audio/directUploadPolicy';
import {
  activeRecordingTrackCount,
  cancelMicrophoneRecording,
  configureMicrophoneRecording,
  encodeWavPcm,
  formatRecordingDuration,
  MICROPHONE_CAPTURE_CONSTRAINTS,
  readRecordingSnapshot,
  recordingFileFromBlob,
  refreshRecordingElapsed,
  resetMicrophoneRecordingState,
  selectRecorderMime,
  startMicrophoneRecording,
  stopMicrophoneRecording,
} from '@/services/audio/microphoneRecording';
import {
  applyRouteIntent,
  resetAnalysisInputSource,
  useAnalysisInputSourceStore,
} from '@/stores/analysisInputSourceStore';

const mockPush = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

class FakeRecorder {
  state = 'inactive';
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(_stream: MediaStream, options?: { mimeType?: string }) {
    this.mimeType = options?.mimeType ?? '';
  }

  start(): void {
    this.state = 'recording';
  }

  stop(): void {
    this.state = 'inactive';
    const blob = new Blob([nextBytes], { type: this.mimeType || 'application/octet-stream' });
    if (blob.size > 0) this.ondataavailable?.({ data: blob });
    this.onstop?.();
  }
}

let nextBytes = new Uint8Array([1, 2, 3, 4]);
let now = 1_000;
const getUserMedia = jest.fn();
const decodeToPcm = jest.fn(async () => ({
  sampleRate: 8000,
  channels: [new Float32Array([0.5, -0.5, 0.25])],
}));

function track(kind: 'audio' | 'video' = 'audio') {
  return { kind, stop: jest.fn() };
}

function streamOf(...kinds: Array<'audio' | 'video'>): MediaStream {
  const tracks = kinds.map((kind) => track(kind));
  return {
    getAudioTracks: () => tracks.filter((item) => item.kind === 'audio'),
    getVideoTracks: () => tracks.filter((item) => item.kind === 'video'),
    getTracks: () => tracks,
  } as unknown as MediaStream;
}

describe('microphone recording', () => {
  beforeEach(() => {
    nextBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    now = 1_000;
    getUserMedia.mockReset();
    decodeToPcm.mockClear();
    mockPush.mockReset();
    getUserMedia.mockImplementation(async () => streamOf('audio'));
    resetAnalysisInputSource();
    configureMicrophoneRecording({
      getUserMedia,
      createRecorder: (stream, options) => new FakeRecorder(stream, options),
      isTypeSupported: (mime) => mime === 'audio/webm',
      now: () => now,
      decodeToPcm,
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
    Object.defineProperty(globalThis, 'MediaRecorder', {
      configurable: true,
      writable: true,
      value: FakeRecorder,
    });
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: jest.fn(() => 'blob:recording'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: jest.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    act(() => {
      resetAnalysisInputSource();
    });
    delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
  });

  it('encodes PCM that Python wave and the upload sniffer both accept', () => {
    const wav = encodeWavPcm(8000, [new Float32Array([0.5, -0.5, 0])]);
    expect(sniffDirectAudio(wav, wav.length)).toBe('wav');
    expect(() => encodeWavPcm(8000, [])).toThrow(/empty/);
    expect(() => encodeWavPcm(8000, [new Float32Array([0.1]), new Float32Array([0.1, 0.2])])).toThrow(/match/);
    const result = spawnSync('python3', ['-c', `
import io, sys, wave
payload = io.BytesIO(sys.stdin.buffer.read())
with wave.open(payload, "rb") as handle:
    assert handle.getnchannels() == 1
    assert handle.getsampwidth() == 2
    assert handle.getframerate() == 8000
    assert handle.getnframes() == 3
print("wave-ok")
`], { input: Buffer.from(wav) });
    expect(result.status).toBe(0);
    expect(result.stdout.toString()).toContain('wave-ok');
  });

  it('prefers a container the backend can sniff and falls back to WAV', async () => {
    expect(selectRecorderMime((mime) => mime === 'audio/ogg;codecs=opus' || mime === 'audio/webm')).toBe('audio/ogg;codecs=opus');
    expect(selectRecorderMime((mime) => mime === 'audio/mp4')).toBe('audio/mp4');
    expect(selectRecorderMime(() => false)).toBe('');
    expect(formatRecordingDuration(3500)).toBe('0:03');

    const ogg = new Uint8Array(16);
    ogg.set([0x4f, 0x67, 0x67, 0x53], 0);
    const decode = jest.fn();
    const oggFile = await recordingFileFromBlob(new Blob([ogg], { type: 'audio/ogg' }), decode);
    expect(oggFile.name).toBe('recording.ogg');
    expect(decode).not.toHaveBeenCalled();

    const mp4 = new Uint8Array(16);
    mp4.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70], 0);
    const mp4File = await recordingFileFromBlob(new Blob([mp4], { type: 'audio/mp4' }), decode);
    expect(mp4File.name).toBe('recording.m4a');

    const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const wavFile = await recordingFileFromBlob(new Blob([webm], { type: 'audio/webm' }), async () => ({
      sampleRate: 16000,
      channels: [new Float32Array([0.2, -0.2])],
    }));
    expect(wavFile.name).toBe('recording.wav');
    expect(wavFile.size).toBeGreaterThan(44);
    await expect(recordingFileFromBlob(new Blob([]), decode)).rejects.toMatchObject({ code: 'empty' });
  });

  it('starts only from the explicit capture call and uses microphone constraints', async () => {
    expect(MICROPHONE_CAPTURE_CONSTRAINTS.video).toBe(false);
    expect(JSON.stringify(MICROPHONE_CAPTURE_CONSTRAINTS)).not.toMatch(/chromeMediaSource|systemAudio|loopback/i);
    await startMicrophoneRecording();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith(MICROPHONE_CAPTURE_CONSTRAINTS);
    await startMicrophoneRecording();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(activeRecordingTrackCount()).toBe(1);
    now = 4_500;
    refreshRecordingElapsed();
    expect(readRecordingSnapshot().durationLabel).toBe('0:03');
    expect(readRecordingSnapshot().phase).toBe('recording');
  });

  it('reports denied permission and a missing microphone without a file', async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
    await startMicrophoneRecording();
    expect(readRecordingSnapshot()).toMatchObject({ phase: 'denied', errorCode: 'denied', file: null });
    expect(activeRecordingTrackCount()).toBe(0);

    getUserMedia.mockRejectedValueOnce(new DOMException('missing', 'NotFoundError'));
    await startMicrophoneRecording();
    expect(readRecordingSnapshot()).toMatchObject({ phase: 'missing', errorCode: 'missing', file: null });
  });

  it('stops into a WAV file, cancels without one, and releases tracks', async () => {
    await startMicrophoneRecording();
    await stopMicrophoneRecording();
    const ready = readRecordingSnapshot();
    expect(ready.phase).toBe('ready');
    expect(ready.file?.name).toBe('recording.wav');
    expect(activeRecordingTrackCount()).toBe(0);
    expect(decodeToPcm).toHaveBeenCalledTimes(1);

    await startMicrophoneRecording();
    const live = getUserMedia.mock.results.at(-1)?.value as Promise<MediaStream>;
    const open = await live;
    cancelMicrophoneRecording();
    expect(open.getTracks()[0].stop).toHaveBeenCalled();
    expect(readRecordingSnapshot()).toMatchObject({ phase: 'idle', file: null });

    nextBytes = new Uint8Array();
    await startMicrophoneRecording();
    await stopMicrophoneRecording();
    expect(readRecordingSnapshot()).toMatchObject({ phase: 'error', errorCode: 'empty', file: null });

    nextBytes = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9]);
    decodeToPcm.mockRejectedValueOnce(new Error('decode failed'));
    await startMicrophoneRecording();
    await stopMicrophoneRecording();
    expect(readRecordingSnapshot()).toMatchObject({ phase: 'error', errorCode: 'format', file: null });
  });

  it('rejects a video track and drops the take when the source changes', async () => {
    const video = track('video');
    const audio = track('audio');
    getUserMedia.mockResolvedValueOnce({
      getAudioTracks: () => [audio],
      getVideoTracks: () => [video],
      getTracks: () => [audio, video],
    } as unknown as MediaStream);
    await startMicrophoneRecording();
    expect(video.stop).toHaveBeenCalled();
    expect(audio.stop).toHaveBeenCalled();
    expect(readRecordingSnapshot().phase).toBe('error');
    expect(readRecordingSnapshot().file).toBeNull();

    getUserMedia.mockResolvedValueOnce(streamOf('audio'));
    await startMicrophoneRecording();
    const open = await getUserMedia.mock.results.at(-1)?.value as MediaStream;
    useAnalysisInputSourceStore.getState().setSource('microphone');
    useAnalysisInputSourceStore.getState().setSource('soundcloud');
    expect(open.getTracks()[0].stop).toHaveBeenCalled();
    expect(readRecordingSnapshot()).toMatchObject({ phase: 'idle', file: null });
    expect(useAnalysisInputSourceStore.getState().source).toBe('soundcloud');
  });

  it('shows Start, Stop, and Cancel only when recording APIs exist', async () => {
    delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
    const unavailable = render(<MicrophoneSourceNotice />);
    expect(screen.getByTestId('microphone-unavailable')).toHaveTextContent(/does not open the microphone/);
    expect(screen.queryByRole('button', { name: /start|stop|cancel|analy/i })).not.toBeInTheDocument();
    expect(getUserMedia).not.toHaveBeenCalled();
    unavailable.unmount();

    Object.defineProperty(globalThis, 'MediaRecorder', {
      configurable: true,
      writable: true,
      value: FakeRecorder,
    });
    const onAnalyze = jest.fn();
    render(<MicrophoneSourceNotice onAnalyze={onAnalyze} />);
    expect(screen.getByTestId('microphone-start')).toBeInTheDocument();
    expect(screen.queryByTestId('microphone-stop')).not.toBeInTheDocument();
    expect(getUserMedia).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByTestId('microphone-start'));
    });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    now = 4_000;
    act(() => {
      refreshRecordingElapsed();
    });
    expect(screen.getByTestId('microphone-duration')).toHaveTextContent('0:03');
    expect(screen.getByTestId('microphone-recorder')).toHaveAttribute('data-phase', 'recording');

    fireEvent.click(screen.getByTestId('microphone-stop'));
    await waitFor(() => {
      expect(screen.getByTestId('microphone-recorder')).toHaveAttribute('data-phase', 'ready');
    });
    expect(onAnalyze).not.toHaveBeenCalled();
    expect(screen.getByTestId('microphone-preview')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('microphone-analyze'));
    expect(onAnalyze).toHaveBeenCalledTimes(1);
    expect(onAnalyze.mock.calls[0][0].name).toBe('recording.wav');

    fireEvent.click(screen.getByTestId('microphone-cancel'));
    expect(screen.queryByTestId('microphone-analyze')).not.toBeInTheDocument();
    expect(readRecordingSnapshot().file).toBeNull();
  });

  it('keeps the ready take when continuing to the local page and does not analyze it', async () => {
    useAnalysisInputSourceStore.getState().setSource('microphone');
    const view = render(<MicrophoneSourceNotice />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('microphone-start'));
    });
    fireEvent.click(screen.getByTestId('microphone-stop'));
    await waitFor(() => {
      expect(screen.getByTestId('microphone-continue')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('microphone-continue'));
    expect(mockPush).toHaveBeenCalledWith('/analyze');
    applyRouteIntent('analyze', 'local-audio');
    expect(useAnalysisInputSourceStore.getState().source).toBe('microphone');
    view.unmount();
    expect(readRecordingSnapshot().phase).toBe('ready');
    expect(readRecordingSnapshot().file?.name).toBe('recording.wav');
  });
});
