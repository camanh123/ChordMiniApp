/**
 * @jest-environment node
 *
 * Synthetic MPEG Layer III frames. No downloaded audio.
 * Firebase verification in the route case is MOCKED and is not production authentication.
 */

jest.mock('next/server', () => ({
  NextRequest: class {},
  NextResponse: class MockNextResponse {
    status: number;
    headers: Headers;
    private body: unknown;

    constructor(body?: unknown, init?: { status?: number; headers?: HeadersInit }) {
      this.status = init?.status ?? 200;
      this.headers = new Headers(init?.headers ?? {});
      this.body = body;
    }

    static json(body: unknown, init?: { status?: number; headers?: HeadersInit }) {
      return new this(body, init);
    }

    async json() {
      return this.body;
    }
  },
}));

jest.mock('@/utils/audioDurationUtils', () => ({
  getAudioDurationFromFile: jest.fn(async () => 12),
}));

jest.mock('@/utils/environmentUtils', () => ({
  createSafeTimeoutSignal: jest.fn(() => new AbortController().signal),
}));

jest.mock('@/utils/backendConfig', () => ({
  isLocalBackend: jest.fn(() => true),
}));

const mockVerifyIdToken = jest.fn();

jest.mock('@/utils/firebaseAdmin', () => ({
  getFirebaseAdminAuth: jest.fn(async () => ({
    verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args),
  })),
}));

import { POST as postBeats } from '@/app/api/detect-beats/route';
import { inspectHostedAudio } from '@/server/gatewayAudioGuard';
import {
  gatewayAdmissionSnapshot,
  resetGatewayAdmissionForTests,
  setGatewayClockForTests,
} from '@/server/gatewayAdmission';
import { readMp3Duration } from '@/server/mp3FrameDuration';

const MAX_SECONDS = 300;
const MPEG1_SAMPLES = 1152;
const MPEG1_RATE = 44100;
const FRAME_32K = 104;
const FRAME_40K = 130;
const FRAME_32K_PADDED = 105;

function writeText(target: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    target[offset + index] = value.charCodeAt(index);
  }
}

function mpeg1Frames(count: number, length = FRAME_32K, header = [0xff, 0xfb, 0x10, 0xc0]): Uint8Array {
  const bytes = new Uint8Array(count * length);
  for (let frame = 0; frame < count; frame += 1) {
    bytes.set(header, frame * length);
  }
  return bytes;
}

function vbrFrames(count: number): Uint8Array {
  let size = 0;
  for (let frame = 0; frame < count; frame += 1) {
    size += frame % 2 === 0 ? FRAME_32K : FRAME_40K;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (let frame = 0; frame < count; frame += 1) {
    const length = frame % 2 === 0 ? FRAME_32K : FRAME_40K;
    const header = frame % 2 === 0 ? [0xff, 0xfb, 0x10, 0xc0] : [0xff, 0xfb, 0x20, 0xc0];
    bytes.set(header, offset);
    offset += length;
  }
  return bytes;
}

function writeXing(frame: Uint8Array, claimedFrames: number): void {
  writeText(frame, 21, 'Xing');
  frame[24] = 0;
  frame[25] = 0;
  frame[26] = 0;
  frame[27] = 1;
  frame[28] = (claimedFrames >>> 24) & 0xff;
  frame[29] = (claimedFrames >>> 16) & 0xff;
  frame[30] = (claimedFrames >>> 8) & 0xff;
  frame[31] = claimedFrames & 0xff;
}

function writeVbri(frame: Uint8Array, claimedFrames: number): void {
  writeText(frame, 36, 'VBRI');
  frame[40] = 0;
  frame[41] = 1;
  frame[54] = (claimedFrames >>> 24) & 0xff;
  frame[55] = (claimedFrames >>> 16) & 0xff;
  frame[56] = (claimedFrames >>> 8) & 0xff;
  frame[57] = claimedFrames & 0xff;
}

function withId3v2(audio: Uint8Array): Uint8Array {
  const payload = Uint8Array.from([1, 2, 3, 4]);
  const out = new Uint8Array(10 + payload.length + audio.length);
  writeText(out, 0, 'ID3');
  out[3] = 3;
  out[9] = payload.length;
  out.set(payload, 10);
  out.set(audio, 14);
  return out;
}

function withId3v1(audio: Uint8Array): Uint8Array {
  const out = new Uint8Array(audio.length + 128);
  out.set(audio);
  writeText(out, audio.length, 'TAG');
  return out;
}

function withApeTrailer(audio: Uint8Array): Uint8Array {
  const out = new Uint8Array(audio.length + 64);
  out.set(audio);
  const footer = out.length - 32;
  writeText(out, footer, 'APETAGEX');
  out[footer + 8] = 2000 & 0xff;
  out[footer + 9] = (2000 >> 8) & 0xff;
  out[footer + 12] = 32;
  return out;
}

function wavBytes(seconds: number, factSamples?: number): Uint8Array {
  const sampleRate = 8000;
  const frames = Math.round(seconds * sampleRate);
  const data = new Uint8Array(frames);
  const fact = factSamples != null;
  const payload = 4 + 24 + (fact ? 12 : 0) + 8 + data.length;
  const bytes = new Uint8Array(8 + payload);
  const view = new DataView(bytes.buffer);
  writeText(bytes, 0, 'RIFF');
  view.setUint32(4, payload, true);
  writeText(bytes, 8, 'WAVE');
  writeText(bytes, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  let offset = 36;
  if (fact) {
    writeText(bytes, offset, 'fact');
    view.setUint32(offset + 4, 4, true);
    view.setUint32(offset + 8, factSamples as number, true);
    offset += 12;
  }
  writeText(bytes, offset, 'data');
  view.setUint32(offset + 4, data.length, true);
  return bytes;
}

const env = {
  CHORDMINI_GATEWAY_ADMISSION: 'process',
  CHORDMINI_GATEWAY_INSTANCES: '1',
} as NodeJS.ProcessEnv;

describe('MP3 frame duration', () => {
  it('counts CBR, VBR, padded, CRC, MPEG-2, and MPEG-2.5 frames', () => {
    const cbr = readMp3Duration(mpeg1Frames(10), MAX_SECONDS);
    expect(cbr.ok).toBe(true);
    if (cbr.ok) {
      expect(cbr.seconds).toBeCloseTo((10 * MPEG1_SAMPLES) / MPEG1_RATE, 8);
    }

    const vbr = readMp3Duration(vbrFrames(8), MAX_SECONDS);
    expect(vbr.ok).toBe(true);
    if (vbr.ok) {
      expect(vbr.seconds).toBeCloseTo((8 * MPEG1_SAMPLES) / MPEG1_RATE, 8);
    }

    const padded = readMp3Duration(
      mpeg1Frames(4, FRAME_32K_PADDED, [0xff, 0xfb, 0x12, 0xc0]),
      MAX_SECONDS,
    );
    expect(padded.ok).toBe(true);
    if (padded.ok) {
      expect(padded.seconds).toBeCloseTo((4 * MPEG1_SAMPLES) / MPEG1_RATE, 8);
    }

    const crc = readMp3Duration(mpeg1Frames(2, FRAME_32K, [0xff, 0xfa, 0x10, 0xc0]), MAX_SECONDS);
    expect(crc.ok).toBe(true);

    const mpeg2Length = 208;
    const mpeg2 = readMp3Duration(
      mpeg1Frames(4, mpeg2Length, [0xff, 0xf3, 0x80, 0xc0]),
      MAX_SECONDS,
    );
    expect(mpeg2.ok).toBe(true);
    if (mpeg2.ok) {
      expect(mpeg2.seconds).toBeCloseTo((4 * 576) / 22050, 8);
    }

    const mpeg25Length = 52;
    const mpeg25 = readMp3Duration(
      mpeg1Frames(3, mpeg25Length, [0xff, 0xe3, 0x10, 0xc0]),
      MAX_SECONDS,
    );
    expect(mpeg25.ok).toBe(true);
    if (mpeg25.ok) {
      expect(mpeg25.seconds).toBeCloseTo((3 * 576) / 11025, 8);
    }
  });

  it('ignores Xing and VBRI frame counts and keeps ID3 and trailing tags', () => {
    const honest = mpeg1Frames(12);
    writeXing(honest.subarray(0, FRAME_32K), 12);
    const honestResult = readMp3Duration(honest, MAX_SECONDS);
    expect(honestResult.ok).toBe(true);
    if (honestResult.ok) {
      expect(honestResult.seconds).toBeCloseTo((12 * MPEG1_SAMPLES) / MPEG1_RATE, 8);
    }

    const shortClaim = mpeg1Frames(Math.floor((301 * MPEG1_RATE) / MPEG1_SAMPLES));
    writeXing(shortClaim.subarray(0, FRAME_32K), 1);
    expect(readMp3Duration(shortClaim, MAX_SECONDS)).toEqual({ ok: false, reason: 'exceeded' });

    const longClaim = mpeg1Frames(10);
    writeXing(longClaim.subarray(0, FRAME_32K), 999_999);
    const longResult = readMp3Duration(longClaim, MAX_SECONDS);
    expect(longResult.ok).toBe(true);
    if (longResult.ok) {
      expect(longResult.seconds).toBeCloseTo((10 * MPEG1_SAMPLES) / MPEG1_RATE, 8);
    }

    const shortVbri = mpeg1Frames(6);
    writeVbri(shortVbri.subarray(0, FRAME_32K), 50_000);
    expect(readMp3Duration(shortVbri, MAX_SECONDS).ok).toBe(true);

    const longVbri = mpeg1Frames(Math.floor((301 * MPEG1_RATE) / MPEG1_SAMPLES));
    writeVbri(longVbri.subarray(0, FRAME_32K), 2);
    expect(readMp3Duration(longVbri, MAX_SECONDS)).toEqual({ ok: false, reason: 'exceeded' });

    const tagged = withId3v1(withApeTrailer(withId3v2(mpeg1Frames(5))));
    const taggedResult = readMp3Duration(tagged, MAX_SECONDS);
    expect(taggedResult.ok).toBe(true);
    if (taggedResult.ok) {
      expect(taggedResult.seconds).toBeCloseTo((5 * MPEG1_SAMPLES) / MPEG1_RATE, 8);
    }

    const paddedFile = new Uint8Array(mpeg1Frames(10).length + 1000);
    paddedFile.set(mpeg1Frames(10));
    const paddedResult = readMp3Duration(paddedFile, MAX_SECONDS);
    expect(paddedResult.ok).toBe(true);
    if (paddedResult.ok) {
      expect(paddedResult.seconds).toBeCloseTo((10 * MPEG1_SAMPLES) / MPEG1_RATE, 8);
    }
  });

  it('accepts 299 and 300 seconds and rejects the next frame and 301 seconds', () => {
    const frames299 = Math.floor((299 * MPEG1_RATE) / MPEG1_SAMPLES);
    const frames300 = Math.floor((MAX_SECONDS * MPEG1_RATE) / MPEG1_SAMPLES);
    const frames301 = Math.floor((301 * MPEG1_RATE) / MPEG1_SAMPLES);
    const accepted299 = readMp3Duration(mpeg1Frames(frames299), MAX_SECONDS);
    const accepted300 = readMp3Duration(mpeg1Frames(frames300), MAX_SECONDS);
    expect(accepted299.ok).toBe(true);
    expect(accepted300.ok).toBe(true);
    if (accepted299.ok && accepted300.ok) {
      expect(accepted299.seconds).toBeLessThanOrEqual(299);
      expect(accepted300.seconds).toBeLessThanOrEqual(MAX_SECONDS);
      expect(MAX_SECONDS - accepted300.seconds).toBeLessThan(MPEG1_SAMPLES / MPEG1_RATE);
    }
    expect(readMp3Duration(mpeg1Frames(frames300 + 1), MAX_SECONDS)).toEqual({
      ok: false,
      reason: 'exceeded',
    });
    expect(readMp3Duration(mpeg1Frames(frames301), MAX_SECONDS)).toEqual({
      ok: false,
      reason: 'exceeded',
    });
  });

  it('rejects truncated, invalid, unsupported, and disguised input', () => {
    const truncated = mpeg1Frames(3).subarray(0, (FRAME_32K * 2) + 40);
    expect(readMp3Duration(truncated, MAX_SECONDS)).toEqual({ ok: false, reason: 'malformed' });

    const badLength = mpeg1Frames(2);
    badLength[FRAME_32K + 2] = 0xf0;
    expect(readMp3Duration(badLength, MAX_SECONDS)).toEqual({ ok: false, reason: 'malformed' });

    const junk = new Uint8Array(200);
    junk.fill(0x41);
    junk[80] = 0xff;
    junk[81] = 0xfb;
    junk[82] = 0x10;
    junk[83] = 0xc0;
    expect(readMp3Duration(junk, MAX_SECONDS)).toEqual({ ok: false, reason: 'malformed' });
    expect(readMp3Duration(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]), MAX_SECONDS)).toEqual({
      ok: false,
      reason: 'malformed',
    });

    const layer2 = new Uint8Array(120);
    layer2.set([0xff, 0xfd, 0x10, 0xc0]);
    expect(readMp3Duration(layer2, MAX_SECONDS)).toEqual({ ok: false, reason: 'malformed' });

    const freeBitrate = new Uint8Array(FRAME_32K);
    freeBitrate.set([0xff, 0xfb, 0x00, 0xc0]);
    expect(readMp3Duration(freeBitrate, MAX_SECONDS)).toEqual({ ok: false, reason: 'malformed' });

    const changedRate = mpeg1Frames(2);
    changedRate[FRAME_32K + 2] = 0x14;
    expect(readMp3Duration(changedRate, MAX_SECONDS)).toEqual({ ok: false, reason: 'malformed' });

    const badId3 = new Uint8Array(10);
    writeText(badId3, 0, 'ID3');
    badId3[3] = 3;
    badId3[6] = 0x80;
    expect(readMp3Duration(badId3, MAX_SECONDS)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('keeps the WAV contract and rejects unverified compressed containers', async () => {
    const shortWav = new File([wavBytes(1)], 'clip.wav', { type: 'audio/wav' });
    const longWav = new File([wavBytes(301)], 'long.wav', { type: 'audio/wav' });
    const lyingWav = new File([wavBytes(1, 1)], 'fact.wav', { type: 'audio/wav' });
    await expect(inspectHostedAudio(shortWav, env)).resolves.toEqual({ ok: true });
    await expect(inspectHostedAudio(longWav, env)).resolves.toMatchObject({
      ok: false,
      body: { code: 'AUDIO_DURATION_EXCEEDED' },
    });
    await expect(inspectHostedAudio(lyingWav, env)).resolves.toMatchObject({
      ok: false,
      body: { code: 'AUDIO_MALFORMED' },
    });

    const flac = new Uint8Array(16);
    writeText(flac, 0, 'fLaC');
    const ogg = new Uint8Array(16);
    writeText(ogg, 0, 'OggS');
    const aiff = new Uint8Array(16);
    writeText(aiff, 0, 'FORM');
    writeText(aiff, 8, 'AIFF');
    const mp4 = new Uint8Array(16);
    writeText(mp4, 4, 'ftyp');
    for (const bytes of [flac, ogg, aiff, mp4]) {
      const file = new File([bytes], 'clip.bin', { type: 'application/octet-stream' });
      await expect(inspectHostedAudio(file, env)).resolves.toMatchObject({
        ok: false,
        body: { code: 'AUDIO_MALFORMED' },
      });
    }
  });
});

describe('MOCKED Firebase MP3 admission', () => {
  const fetchMock = jest.fn();
  const original = {
    auth: process.env.CHORDMINI_INFERENCE_AUTH,
    secret: process.env.CHORDMINI_INFERENCE_SECRET,
    staging: process.env.CHORDMINI_HOSTED_STAGING_AUTH,
    allow: process.env.CHORDMINI_STAGING_ALLOWED_UIDS,
    admin: process.env.FIREBASE_SERVICE_ACCOUNT_KEY,
    desktop: process.env.CHORDMINI_DESKTOP_MODE,
    python: process.env.PYTHON_API_URL,
    admission: process.env.CHORDMINI_GATEWAY_ADMISSION,
    instances: process.env.CHORDMINI_GATEWAY_INSTANCES,
    gateway: process.env.CHORDMINI_HOSTED_GATEWAY_URL,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CHORDMINI_HOSTED_STAGING_AUTH = 'required';
    process.env.CHORDMINI_STAGING_ALLOWED_UIDS = 'uid-a';
    process.env.CHORDMINI_INFERENCE_AUTH = 'required';
    process.env.CHORDMINI_INFERENCE_SECRET = 'mp3-duration-secret-0123456789abcdef0123';
    process.env.FIREBASE_SERVICE_ACCOUNT_KEY = JSON.stringify({
      project_id: 'staging-test',
      private_key: 'test-only-not-a-credential',
      client_email: 'staging-test@example.invalid',
    });
    process.env.PYTHON_API_URL = 'http://127.0.0.1:5001';
    process.env.CHORDMINI_GATEWAY_ADMISSION = 'process';
    process.env.CHORDMINI_GATEWAY_INSTANCES = '1';
    delete process.env.CHORDMINI_DESKTOP_MODE;
    delete process.env.CHORDMINI_HOSTED_GATEWAY_URL;
    resetGatewayAdmissionForTests();
    mockVerifyIdToken.mockResolvedValue({ uid: 'uid-a' });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      json: async () => ({ success: true, beats: [1], bpm: 120, model_used: 'madmom' }),
      text: async () => '{}',
    });
    global.fetch = fetchMock as never;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    resetGatewayAdmissionForTests();
    jest.restoreAllMocks();
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('CHORDMINI_INFERENCE_AUTH', original.auth);
    restore('CHORDMINI_INFERENCE_SECRET', original.secret);
    restore('CHORDMINI_HOSTED_STAGING_AUTH', original.staging);
    restore('CHORDMINI_STAGING_ALLOWED_UIDS', original.allow);
    restore('FIREBASE_SERVICE_ACCOUNT_KEY', original.admin);
    restore('CHORDMINI_DESKTOP_MODE', original.desktop);
    restore('PYTHON_API_URL', original.python);
    restore('CHORDMINI_GATEWAY_ADMISSION', original.admission);
    restore('CHORDMINI_GATEWAY_INSTANCES', original.instances);
    restore('CHORDMINI_HOSTED_GATEWAY_URL', original.gateway);
  });

  async function submit(bytes: Uint8Array, name: string) {
    const form = new FormData();
    form.append('file', new File([bytes], name, { type: 'audio/mpeg' }));
    form.append('detector', 'madmom');
    form.append('duration', '1');
    form.append('uid', 'forged-uid');
    return postBeats({
      formData: async () => form,
      headers: new Headers({ authorization: 'Bearer aaa.header.signature' }),
      url: 'http://127.0.0.1:3000/api/detect-beats?duration=1',
    } as never);
  }

  it('does not call Flask or keep a slot when MP3 validation fails', async () => {
    const forged = mpeg1Frames(Math.floor((301 * MPEG1_RATE) / MPEG1_SAMPLES));
    writeXing(forged.subarray(0, FRAME_32K), 1);
    const rejected = await submit(forged, 'forged.mp3');
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toMatchObject({ code: 'AUDIO_DURATION_EXCEEDED' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(gatewayAdmissionSnapshot('uid-a')).toEqual({ globalActive: 0, uidActive: 0 });

    const malformed = await submit(Uint8Array.from([0xff, 0xfb, 0x10]), 'cut.mp3');
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({ code: 'AUDIO_MALFORMED' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(gatewayAdmissionSnapshot()).toEqual({ globalActive: 0, uidActive: 0 });

    const held = await submit(mpeg1Frames(8), 'again.mp3');
    expect(held.status).toBe(429);
    await expect(held.json()).resolves.toMatchObject({ code: 'UID_MINUTE_QUOTA' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(gatewayAdmissionSnapshot('uid-a')).toEqual({ globalActive: 0, uidActive: 0 });

    setGatewayClockForTests(() => Date.now() + 61_000);
    const accepted = await submit(mpeg1Frames(8), 'short.mp3');
    expect(accepted.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(gatewayAdmissionSnapshot('uid-a')).toEqual({ globalActive: 0, uidActive: 0 });
  });
});
