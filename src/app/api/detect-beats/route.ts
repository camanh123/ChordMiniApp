import { NextRequest, NextResponse } from 'next/server';
import { createSafeTimeoutSignal } from '@/utils/environmentUtils';
import { getAudioDurationFromFile } from '@/utils/audioDurationUtils';
import { getPythonApiUrl } from '@/config/serverBackend';
import { verifyAppCheckRequest } from '@/utils/serverAppCheck';
import {
  analysisServiceGateResponse,
  desktopAnalysisConnectionResponse,
  desktopModelGateResponse,
  desktopPythonPolicyResponse,
} from '@/server/analysisServiceAvailability';
import { requirePythonBackendResponse } from '@/server/desktopLoopback';
import {
  formDataForDetectorRetry,
  redactInferenceSecret,
  scrubInferencePayload,
  stripUntrustedInferenceFields,
  upstreamAuthFailure,
} from '@/server/inferenceUpstream';
import { gateHostedStagingThenForward } from '@/server/hostedStagingAuth';
import { desktopHostedGatewayResponse } from '@/server/hostedGatewayForward';
import type { AdmissionContext } from '@/server/gatewayAdmission';
import { declaredUploadRejection, runAdmittedHostedInference } from '@/server/gatewayAudioGuard';

/**
 * Beat Detection API Route
 *
 * This route proxies beat detection requests to the Python backend
 * with proper timeout handling for long-running ML operations.
 */

// Configure Vercel function timeout (max 300 seconds for Vercel Hobby/Pro plan)
// Beat detection is heavy ML processing that can take several minutes
export const maxDuration = 300; // 5 minutes for ML processing
export async function POST(request: NextRequest) {
  try {
    // Verify App Check token
    const appCheck = await verifyAppCheckRequest(request);
    if (!appCheck.ok) {
      return NextResponse.json({ success: false, error: appCheck.error }, { status: appCheck.status || 403 });
    }

    const hostedGateway = await desktopHostedGatewayResponse(request, 'beats');
    if (hostedGateway) {
      return hostedGateway;
    }

    const hostedStaging = (process.env.CHORDMINI_HOSTED_STAGING_AUTH || '').trim().toLowerCase() === 'required'
      && process.env.CHORDMINI_DESKTOP_MODE !== '1';
    if (hostedStaging) {
      const declaredTooLarge = declaredUploadRejection(request.headers?.get('content-length') ?? null);
      if (declaredTooLarge && !declaredTooLarge.ok) {
        return NextResponse.json(declaredTooLarge.body, { status: declaredTooLarge.status });
      }
    }

    const unavailable = await analysisServiceGateResponse();
    if (unavailable) {
      return unavailable;
    }

    // Get the backend URL
    const backendUrl = getPythonApiUrl();

    console.log(`🥁 Processing beat detection request`);

    // Add environment detection debugging
    const { isLocalBackend } = await import('@/utils/backendConfig');
    const isLocalhost = isLocalBackend();
    console.log(`🌍 Environment: ${isLocalhost ? 'Localhost Development' : 'Production'} - Backend URL: ${backendUrl}`);

    // Get the form data from the request
    const formData = await request.formData();

    // Validate that we have a file
    const file = formData.get('file') as File;
    if (!file) {
      return NextResponse.json(
        { error: 'No audio file provided' },
        { status: 400 }
      );
    }

    const requestedBeatDetector = String(formData.get('detector') || 'madmom');
    const beatModelBlocked = desktopModelGateResponse(process.env, 'beat', requestedBeatDetector);
    if (beatModelBlocked) {
      return beatModelBlocked;
    }

    // Log file info
    const fileSizeMB = file.size / 1024 / 1024;
    console.log(`📁 Processing audio file: ${file.name} (${fileSizeMB.toFixed(2)}MB)`);

    if (isLocalhost) {
      console.log(`🏠 Localhost development - using direct Python backend for ${fileSizeMB.toFixed(2)}MB file`);
    } else {
      console.log(`📡 Direct multipart beat detection route invoked in production for ${fileSizeMB.toFixed(2)}MB file`);
    }

    console.log(`🔄 Using direct processing for file: ${file.name}`);

    // Log audio duration for debugging before sending to backend ML service
    try {
      const duration = await getAudioDurationFromFile(file);
      console.log(`🎵 Audio duration detected: ${duration.toFixed(1)} seconds - proceeding with beat detection analysis`);
    } catch (durationError) {
      console.warn(`⚠️ Could not detect audio duration for debugging: ${durationError}`);
    }

    // Create a safe timeout signal that works across environments
    const timeoutValue = 800000; // 13+ minutes timeout to match backend and vercel.json
    // // console.log(`🔍 API route timeout value: ${timeoutValue} (type: ${typeof timeoutValue}, isInteger: ${Number.isInteger(timeoutValue)})`);

    const abortSignal = createSafeTimeoutSignal(timeoutValue);

    stripUntrustedInferenceFields(formData);
    const forward = await gateHostedStagingThenForward(
      request.headers?.get('authorization') ?? null,
    );
    if (!forward.ok) {
      return NextResponse.json(forward.body, { status: forward.status });
    }

    const runInference = async (signal: AbortSignal, admission?: AdmissionContext) => {
    const targetUrl = `${backendUrl}/api/detect-beats`;
    const dispatch = (body: FormData) => {
      const exec = () => requirePythonBackendResponse('/api/detect-beats', {
        method: 'POST',
        body,
        headers: forward.headers,
        signal,
      });
      return admission ? admission.trackUpstream(exec) : exec();
    };
    console.log(`🚀 Forwarding beat detection request to: ${targetUrl}`);

    console.log(`📡 Making fetch request to Python backend...`);
    const requestedDetector = (formData.get('detector') as string) || 'madmom';
    let response = await dispatch(formData);

    console.log(`📊 Python backend response: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      let errorText = await response.text();
      const authFailure = upstreamAuthFailure(response.status, errorText);
      if (authFailure) {
        return NextResponse.json(authFailure.body, { status: authFailure.status });
      }
      console.error(`❌ Backend beat detection failed: ${response.status} ${response.statusText}`);

      // Retry with madmom if Beat-Transformer checkpoint is unavailable
      const isCheckpointError = errorText.includes("Can't load save_path") || errorText.includes('Beat Transformer is not available');
      if (requestedDetector === 'beat-transformer' && isCheckpointError) {
        console.warn('⚠️ Beat-Transformer checkpoint unavailable. Retrying with madmom...');
        const fd = formDataForDetectorRetry(formData, 'madmom');
        response = await dispatch(fd);
        if (!response.ok) {
          errorText = await response.text();
          const fallbackAuthFailure = upstreamAuthFailure(response.status, errorText);
          if (fallbackAuthFailure) {
            return NextResponse.json(fallbackAuthFailure.body, { status: fallbackAuthFailure.status });
          }
          console.error(`❌ Fallback to madmom also failed: ${response.status} ${response.statusText}`);
        } else {
          const result = await response.json();
          console.log(`✅ Beat detection successful after fallback to madmom`);
          return NextResponse.json(scrubInferencePayload(result));
        }
      }

      // Check if this is a 413 error (payload too large)
      if (response.status === 413) {
        return NextResponse.json(
          {
            error: `File too large for processing`,
            details: `The audio file (${fileSizeMB.toFixed(2)}MB) exceeds the maximum size limit. Please try with a smaller file or use the offload pipeline in production.`,
            status: 413,
            suggestion: 'Try using a shorter audio clip or compress the audio file.'
          },
          { status: 413 }
        );
      }

      // Check if this is a 403 error - likely port conflict or backend unavailable
      if (response.status === 403) {
        console.error(`❌ Beat detection API returned 403 Forbidden`);

        // Check if this is Apple AirTunes intercepting port 5000
        const serverHeader = response.headers.get('server');
        if (serverHeader && serverHeader.includes('AirTunes')) {
          console.error(`🍎 CRITICAL: Port 5000 is being intercepted by Apple AirTunes service!`);
          console.error(`💡 Solution: Change Python backend to use a different port (e.g., 5001, 8000)`);

          return NextResponse.json(
            {
              error: 'Port conflict with Apple AirTunes',
              details: 'Port 5000 is being used by Apple AirPlay/AirTunes service instead of our Python backend',
              solution: 'Change the backend service to use a different port (e.g., 5001 or 8000).',
            },
            { status: 503 }
          );
        }

        // For other 403 errors, return detailed debugging information
        return NextResponse.json(
          {
            error: 'Beat detection failed',
            details: `Backend returned 403 Forbidden. This may indicate the Python backend is not running or accessible.`,
            suggestion: 'Ensure Python backend is running on the correct port and accessible',
          },
          { status: 403 }
        );
      }

      return NextResponse.json(
        {
          error: 'Beat detection failed',
          details: `Backend error: ${response.status} ${response.statusText}`,
          suggestion: 'The audio file may be too large or in an unsupported format. Please try a shorter audio clip or different format.'
        },
        { status: response.status }
      );
    }

    // Get the response data
    const result = await response.json();
    console.log(`✅ Beat detection successful`);

    return NextResponse.json(scrubInferencePayload(result));
    };

    if (forward.uid) {
      return await runAdmittedHostedInference(
        forward.uid,
        process.env,
        request.signal,
        file,
        runInference,
      );
    }
    return await runInference(abortSignal);

  } catch (error: unknown) {
    const safeError = redactInferenceSecret(error instanceof Error ? error.message : String(error));
    console.error('❌ Beat detection API error:', safeError);

    const policyFailure = desktopPythonPolicyResponse(error);
    if (policyFailure) {
      return policyFailure;
    }

    const connectionFailure = desktopAnalysisConnectionResponse(error);
    if (connectionFailure) {
      return connectionFailure;
    }

    const errorMessage = safeError;
    
    // Handle timeout errors specifically
    if (errorMessage.includes('timeout') || errorMessage.includes('aborted')) {
      return NextResponse.json(
        {
          error: 'Beat detection processing timeout',
          details: 'The ML processing took longer than the 13-minute limit. This is an internal processing timeout, not an external service issue.',
          suggestion: 'Try using a shorter audio clip (under 5 minutes) or use the madmom detector which is faster but slightly less accurate. For very long tracks, consider splitting them into smaller segments.',
          timeoutLimit: '13+ minutes (800 seconds)',
          processingType: 'Internal ML Processing'
        },
        { status: 408 }
      );
    }

    return NextResponse.json(
      {
        error: 'Beat detection failed',
        details: errorMessage,
        suggestion: 'Please try again or contact support if the problem persists.'
      },
      { status: 500 }
    );
  }
}

// Handle OPTIONS requests for CORS
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
