import { NextRequest, NextResponse } from 'next/server';
import { createSafeTimeoutSignal } from '@/utils/environmentUtils';
import { validateOffloadUrl } from '@/utils/blobValidation';
import { deleteOffloadUrl } from '@/services/storage/offloadCleanupService';
import { verifyAppCheckRequest } from '@/utils/serverAppCheck';
import {
  desktopPythonPolicyResponse,
} from '@/server/analysisServiceAvailability';
import { requirePythonBackendResponse } from '@/server/desktopLoopback';
import { durationEligibility } from '@/utils/analysisDurationLimit';

export const maxDuration = 300;

function shouldDeleteOffloadAfterProcessing(formData: FormData): boolean {
  const raw = formData.get('delete_offload') ?? formData.get('delete_blob');
  if (typeof raw !== 'string') return true;
  const normalized = raw.trim().toLowerCase();
  return !(normalized === '0' || normalized === 'false' || normalized === 'no');
}

function suppliedDurationRejected(formData: FormData): boolean {
  const raw = formData.get('audio_duration');
  if (typeof raw !== 'string' || raw.trim() === '') return false;
  return !durationEligibility(Number.parseFloat(raw)).eligible;
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
  let parsed: { error?: unknown; code?: unknown } | null = null;
  try {
    const value = JSON.parse(details) as { error?: unknown; code?: unknown };
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

    if (suppliedDurationRejected(formData)) {
      return NextResponse.json(
        { success: false, error: 'Audio duration is not eligible for analysis.', code: 'DURATION_REJECTED' },
        { status: 400 },
      );
    }

    const model = formData.get('model') as string | null;
    const detector = (formData.get('detector') as string | null) || model || null;
    const chordDict = (model === 'btc-sl' || model === 'btc-pl') ? 'large_voca' : 'full';
    const backendFormData = new FormData();
    backendFormData.append('firebase_url', offloadUrl);
    if (model) backendFormData.append('model', model);
    if (detector) backendFormData.append('detector', detector);
    backendFormData.append('chord_dict', chordDict);

    const response = await requirePythonBackendResponse('/api/recognize-chords-firebase', {
      method: 'POST',
      body: backendFormData,
      signal: createSafeTimeoutSignal(800000),
    });

    if (!response.ok) {
      const failureText = await response.text();
      return NextResponse.json(
        failedOffloadBody(failureText, offloadUrl, response.status, response.statusText),
        { status: response.status },
      );
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
    if (shouldDeleteOffload) {
      try {
        await deleteOffloadUrl(offloadUrl);
      } catch (err) {
        console.warn('⚠️ Non-critical: failed to delete offload file after backend chord processing:', err);
      }
    }

    return NextResponse.json(result);
  } catch (error) {
    const policyFailure = desktopPythonPolicyResponse(error);
    if (policyFailure) {
      return policyFailure;
    }
    console.error('❌ Offload chord recognition API error:', error);
    if (error instanceof Error && error.name === 'AbortError') {
      return NextResponse.json(
        { error: 'Chord recognition timed out. The file may be too large or complex for processing.' },
        { status: 408 },
      );
    }

    const message = error instanceof Error ? error.message : 'Unknown error occurred during offload chord recognition';
    return NextResponse.json(
      { error: redactOffloadDetail(message, '') },
      { status: 500 },
    );
  }
}