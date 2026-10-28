import {
  DIRECT_UPLOAD_MAX_BYTES,
  directUploadExtensionAccepted,
  directUploadSizeAccepted,
  inspectDirectUploadFile,
  sniffDirectAudio,
} from '@/services/audio/directUploadPolicy';

function text(value: string): Uint8Array {
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

function minimalWav(): Uint8Array {
  const bytes = new Uint8Array(46);
  const view = new DataView(bytes.buffer);
  bytes.set(text('RIFF'), 0);
  view.setUint32(4, 38, true);
  bytes.set(text('WAVE'), 8);
  bytes.set(text('fmt '), 12);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set(text('data'), 36);
  view.setUint32(40, 2, true);
  return bytes;
}

describe('direct upload audio policy', () => {
  it('accepts the formats the backend sniffs and rejects raw aac', () => {
    expect(sniffDirectAudio(minimalWav())).toBe('wav');
    expect(sniffDirectAudio(text('fLaC'))).toBeNull();
    expect(sniffDirectAudio(Uint8Array.from([0x66, 0x4c, 0x61, 0x43, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('flac');
    expect(sniffDirectAudio(text('OggS\0\0\0\0\0\0\0\0'))).toBe('ogg');
    expect(sniffDirectAudio(text('FORM\0\0\0\0AIFF'))).toBe('aiff');
    expect(sniffDirectAudio(Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0]))).toBe('mp4');
    expect(sniffDirectAudio(Uint8Array.from([0xff, 0xfb, 0x90, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('mp3');
    expect(sniffDirectAudio(Uint8Array.from([0xff, 0xf1, 0x50, 0x80, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
    expect(directUploadExtensionAccepted('song.aac')).toBe(false);
    expect(directUploadExtensionAccepted('song.aiff')).toBe(true);
    expect(directUploadExtensionAccepted('notes.txt')).toBe(false);
  });

  it('keeps the direct upload cap at 50 MiB', () => {
    expect(DIRECT_UPLOAD_MAX_BYTES).toBe(50 * 1024 * 1024);
    expect(directUploadSizeAccepted(DIRECT_UPLOAD_MAX_BYTES)).toBe(true);
    expect(directUploadSizeAccepted(DIRECT_UPLOAD_MAX_BYTES + 1)).toBe(false);
    expect(directUploadSizeAccepted(0)).toBe(false);
  });

  it('rejects a renamed text file and an oversized file before treating them as audio', async () => {
    const textFile = new File(['not audio'], 'song.mp3', { type: 'audio/mpeg' });
    await expect(inspectDirectUploadFile(textFile)).resolves.toMatchObject({ ok: false, reason: 'signature' });
    const oversized = { name: 'big.wav', size: DIRECT_UPLOAD_MAX_BYTES + 1, slice: jest.fn() } as unknown as File;
    await expect(inspectDirectUploadFile(oversized)).resolves.toMatchObject({ ok: false, reason: 'too-large' });
    expect(oversized.slice).not.toHaveBeenCalled();
  });

  it('accepts a wav whose bytes match the container', async () => {
    const file = new File([minimalWav()], 'take.wav', { type: 'audio/wav' });
    await expect(inspectDirectUploadFile(file)).resolves.toMatchObject({ ok: true, kind: 'wav' });
  });
});
