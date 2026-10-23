/**
 * Layer III duration from MPEG frame headers.
 *
 * Xing, VBRI, ID3, and the file size are not duration sources. Each accepted
 * frame contributes its sample count at the sample rate declared in that
 * frame. A later frame that changes version, layer, or sample rate is
 * rejected. Layer I, Layer II, AAC/ADTS, and free-format bitrate are
 * unsupported and rejected rather than estimated.
 *
 * The walk stops once the configured maximum is exceeded. A valid stream at
 * or below that maximum stays under 20,000 frames, which bounds the scan
 * independently of the 50 MB upload cap. The input buffer is not copied.
 */

const MAX_FRAMES = 20_000;

const MPEG1_L3_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MPEG2_L3_KBPS = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SAMPLE_RATE: Record<1 | 2 | 2.5, readonly number[]> = {
  1: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  2.5: [11025, 12000, 8000],
};

export type Mp3Duration =
  | { ok: true; seconds: number }
  | { ok: false; reason: 'malformed' | 'exceeded' };

type Version = 1 | 2 | 2.5;

type Frame = {
  version: Version;
  sampleRate: number;
  samples: number;
  length: number;
};

function textAt(bytes: Uint8Array, offset: number, value: string): boolean {
  if (offset < 0 || offset + value.length > bytes.length) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) {
      return false;
    }
  }
  return true;
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)
  ) >>> 0;
}

function id3v2Skip(bytes: Uint8Array): number | null {
  if (!textAt(bytes, 0, 'ID3')) {
    return 0;
  }
  if (bytes.length < 10) {
    return null;
  }
  const major = bytes[3];
  if (major < 2 || major > 4) {
    return null;
  }
  for (let index = 6; index < 10; index += 1) {
    if ((bytes[index] & 0x80) !== 0) {
      return null;
    }
  }
  const size = ((bytes[6] & 0x7f) << 21)
    | ((bytes[7] & 0x7f) << 14)
    | ((bytes[8] & 0x7f) << 7)
    | (bytes[9] & 0x7f);
  let total = 10 + size;
  if ((bytes[5] & 0x10) !== 0) {
    total += 10;
  }
  if (!Number.isSafeInteger(total) || total <= 0 || total > bytes.length) {
    return null;
  }
  return total;
}

function readLayer3Frame(bytes: Uint8Array, offset: number): Frame | null {
  if (offset + 4 > bytes.length) {
    return null;
  }
  if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) {
    return null;
  }
  const versionBits = (bytes[offset + 1] >> 3) & 0x03;
  const layerBits = (bytes[offset + 1] >> 1) & 0x03;
  if (versionBits === 1 || layerBits !== 1) {
    return null;
  }
  const version: Version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
  const bitrateIndex = (bytes[offset + 2] >> 4) & 0x0f;
  const sampleIndex = (bytes[offset + 2] >> 2) & 0x03;
  const padding = (bytes[offset + 2] >> 1) & 0x01;
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) {
    return null;
  }
  const kbps = (version === 1 ? MPEG1_L3_KBPS : MPEG2_L3_KBPS)[bitrateIndex];
  const sampleRate = SAMPLE_RATE[version][sampleIndex];
  if (!kbps || !sampleRate) {
    return null;
  }
  const samples = version === 1 ? 1152 : 576;
  const length = Math.floor((samples / 8) * (kbps * 1000) / sampleRate) + padding;
  const crc = (bytes[offset + 1] & 0x01) === 0;
  if (length < (crc ? 6 : 4)) {
    return null;
  }
  return { version, sampleRate, samples, length };
}

function trailingAudioEnd(bytes: Uint8Array, offset: number): boolean {
  if (offset === bytes.length) {
    return true;
  }
  if (offset > bytes.length) {
    return false;
  }
  let end = bytes.length;
  if (end - offset >= 128 && textAt(bytes, end - 128, 'TAG')) {
    end -= 128;
  }
  if (offset === end) {
    return true;
  }
  let zeros = true;
  for (let index = offset; index < end; index += 1) {
    if (bytes[index] !== 0) {
      zeros = false;
      break;
    }
  }
  if (zeros) {
    return true;
  }
  if (end - offset >= 32 && textAt(bytes, end - 32, 'APETAGEX')) {
    const size = u32le(bytes, end - 20);
    const tagStart = end - 32 - size;
    if (tagStart === offset && size > 0 && size < end) {
      return true;
    }
  }
  return false;
}

/**
 * Duration is `frameCount * samplesPerFrame / sampleRate`.
 * A stream is inside the limit when the summed sample count is less than or
 * equal to `maxSeconds * sampleRate`. One MPEG frame is the acceptance
 * tolerance: MPEG-1 is 1152 samples, about 26 ms at 44.1 kHz.
 */
export function readMp3Duration(bytes: Uint8Array, maxSeconds: number): Mp3Duration {
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0) {
    return { ok: false, reason: 'malformed' };
  }
  const start = id3v2Skip(bytes);
  if (start == null) {
    return { ok: false, reason: 'malformed' };
  }
  let offset = start;
  let frames = 0;
  let totalSamples = 0;
  let sampleRate = 0;
  let version: Version | 0 = 0;

  while (offset < bytes.length) {
    const frame = readLayer3Frame(bytes, offset);
    if (!frame || offset + frame.length > bytes.length) {
      if (trailingAudioEnd(bytes, offset)) {
        break;
      }
      return { ok: false, reason: 'malformed' };
    }
    if (frames === 0) {
      sampleRate = frame.sampleRate;
      version = frame.version;
    } else if (frame.sampleRate !== sampleRate || frame.version !== version) {
      return { ok: false, reason: 'malformed' };
    }
    const nextSamples = totalSamples + frame.samples;
    if (nextSamples > maxSeconds * sampleRate) {
      return { ok: false, reason: 'exceeded' };
    }
    totalSamples = nextSamples;
    frames += 1;
    if (frames > MAX_FRAMES) {
      return { ok: false, reason: 'malformed' };
    }
    offset += frame.length;
  }

  if (frames === 0 || sampleRate === 0) {
    return { ok: false, reason: 'malformed' };
  }
  return { ok: true, seconds: totalSamples / sampleRate };
}
