/**
 * Direct Flask upload policy.
 * Kinds match `sniff_audio` in the inference guard: wav, flac, ogg, aiff,
 * mp4/m4a, and mp3. Raw AAC is not a detected kind. The byte cap matches
 * DIRECT_UPLOAD_SIZE_LIMIT_MB.
 */

export const DIRECT_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

const EXTENSION_KIND = {
  mp3: 'mp3',
  wav: 'wav',
  flac: 'flac',
  ogg: 'ogg',
  aiff: 'aiff',
  aif: 'aiff',
  m4a: 'mp4',
  mp4: 'mp4',
} as const;

export type SniffedAudioKind = (typeof EXTENSION_KIND)[keyof typeof EXTENSION_KIND];

export type DirectUploadRejection = 'empty' | 'too-large' | 'extension' | 'signature' | 'mismatch';

export interface DirectUploadInspection {
  ok: boolean;
  kind: SniffedAudioKind | null;
  reason: DirectUploadRejection | null;
}

export function audioExtension(name: string): string {
  const leaf = name.split(/[/\\]/).pop() ?? name;
  const dot = leaf.lastIndexOf('.');
  if (dot <= 0 || dot === leaf.length - 1) return '';
  return leaf.slice(dot + 1).toLowerCase();
}

export function directUploadExtensionAccepted(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(EXTENSION_KIND, audioExtension(name));
}

export function directUploadSizeAccepted(sizeBytes: number): boolean {
  return Number.isInteger(sizeBytes) && sizeBytes > 0 && sizeBytes <= DIRECT_UPLOAD_MAX_BYTES;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let text = '';
  for (let index = 0; index < length; index += 1) {
    text += String.fromCharCode(bytes[start + index] ?? 0);
  }
  return text;
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]
    + (bytes[offset + 1] * 256)
    + (bytes[offset + 2] * 65536)
    + (bytes[offset + 3] * 16777216);
}

function synchsafe(raw: Uint8Array): number | null {
  if (raw.length < 4) return null;
  if ((raw[0] | raw[1] | raw[2] | raw[3]) & 0x80) return null;
  return (raw[0] << 21) | (raw[1] << 14) | (raw[2] << 7) | raw[3];
}

function id3AudioOffset(header: Uint8Array, fileSize: number): number | null {
  if (header.length < 3 || ascii(header, 0, 3) !== 'ID3') return 0;
  if (header.length < 10 || fileSize < 10) return null;
  const major = header[3];
  if (major < 2 || major > 4) return null;
  const size = synchsafe(header.subarray(6, 10));
  if (size === null) return null;
  let total = 10 + size;
  if (header[5] & 0x10) total += 10;
  if (total < 10 || total > fileSize) return null;
  return total;
}

function mp3Frame(sample: Uint8Array): boolean {
  const last = Math.max(0, sample.length - 3);
  for (let index = 0; index < last; index += 1) {
    if (sample[index] !== 0xff) continue;
    const second = sample[index + 1];
    if ((second & 0xe0) !== 0xe0) continue;
    const version = (second >> 3) & 0x03;
    const layer = (second >> 1) & 0x03;
    if (version === 1 || layer === 0) continue;
    const third = sample[index + 2];
    const bitrate = (third >> 4) & 0x0f;
    const sampleRate = (third >> 2) & 0x03;
    if (bitrate === 0 || bitrate === 15 || sampleRate === 3) continue;
    return true;
  }
  return false;
}

function wavPlayable(bytes: Uint8Array): boolean {
  if (bytes.length < 44) return false;
  let offset = 12;
  let channels = 0;
  let rate = 0;
  let bits = 0;
  let dataBytes = 0;
  let guard = 0;
  while (offset + 8 <= bytes.length && guard < 16) {
    guard += 1;
    const id = ascii(bytes, offset, 4);
    const size = readU32LE(bytes, offset + 4);
    if (id === 'fmt ' && offset + 24 <= bytes.length) {
      channels = bytes[offset + 10] + (bytes[offset + 11] * 256);
      rate = readU32LE(bytes, offset + 12);
      bits = bytes[offset + 22] + (bytes[offset + 23] * 256);
    }
    if (id === 'data') {
      dataBytes = size;
      break;
    }
    const step = 8 + size + (size % 2);
    if (step <= 8) break;
    offset += step;
  }
  return channels > 0 && rate > 0 && bits > 0 && dataBytes > 0;
}

/** Identify audio from bytes. The filename is not consulted. */
export function sniffDirectAudio(bytes: Uint8Array, fileSize = bytes.length): SniffedAudioKind | null {
  if (bytes.length < 12 || fileSize < 12) return null;
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') {
    return wavPlayable(bytes) ? 'wav' : null;
  }
  if (ascii(bytes, 0, 4) === 'fLaC') return 'flac';
  if (ascii(bytes, 0, 4) === 'OggS') return 'ogg';
  if (ascii(bytes, 0, 4) === 'FORM' && (ascii(bytes, 8, 4) === 'AIFF' || ascii(bytes, 8, 4) === 'AIFC')) {
    return 'aiff';
  }
  if (ascii(bytes, 4, 4) === 'ftyp') return 'mp4';
  const audioAt = id3AudioOffset(bytes, fileSize);
  if (audioAt === null || audioAt > bytes.length || audioAt > fileSize) return null;
  const sample = bytes.subarray(audioAt, Math.min(bytes.length, audioAt + 4096));
  return mp3Frame(sample) ? 'mp3' : null;
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') {
    return new Uint8Array(await blob.arrayBuffer());
  }
  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('Could not read audio file'));
    reader.readAsArrayBuffer(blob);
  });
  return new Uint8Array(buffer);
}

async function signatureBytes(file: Blob): Promise<Uint8Array> {
  const head = await blobBytes(file.slice(0, 12));
  if (ascii(head, 0, 3) !== 'ID3') {
    return blobBytes(file.slice(0, Math.min(file.size, 65536)));
  }
  const offset = id3AudioOffset(head, file.size);
  const length = offset === null ? 12 : Math.min(file.size, offset + 4096);
  return blobBytes(file.slice(0, length));
}

export async function inspectDirectUploadFile(file: File): Promise<DirectUploadInspection> {
  if (!Number.isInteger(file.size) || file.size <= 0) {
    return { ok: false, kind: null, reason: 'empty' };
  }
  if (file.size > DIRECT_UPLOAD_MAX_BYTES) {
    return { ok: false, kind: null, reason: 'too-large' };
  }
  const extension = audioExtension(file.name);
  const expected = EXTENSION_KIND[extension as keyof typeof EXTENSION_KIND];
  if (!expected) return { ok: false, kind: null, reason: 'extension' };
  const kind = sniffDirectAudio(await signatureBytes(file), file.size);
  if (!kind) return { ok: false, kind: null, reason: 'signature' };
  if (kind !== expected) return { ok: false, kind, reason: 'mismatch' };
  return { ok: true, kind, reason: null };
}

export function directUploadRejectionMessage(reason: DirectUploadRejection): string {
  if (reason === 'too-large') return 'Audio file exceeds the 50 MB direct upload limit.';
  if (reason === 'empty') return 'Audio file is empty or corrupted';
  return 'This file is not a supported audio format.';
}
