import { NextRequest, NextResponse } from 'next/server';
import { createSafeTimeoutSignal } from '@/utils/environmentUtils';
import { validateOffloadUrl } from '@/utils/blobValidation';
import { deleteOffloadUrl } from '@/services/storage/offloadCleanupService';
import { verifyAppCheckRequest } from '@/utils/serverAppCheck';
import {
  desktopPythonPolicyResponse,
} from '@/server/analysisServiceAvailability';
import { requirePythonBackendResponse } from '@/server/desktopLoopback';
import { durationEligibility, MAX_ANALYSIS_DURATION_SECONDS } from '@/utils/analysisDurationLimit';

export const maxDuration = 300;

function calculateProcessingTimeout(audioDuration: number): number {
  const baseTimeout = 30000;
  const processingTime = Math.ceil(audioDuration * 0.75 * 1000);
  const minTimeout = 120000;
  const maxTimeout = 290000;
  return Math.max(minTimeout, Math.min(maxTimeout, baseTimeout + processingTime));
}

function parseRequestedAudioDuration(formData: FormData): number | null | 'reject' {
  const raw = formData.get('audio_duration');
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const decision = durationEligibility(Number.parseFloat(raw));
  return decision.eligible ? decision.seconds : 'reject';
}

function redactOffloadDetail(details: string, offloadUrl: string): string {
  const queryStart = offloadUrl.indexOf('?');
  const query = queryStart >= 0 ? offloadUrl.slice(queryStart) : '';
  let text = query ? details.split(query).join('') : details;
  text = text.split(offloadUrl).join('[offload-url]');
  return text.replace(/(?:token|signature|X-Goog-Signature|X-Goog-Credential)=[^&\s]*/gi, '');
}

function failedOffloadBody(raw: string, offloadUrl: string, status: number, statusText: string) {
  const details = redactOffloadDetail(raw, offloadUrl);
  let parsed: { success?: unknown; error?: unknown; code?: unknown } | null = null;
  try {
    const value = JSON.parse(details) as { success?: unknown; error?: unknown; code?: unknown };
    if (value && typeof value === 'object') parsed = value;
  } catch {
    parsed = null;
  }
  const backendError = typeof parsed?.error === 'string' && parsed.error.trim() ? parsed.error : '';
  const code = typeof parsed?.code === 'string' ? parsed.code : undefined;
  return {
    success: false as const,
    error: backendError || `Backend processing failed: ${status} ${statusText}`,
    ...(code ? { code } : {}),
    details,
  };
}

function shouldDeleteOffloadAfterProcessing(formData: FormData): boolean {
  const raw = formData.get('delete_offload') ?? formData.get('delete_blob');
  if (typeof raw !== 'string') return true;
  const normalized = raw.trim().toLowerCase();
  return !(normalized === '0' || normalized === 'false' || normalized === 'no');
}

function getRequestedOffloadUrl(formData: FormData): string | null {
  const value = formData.get('offload_url') ?? formData.get('blob_url');
  return typeof value === 'string' ? value : null;
}

export async function POST(request: NextRequest) {
  try {
    // Verify App Check token
    const appCheck = await verifyAppCheckRequest(request);
    if (!appCheck.ok) {
      return NextResponse.json({ success: false, error: appCheck.error }, { status: appCheck.status || 403 });
    }

    const formData = await request.formData();
    const shouldDeleteOffload = shouldDeleteOffloadAfterProcessing(formData);
    const rawOffloadUrl = getRequestedOffloadUrl(formData);

    if (!rawOffloadUrl) {
      return NextResponse.json({ error: 'No offload storage URL provided' }, { status: 400 });
    }

    let offloadUrl: string;
    try {
      offloadUrl = validateOffloadUrl(rawOffloadUrl);
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 400 });
    }

    const requestedAudioDuration = parseRequestedAudioDuration(formData);
    if (requestedAudioDuration === 'reject') {
      return NextResponse.json(
        { success: false, error: 'Audio duration is not eligible for analysis.', code: 'DURATION_REJECTED' },
        { status: 400 },
      );
    }
    const timeoutValue = requestedAudioDuration === null
      ? calculateProcessingTimeout(MAX_ANALYSIS_DURATION_SECONDS)
      : calculateProcessingTimeout(requestedAudioDuration);
    const detector = (formData.get('detector') as string) || 'madmom';
    const force = formData.get('force') as string | null;
    const abortSignal = createSafeTimeoutSignal(timeoutValue);
    let shouldAttemptDeletion = false;

    async function callBackend(requestedDetector: string) {
      const backendFormData = new FormData();
      backendFormData.append('firebase_url', offloadUrl);
      backendFormData.append('detector', requestedDetector);
      if (force) backendFormData.append('force', force);

      const response = await requirePythonBackendResponse('/api/detect-beats-firebase', {
        method: 'POST',
        body: backendFormData,
        signal: abortSignal,
      });
      shouldAttemptDeletion = true;
      return response;
    }

    let response = await callBackend(detector);
    if (!response.ok) {
      const errorText = await response.text();
      const isCheckpointError = errorText.includes("Can't load save_path") || errorText.includes('Beat Transformer is not available');
      if (detector === 'beat-transformer' && isCheckpointError) {
        response = await callBackend('madmom');
      } else {
        return NextResponse.json(
          failedOffloadBody(errorText, offloadUrl, response.status, response.statusText),
          { status: response.status },
        );
      }

      if (!response.ok) {
        const failureText = await response.text();
        return NextResponse.json(
          failedOffloadBody(failureText, offloadUrl, response.status, response.statusText),
          { status: response.status },
        );
      }
    }

    const result = await response.json() as { success?: boolean; error?: unknown; code?: unknown };
    if (result?.success === false) {
      const error = typeof result.error === 'string' ? result.error : 'Offload processing failed';
      const code = typeof result.code === 'string' ? result.code : undefined;
      return NextResponse.json(
        {
          success: false,
          error: redactOffloadDetail(error, offloadUrl),
          ...(code ? { code } : {}),
        },
        { status: 500 },
      );
    }

    if (shouldDeleteOffload && shouldAttemptDeletion) {
      try {
        await deleteOffloadUrl(offloadUrl);
      } catch (err) {
        console.warn('⚠️ Non-critical: failed to delete offload file after backend beat processing:', err);
      }
    }

    return NextResponse.json(result);
  } catch (error) {
    const policyFailure = desktopPythonPolicyResponse(error);
    if (policyFailure) {
      return policyFailure;
    }
    console.error('❌ Offload beat detection API error:', error);
    if (error instanceof Error && error.name === 'AbortError') {
      return NextResponse.json(
        { error: 'Beat detection timed out. The file may be too large or complex for processing.' },
        { status: 408 },
      );
    }

    const message = error instanceof Error ? error.message : 'Unknown error occurred during offload beat detection';
    return NextResponse.json(
      { error: redactOffloadDetail(message, '') },
      { status: 500 },
    );
  }
}