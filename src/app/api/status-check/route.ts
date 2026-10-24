import { NextRequest, NextResponse } from 'next/server';
import { createSafeTimeoutSignal } from '@/utils/environmentUtils';
import { decideDesktopLoopback, fetchPythonBackend } from '@/server/desktopLoopback';

/**
 * Status Check API Route
 * 
 * This route provides status checking for backend endpoints
 * and acts as a proxy to avoid CORS issues in status monitoring
 */
export async function POST(request: NextRequest) {
  try {
    const { endpoint } = await request.json();
    
    if (!endpoint) {
      return NextResponse.json(
        { success: false, error: 'Endpoint parameter is required' },
        { status: 400 }
      );
    }

    const path = typeof endpoint === 'string' ? endpoint : String(endpoint);
    const outcome = await fetchPythonBackend(path, endpoint === '/api/detect-beats' || endpoint === '/api/recognize-chords'
      ? {
        method: 'POST',
        headers: { Accept: 'application/json' },
        signal: createSafeTimeoutSignal(25000),
      }
      : {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: createSafeTimeoutSignal(25000),
      });
    if (outcome.state !== 'response') {
      return NextResponse.json(
        { success: false, error: 'Analysis service unavailable' },
        { status: 503 },
      );
    }
    const response = outcome.response;
    const expectedError = (endpoint === '/api/detect-beats' || endpoint === '/api/recognize-chords')
      && response.status === 400;

    const responseText = await response.text();
    let responseData;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = { error: responseText };
    }

    // Determine if the endpoint is healthy based on expected behavior
    const isHealthy = response.ok || expectedError;
    
    return NextResponse.json({
      success: isHealthy,
      status: response.status,
      data: responseData,
      error: isHealthy ? undefined : `HTTP ${response.status}: ${responseData.error || response.statusText}`,
      expectedError
    });

  } catch (error) {
    console.error(
      'Status check error:',
      decideDesktopLoopback().scope === 'passthrough' ? error : 'desktop loopback request failed',
    );
    
    // Check if it's a timeout error
    const isTimeout = error instanceof Error && 
      (error.name === 'AbortError' || error.message.includes('timeout'));
    
    return NextResponse.json(
      {
        success: false,
        error: isTimeout ? 'Request timeout (backend may be cold starting)' :
               decideDesktopLoopback().scope === 'passthrough'
                 ? (error instanceof Error ? error.message : 'Unknown error')
                 : 'Analysis service unreachable',
        timeout: isTimeout
      },
      { status: isTimeout ? 408 : 500 }
    );
  }
}
