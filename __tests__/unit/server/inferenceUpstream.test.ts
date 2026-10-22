/**
 * @jest-environment node
 *
 * CONTRACT: pure server forwarder. No Flask process and no model output.
 */
import { omitDesktopInferenceSecret } from '@/desktop/inferenceBoundary';
import {
  INFERENCE_TOKEN_HEADER,
  configuredInferenceSecret,
  formDataForDetectorRetry,
  inferenceForwardPlan,
  redactInferenceSecret,
  scrubInferencePayload,
  stripUntrustedInferenceFields,
  upstreamAuthFailure,
} from '@/server/inferenceUpstream';

const SECRET = 'contract-secret-0123456789abcdef0123456789abcdef';

describe('CONTRACT inference forwarder', () => {
  it('attaches the server secret only for an explicit protected mode', () => {
    expect(inferenceForwardPlan({ CHORDMINI_INFERENCE_AUTH: 'required', CHORDMINI_INFERENCE_SECRET: SECRET })).toEqual({
      ok: true,
      headers: { [INFERENCE_TOKEN_HEADER]: SECRET },
    });
    expect(inferenceForwardPlan({ CHORDMINI_INFERENCE_AUTH: 'local', CHORDMINI_INFERENCE_SECRET: SECRET })).toEqual({
      ok: true,
      headers: {},
    });
    expect(inferenceForwardPlan({ CHORDMINI_INFERENCE_SECRET: SECRET })).toEqual({
      ok: true,
      headers: {},
    });
  });

  it('fails closed when protected mode has no usable secret', () => {
    expect(inferenceForwardPlan({ CHORDMINI_INFERENCE_AUTH: 'required' })).toMatchObject({
      ok: false,
      status: 503,
      body: { code: 'INFERENCE_AUTH_NOT_CONFIGURED' },
    });
    expect(configuredInferenceSecret({
      CHORDMINI_INFERENCE_SECRET: 'short-secret',
    })).toBeNull();
    expect(configuredInferenceSecret({
      CHORDMINI_INFERENCE_SECRET: 'changeme',
    })).toBeNull();
    expect(configuredInferenceSecret({
      CHORDMINI_INFERENCE_SECRET: SECRET,
      SECRET_KEY: SECRET,
    })).toBeNull();
    expect(inferenceForwardPlan({
      CHORDMINI_INFERENCE_AUTH: 'mystery',
      CHORDMINI_INFERENCE_SECRET: 'changeme',
    }).ok).toBe(false);
  });

  it('does not give the desktop process a protected token', () => {
    const plan = inferenceForwardPlan({
      CHORDMINI_DESKTOP_MODE: '1',
      CHORDMINI_INFERENCE_AUTH: 'required',
      CHORDMINI_INFERENCE_SECRET: SECRET,
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(JSON.stringify(plan.body)).not.toContain(SECRET);
      expect(plan.body.code).toBe('INFERENCE_AUTH_NOT_AVAILABLE');
    }
    expect(inferenceForwardPlan({
      CHORDMINI_DESKTOP_MODE: '1',
      CHORDMINI_INFERENCE_AUTH: 'local',
      CHORDMINI_INFERENCE_SECRET: SECRET,
    })).toEqual({ ok: true, headers: {} });
  });

  it('strips caller credentials and keeps the audio file', () => {
    const formData = new FormData();
    const file = new File([new Uint8Array([1, 2, 3])], 'clip.wav', { type: 'audio/wav' });
    formData.append('file', file);
    formData.append('detector', 'madmom');
    formData.append('X-ChordMini-Inference-Token', SECRET);
    formData.append('audio_path', '/tmp/secret.wav');
    formData.append('firebase_url', 'https://example.invalid/audio');

    stripUntrustedInferenceFields(formData);

    expect(formData.get('file')).toBe(file);
    expect(formData.get('detector')).toBe('madmom');
    expect(formData.get('X-ChordMini-Inference-Token')).toBeNull();
    expect(formData.get('audio_path')).toBeNull();
    expect(formData.get('firebase_url')).toBeNull();

    const retry = formDataForDetectorRetry(formData, 'madmom');
    retry.append('token', SECRET);
    const cleaned = formDataForDetectorRetry(retry, 'madmom');
    expect(cleaned.get('detector')).toBe('madmom');
    expect(cleaned.get('token')).toBeNull();
    const forwarded = cleaned.get('file') as File;
    expect(forwarded.name).toBe('clip.wav');
    expect(forwarded.size).toBe(file.size);
  });

  it('replaces upstream authentication bodies and scrubs a reflected secret', () => {
    const failed = upstreamAuthFailure(401, JSON.stringify({
      success: false,
      error: SECRET,
      code: 'AUTH_FAILED',
    }));
    expect(failed?.status).toBe(401);
    expect(JSON.stringify(failed?.body)).not.toContain(SECRET);

    const configured = upstreamAuthFailure(503, JSON.stringify({ code: 'AUTH_NOT_CONFIGURED' }));
    expect(configured?.body.code).toBe('INFERENCE_AUTH_NOT_CONFIGURED');
    expect(upstreamAuthFailure(500, 'Inference failed')).toBeNull();

    const env = { CHORDMINI_INFERENCE_SECRET: SECRET };
    expect(redactInferenceSecret(`down ${SECRET}`, env)).toBe('down [redacted]');
    expect(scrubInferencePayload({ success: true, note: SECRET }, env)).toEqual({
      success: true,
      note: '[redacted]',
    });
  });

  it('removes inference secrets from the desktop child environment', () => {
    const child = omitDesktopInferenceSecret({
      PYTHON_API_URL: 'http://127.0.0.1:5001',
      CHORDMINI_INFERENCE_SECRET: SECRET,
      NEXT_PUBLIC_CHORDMINI_INFERENCE_SECRET: SECRET,
    });
    expect(child.PYTHON_API_URL).toBe('http://127.0.0.1:5001');
    expect(child.CHORDMINI_INFERENCE_SECRET).toBeUndefined();
    expect(child.NEXT_PUBLIC_CHORDMINI_INFERENCE_SECRET).toBeUndefined();
  });
});
