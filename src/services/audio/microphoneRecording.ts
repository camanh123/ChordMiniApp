/**
 * Microphone-only recording for the existing local analysis pipeline.
 * getUserMedia runs from startMicrophoneRecording, which the record button calls.
 * System and display capture are not requested here.
 */

import { inspectDirectUploadFile, sniffDirectAudio, type SniffedAudioKind } from '@/services/audio/directUploadPolicy';

export const MICROPHONE_CAPTURE_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    channelCount: 1,
  },
  video: false,
};

const RECORDER_MIME_CANDIDATES = [
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm',
] as const;

const KIND_FILE: Record<SniffedAudioKind, { extension: string; mime: string }> = {
  wav: { extension: 'wav', mime: 'audio/wav' },
  flac: { extension: 'flac', mime: 'audio/flac' },
  ogg: { extension: 'ogg', mime: 'audio/ogg' },
  aiff: { extension: 'aiff', mime: 'audio/aiff' },
  mp4: { extension: 'm4a', mime: 'audio/mp4' },
  mp3: { extension: 'mp3', mime: 'audio/mpeg' },
};

export type RecordingPhase = 'idle' | 'requesting' | 'recording' | 'ready' | 'denied' | 'missing' | 'error';
export type RecordingErrorCode = 'denied' | 'missing' | 'failed' | 'empty' | 'format' | null;

export interface RecordingSnapshot {
  phase: RecordingPhase;
  elapsedMs: number;
  durationLabel: string;
  file: File | null;
  previewUrl: string | null;
  errorCode: RecordingErrorCode;
}

export interface DecodedPcm {
  sampleRate: number;
  channels: Float32Array[];
}

interface RecorderLike {
  state: string;
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  start: () => void;
  stop: () => void;
}

interface RecordingDeps {
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createRecorder: (stream: MediaStream, options?: { mimeType?: string }) => RecorderLike;
  isTypeSupported: (mime: string) => boolean;
  now: () => number;
  decodeToPcm: (bytes: ArrayBuffer) => Promise<DecodedPcm>;
}

let tracks: MediaStreamTrack[] = [];
const listeners = new Set<() => void>();
let phase: RecordingPhase = 'idle';
let elapsedMs = 0;
let file: File | null = null;
let previewUrl: string | null = null;
let errorCode: RecordingErrorCode = null;
let recorder: RecorderLike | null = null;
let stream: MediaStream | null = null;
let chunks: Blob[] = [];
let startedAt = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let generation = 0;
let holdReadyTake = false;
let stopWaiters: Array<() => void> = [];
let snapshot: RecordingSnapshot = {
  phase: 'idle',
  elapsedMs: 0,
  durationLabel: '0:00',
  file: null,
  previewUrl: null,
  errorCode: null,
};

function defaultGetUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
  const devices = navigator.mediaDevices;
  if (!devices?.getUserMedia) {
    return Promise.reject(new DOMException('Microphone recording is unavailable.', 'NotSupportedError'));
  }
  return devices.getUserMedia(constraints);
}

function defaultIsTypeSupported(mime: string): boolean {
  return typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime);
}

function defaultMediaRecorder(stream: MediaStream, options?: { mimeType?: string }): RecorderLike {
  const created = options?.mimeType ? new MediaRecorder(stream, options) : new MediaRecorder(stream);
  return created as unknown as RecorderLike;
}

async function defaultDecodeToPcm(bytes: ArrayBuffer): Promise<DecodedPcm> {
  const context = new AudioContext();
  try {
    const audio = await context.decodeAudioData(bytes.slice(0));
    const channels: Float32Array[] = [];
    for (let index = 0; index < audio.numberOfChannels; index += 1) {
      channels.push(audio.getChannelData(index));
    }
    return { sampleRate: audio.sampleRate, channels };
  } finally {
    await context.close();
  }
}

function createDefaultDeps(): RecordingDeps {
  return {
    getUserMedia: defaultGetUserMedia,
    createRecorder: defaultMediaRecorder,
    isTypeSupported: defaultIsTypeSupported,
    now: () => Date.now(),
    decodeToPcm: defaultDecodeToPcm,
  };
}

let deps: RecordingDeps = createDefaultDeps();

function emit(): void {
  snapshot = {
    phase,
    elapsedMs,
    durationLabel: formatRecordingDuration(elapsedMs),
    file,
    previewUrl,
    errorCode,
  };
  for (const listener of listeners) listener();
}

function resolveStopWaiters(): void {
  const waiting = stopWaiters;
  stopWaiters = [];
  for (const resolve of waiting) resolve();
}

function stopTrackList(open: MediaStreamTrack[]): void {
  for (const track of open) {
    try {
      track.stop();
    } catch {
      // The track already ended.
    }
  }
}

export function microphoneRecordingAvailable(): boolean {
  return typeof navigator !== 'undefined'
    && typeof navigator.mediaDevices?.getUserMedia === 'function'
    && typeof MediaRecorder !== 'undefined';
}

export function activeRecordingTrackCount(): number {
  return tracks.length;
}

export function rememberRecordingTrack(track: MediaStreamTrack): void {
  tracks.push(track);
}

export function formatRecordingDuration(elapsed: number): string {
  const total = Math.max(0, Math.floor(elapsed / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function selectRecorderMime(isTypeSupported: (mime: string) => boolean): string {
  for (const mime of RECORDER_MIME_CANDIDATES) {
    try {
      if (isTypeSupported(mime)) return mime;
    } catch {
      // This runtime cannot answer for the candidate.
    }
  }
  return '';
}

export function encodeWavPcm(sampleRate: number, channels: Float32Array[]): Uint8Array {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || channels.length === 0) {
    throw new Error('Recording PCM is empty.');
  }
  const frames = channels[0].length;
  if (frames <= 0) throw new Error('Recording PCM is empty.');
  for (const channel of channels) {
    if (channel.length !== frames) throw new Error('Recording PCM channels do not match.');
  }
  const bytesPerSample = 2;
  const blockAlign = channels.length * bytesPerSample;
  const dataSize = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeText = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels.length, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (const channel of channels) {
      const sample = Math.max(-1, Math.min(1, channel[frame]));
      const int16 = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
      view.setInt16(offset, int16, true);
      offset += 2;
    }
  }
  return new Uint8Array(buffer);
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') {
    return new Uint8Array(await blob.arrayBuffer());
  }
  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('Could not read recording'));
    reader.readAsArrayBuffer(blob);
  });
  return new Uint8Array(buffer);
}

function clearPreview(): void {
  if (previewUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    try {
      URL.revokeObjectURL(previewUrl);
    } catch {
      // The preview URL was already released.
    }
  }
  previewUrl = null;
}

function attachPreview(next: File | null): void {
  clearPreview();
  if (!next || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  try {
    previewUrl = URL.createObjectURL(next);
  } catch {
    previewUrl = null;
  }
}

function fileFromBytes(bytes: Uint8Array, extension: string, mime: string): File {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new File([copy], `recording.${extension}`, { type: mime });
}

export async function recordingFileFromBlob(
  blob: Blob,
  decodeToPcm: (bytes: ArrayBuffer) => Promise<DecodedPcm>,
): Promise<File> {
  if (blob.size <= 0) {
    throw Object.assign(new Error('Recording is empty.'), { code: 'empty' as const });
  }
  const bytes = await blobBytes(blob);
  const sniffed = sniffDirectAudio(bytes, blob.size);
  if (sniffed) {
    const named = KIND_FILE[sniffed];
    const accepted = fileFromBytes(bytes, named.extension, named.mime);
    const inspection = await inspectDirectUploadFile(accepted);
    if (!inspection.ok) {
      throw Object.assign(new Error('Recording format is not accepted.'), { code: 'format' as const });
    }
    return accepted;
  }
  const pcmBytes = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(pcmBytes).set(bytes);
  const decoded = await decodeToPcm(pcmBytes);
  const wav = encodeWavPcm(decoded.sampleRate, decoded.channels);
  if (sniffDirectAudio(wav, wav.length) !== 'wav') {
    throw Object.assign(new Error('Recording format is not accepted.'), { code: 'format' as const });
  }
  const accepted = fileFromBytes(wav, 'wav', 'audio/wav');
  const inspection = await inspectDirectUploadFile(accepted);
  if (!inspection.ok) {
    throw Object.assign(new Error('Recording format is not accepted.'), { code: 'format' as const });
  }
  return accepted;
}

export function readRecordingSnapshot(): RecordingSnapshot {
  return snapshot;
}

export function subscribeMicrophoneRecording(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function configureMicrophoneRecording(partial: Partial<RecordingDeps>): void {
  deps = { ...deps, ...partial };
}

export function holdReadyRecordingForNavigation(): void {
  holdReadyTake = true;
}

export function clearRecordingHold(): void {
  holdReadyTake = false;
}

export function refreshRecordingElapsed(): void {
  if (phase !== 'recording') return;
  elapsedMs = Math.max(0, deps.now() - startedAt);
  emit();
}

function failureFrom(error: unknown): { phase: RecordingPhase; errorCode: RecordingErrorCode } {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return { phase: 'denied', errorCode: 'denied' };
  }
  if (
    name === 'NotFoundError'
    || name === 'OverconstrainedError'
    || name === 'NotReadableError'
    || name === 'NotSupportedError'
  ) {
    return { phase: 'missing', errorCode: 'missing' };
  }
  return { phase: 'error', errorCode: 'failed' };
}

function stopStream(local: MediaStream): void {
  stopTrackList(local.getTracks());
}

export function releaseRecordingTracks(): void {
  const open = tracks;
  tracks = [];
  stopTrackList(open);
  generation += 1;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  const active = recorder;
  recorder = null;
  if (active && active.state !== 'inactive') {
    try {
      active.stop();
    } catch {
      // The recorder already stopped.
    }
  }
  if (stream) {
    stopStream(stream);
    stream = null;
  }
  chunks = [];
  const keep = holdReadyTake && phase === 'ready' && file !== null;
  holdReadyTake = false;
  resolveStopWaiters();
  if (keep) {
    emit();
    return;
  }
  file = null;
  clearPreview();
  errorCode = null;
  elapsedMs = 0;
  phase = 'idle';
  emit();
}

export function resetMicrophoneRecordingState(): void {
  holdReadyTake = false;
  generation += 1;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  recorder = null;
  if (stream) {
    stopStream(stream);
    stream = null;
  }
  chunks = [];
  const open = tracks;
  tracks = [];
  stopTrackList(open);
  phase = 'idle';
  file = null;
  clearPreview();
  errorCode = null;
  elapsedMs = 0;
  deps = createDefaultDeps();
  resolveStopWaiters();
  emit();
}

export async function startMicrophoneRecording(): Promise<void> {
  if (phase === 'requesting' || phase === 'recording') return;
  const token = ++generation;
  holdReadyTake = false;
  file = null;
  clearPreview();
  errorCode = null;
  chunks = [];
  elapsedMs = 0;
  phase = 'requesting';
  emit();
  let localStream: MediaStream;
  try {
    localStream = await deps.getUserMedia(MICROPHONE_CAPTURE_CONSTRAINTS);
  } catch (error) {
    if (token !== generation) return;
    const failed = failureFrom(error);
    phase = failed.phase;
    errorCode = failed.errorCode;
    emit();
    return;
  }
  if (token !== generation) {
    stopStream(localStream);
    return;
  }
  if (localStream.getVideoTracks().length > 0) {
    stopStream(localStream);
    phase = 'error';
    errorCode = 'failed';
    emit();
    return;
  }
  const audioTracks = localStream.getAudioTracks();
  if (audioTracks.length === 0) {
    stopStream(localStream);
    phase = 'missing';
    errorCode = 'missing';
    emit();
    return;
  }
  stream = localStream;
  for (const track of audioTracks) rememberRecordingTrack(track);
  let nextRecorder: RecorderLike;
  try {
    const mime = selectRecorderMime(deps.isTypeSupported);
    nextRecorder = deps.createRecorder(localStream, mime ? { mimeType: mime } : undefined);
  } catch {
    releaseRecordingTracks();
    if (generation === token + 1) {
      phase = 'error';
      errorCode = 'failed';
      emit();
    }
    return;
  }
  if (token !== generation) {
    try { nextRecorder.stop(); } catch { /* not started */ }
    stopStream(localStream);
    return;
  }
  recorder = nextRecorder;
  nextRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };
  nextRecorder.onstop = () => {
    void finishStop(token);
  };
  startedAt = deps.now();
  elapsedMs = 0;
  nextRecorder.start();
  if (timer) clearInterval(timer);
  timer = setInterval(refreshRecordingElapsed, 200);
  phase = 'recording';
  emit();
}

async function finishStop(token: number): Promise<void> {
  const localChunks = chunks;
  chunks = [];
  const mime = recorder?.mimeType || 'application/octet-stream';
  recorder = null;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  const open = tracks;
  tracks = [];
  stopTrackList(open);
  if (stream) {
    stopStream(stream);
    stream = null;
  }
  if (token !== generation) {
    resolveStopWaiters();
    return;
  }
  const blob = new Blob(localChunks, { type: mime });
  if (blob.size <= 0) {
    file = null;
    clearPreview();
    phase = 'error';
    errorCode = 'empty';
    emit();
    resolveStopWaiters();
    return;
  }
  try {
    const nextFile = await recordingFileFromBlob(blob, deps.decodeToPcm);
    if (token !== generation) {
      resolveStopWaiters();
      return;
    }
    file = nextFile;
    attachPreview(nextFile);
    errorCode = null;
    phase = 'ready';
    emit();
  } catch (error) {
    if (token !== generation) {
      resolveStopWaiters();
      return;
    }
    file = null;
    clearPreview();
    phase = 'error';
    errorCode = (error as { code?: RecordingErrorCode }).code === 'empty' ? 'empty' : 'format';
    emit();
  } finally {
    resolveStopWaiters();
  }
}

export function stopMicrophoneRecording(): Promise<void> {
  if (phase !== 'recording' || !recorder) return Promise.resolve();
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  elapsedMs = Math.max(0, deps.now() - startedAt);
  const pending = new Promise<void>((resolve) => {
    stopWaiters.push(resolve);
  });
  try {
    recorder.stop();
  } catch {
    phase = 'error';
    errorCode = 'failed';
    emit();
    resolveStopWaiters();
  }
  return pending;
}

export function cancelMicrophoneRecording(): void {
  holdReadyTake = false;
  file = null;
  clearPreview();
  phase = 'idle';
  releaseRecordingTracks();
}
