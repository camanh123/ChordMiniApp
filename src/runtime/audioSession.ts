/**
 * Browser boundary for the shared AudioContext.
 * Server rendering returns without constructing a context. Resume does not
 * create a context on its own; playback code still creates one from a gesture.
 */

export interface AudioSessionAvailability {
  available: boolean;
  reason?: 'server';
}

export function canUseAudioContext(): boolean {
  return typeof window !== 'undefined';
}

export async function resumeSharedAudioContext(): Promise<AudioSessionAvailability> {
  if (!canUseAudioContext()) {
    return { available: false, reason: 'server' };
  }

  const { audioContextManager } = await import('@/services/audio/audioContextManager');
  await audioContextManager.resume();
  return { available: true };
}
