/**
 * Hosted upload and duration guard.
 *
 * WAV duration is the data-chunk size divided by the sample rate and block
 * align. The fact chunk, the filename, the byte size, and any client duration
 * field are not accepted as a shorter duration. A fact chunk that disagrees
 * with the data chunk, or bytes trailing the RIFF container, is malformed.
 * The walk reads chunk headers only. It does not decode PCM and it does not
 * write a temporary file.
 *
 * MP3 duration is the sum of validated Layer III frames. Xing, VBRI, and ID3
 * tags are not duration sources. FLAC, Ogg, MP4, and AIFF are rejected here:
 * their container sample counts can under-report, and this hotfix does not
 * claim a byte-level proof for those formats.
 *
 * Next.js has already buffered a multipart body before this route reads it.
 * Content-Length above the 50 MB cap plus framing is rejected before that
 * body is inspected. The file size is checked again before admission.
 */

import { NextResponse } from 'next/server';
import {
  readGatewayAdmissionConfig,
  UPLOAD_FRAMING_BYTES,
  withHostedAdmission,
  type AdmissionContext,
} from '@/server/gatewayAdmission';
import { readMp3Duration } from '@/server/mp3FrameDuration';

const HARD_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_WAV_CHUNKS = 32;
const MIN_SAMPLE_RATE = 8000;
const MAX_SAMPLE_RATE = 192000;

const UPLOAD_TOO_LARGE = {
  success: false as const,
  error: 'The audio upload is too large',
  code: 'UPLOAD_TOO_LARGE',
};

const AUDIO_MALFORMED = {
  success: false as const,
  error: 'The audio upload could not be read',
  code: 'AUDIO_MALFORMED',
};

const AUDIO_DURATION_EXCEEDED = {
  success: false as const,
  error: 'The audio upload is longer than the staging limit',
  code: 'AUDIO_DURATION_EXCEEDED',
};

export type AudioGuardResult =
  | { ok: true }
  | { ok: false; status: 400 | 413 | 503; body: { success: false; error: string; code: string } };

function failure(
  status: 400 | 413 | 503,
  body: { success: false; error: string; code: string },
): Exclude<AudioGuardResult, { ok: true }> {
  return { ok: false, status, body };
}

export function declaredUploadRejection(
  contentLength: string | null,
): Exclude<AudioGuardResult, { ok: true }> | null {
  if (contentLength == null || contentLength.trim() === '') {
    return null;
  }
  if (!/^[0-9]+$/.test(contentLength.trim())) {
    return failure(413, UPLOAD_TOO_LARGE);
  }
  const declared = Number(contentLength.trim());
  if (!Number.isSafeInteger(declared) || declared > HARD_UPLOAD_BYTES + UPLOAD_FRAMING_BYTES) {
    return failure(413, UPLOAD_TOO_LARGE);
  }
  return null;
}

function u16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)
  ) >>> 0;
}

function fourcc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3],
  );
}

function wavDurationSeconds(bytes: Uint8Array): number | null {
  if (bytes.length < 44 || fourcc(bytes, 0) !== 'RIFF' || fourcc(bytes, 8) !== 'WAVE') {
    return null;
  }
  const riffSize = u32(bytes, 4);
  if (riffSize < 4 || riffSize > bytes.length - 8) {
    return null;
  }
  if (bytes.length - (8 + riffSize) > 1) {
    return null;
  }

  const end = 8 + riffSize;
  let offset = 12;
  let chunks = 0;
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let blockAlign = 0;
  let bits = 0;
  let dataBytes: number | null = null;
  let factSamples: number | null = null;

  while (offset + 8 <= end) {
    chunks += 1;
    if (chunks > MAX_WAV_CHUNKS) {
      return null;
    }
    const id = fourcc(bytes, offset);
    const size = u32(bytes, offset + 4);
    const dataStart = offset + 8;
    if (size > end - dataStart) {
      return null;
    }
    if (id === 'fmt ') {
      if (format !== 0 || size < 16) {
        return null;
      }
      format = u16(bytes, dataStart);
      channels = u16(bytes, dataStart + 2);
      sampleRate = u32(bytes, dataStart + 4);
      blockAlign = u16(bytes, dataStart + 12);
      bits = u16(bytes, dataStart + 14);
    } else if (id === 'data') {
      if (dataBytes !== null) {
        return null;
      }
      dataBytes = size;
    } else if (id === 'fact') {
      if (size < 4) {
        return null;
      }
      factSamples = u32(bytes, dataStart);
    }
    const padded = size + (size % 2);
    if (dataStart + padded > end) {
      if (size % 2 === 1 && dataStart + size === end) {
        offset = end;
      } else {
        return null;
      }
    } else {
      offset = dataStart + padded;
    }
  }

  if (format !== 1 && format !== 3) {
    return null;
  }
  if (channels < 1 || channels > 8 || sampleRate < MIN_SAMPLE_RATE || sampleRate > MAX_SAMPLE_RATE) {
    return null;
  }
  const allowedBits = format === 3 ? [32, 64] : [8, 16, 24, 32];
  if (!allowedBits.includes(bits) || bits % 8 !== 0) {
    return null;
  }
  if (blockAlign !== channels * (bits / 8)) {
    return null;
  }
  if (dataBytes == null || dataBytes <= 0 || dataBytes % blockAlign !== 0) {
    return null;
  }
  const frames = dataBytes / blockAlign;
  if (factSamples != null && Math.abs(factSamples - frames) > 1) {
    return null;
  }
  const seconds = frames / sampleRate;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  return seconds;
}

export async function inspectHostedAudio(
  file: Blob,
  env: NodeJS.ProcessEnv,
): Promise<AudioGuardResult> {
  const config = readGatewayAdmissionConfig(env);
  if (!config.ok) {
    return failure(config.status, config.body);
  }
  if (file.size <= 0) {
    return failure(400, AUDIO_MALFORMED);
  }
  if (file.size > config.limits.maxUploadBytes) {
    return failure(413, UPLOAD_TOO_LARGE);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength !== file.size || bytes.byteLength > config.limits.maxUploadBytes) {
    return failure(413, UPLOAD_TOO_LARGE);
  }

  if (bytes.length >= 4 && fourcc(bytes, 0) === 'RIFF') {
    const seconds = wavDurationSeconds(bytes);
    if (seconds == null) {
      return failure(400, AUDIO_MALFORMED);
    }
    if (seconds > config.limits.maxDurationSeconds) {
      return failure(400, AUDIO_DURATION_EXCEEDED);
    }
    return { ok: true };
  }

  if (unsupportedCompressedContainer(bytes)) {
    return failure(400, AUDIO_MALFORMED);
  }

  const mp3 = readMp3Duration(bytes, config.limits.maxDurationSeconds);
  if (!mp3.ok) {
    return failure(400, mp3.reason === 'exceeded' ? AUDIO_DURATION_EXCEEDED : AUDIO_MALFORMED);
  }
  return { ok: true };
}

function unsupportedCompressedContainer(bytes: Uint8Array): boolean {
  if (bytes.length >= 4 && (fourcc(bytes, 0) === 'fLaC' || fourcc(bytes, 0) === 'OggS')) {
    return true;
  }
  if (bytes.length >= 12 && fourcc(bytes, 0) === 'FORM') {
    const kind = fourcc(bytes, 8);
    return kind === 'AIFF' || kind === 'AIFC';
  }
  return bytes.length >= 12 && fourcc(bytes, 4) === 'ftyp';
}

export async function runAdmittedHostedInference(
  uid: string,
  env: NodeJS.ProcessEnv,
  incoming: AbortSignal | undefined,
  file: Blob,
  run: (signal: AbortSignal, admission: AdmissionContext) => Promise<NextResponse>,
): Promise<NextResponse> {
  const config = readGatewayAdmissionConfig(env);
  if (!config.ok) {
    return NextResponse.json(config.body, { status: config.status });
  }
  if (file.size <= 0) {
    return NextResponse.json(AUDIO_MALFORMED, { status: 400 });
  }
  if (file.size > config.limits.maxUploadBytes) {
    return NextResponse.json(UPLOAD_TOO_LARGE, { status: 413 });
  }

  return withHostedAdmission(uid, env, incoming, async (signal, admission) => {
    const audio = await inspectHostedAudio(file, env);
    if (!audio.ok) {
      return NextResponse.json(audio.body, { status: audio.status });
    }
    if (signal.aborted) {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }
    return run(signal, admission);
  });
}
