import { NextResponse } from 'next/server';
import { createSafeTimeoutSignal } from '@/utils/environmentUtils';
import { decideDesktopLoopback, fetchPythonBackend } from '@/server/desktopLoopback';

/**
 * Health Check API Route
 * 
 * This route provides a health check for the Python backend
 * and acts as a proxy to avoid CORS issues in status monitoring
 */
export async function GET() {
  try {
    const outcome = await fetchPythonBackend('/', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
      signal: createSafeTimeoutSignal(25000),
    });
    if (outcome.state !== 'response') {
      return NextResponse.json(
        {
          success: false,
          error: 'Analysis service unavailable',
          status: 'unhealthy',
        },
        { status: 503 },
      );
    }
    const response = outcome.response;

    if (!response.ok) {
      return NextResponse.json(
        {
          success: false,
          error: `Backend health check failed: HTTP ${response.status} ${response.statusText}`,
          status: 'unhealthy'
        },
        { status: response.status }
      );
    }

    const data = await response.json();
    
    return NextResponse.json({
      success: true,
      data,
      status: 'healthy'
    });

  } catch (error) {
    console.error('Health check error:', decideDesktopLoopback().scope === 'passthrough' ? error : 'desktop loopback request failed');
    
    return NextResponse.json(
      {
        success: false,
        error: decideDesktopLoopback().scope === 'passthrough'
          ? (error instanceof Error ? error.message : 'Unknown error')
          : 'Analysis service unreachable',
        status: 'unhealthy'
      },
      { status: 500 }
    );
  }
}
