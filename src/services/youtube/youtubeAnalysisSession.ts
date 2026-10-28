/**
 * Identity for one YouTube analysis request.
 * A lease dies when another video or source takes over, when a newer
 * analysis starts, or when the owning view unmounts. Local-file and
 * authorized-file sessions stay on their own controllers.
 */

import type { AnalysisInputSource } from '@/stores/analysisInputSourceStore';

export interface YouTubeAnalysisLease {
  videoId: string;
  generation: number;
  source: AnalysisInputSource;
}

export interface YouTubeAnalysisSession {
  start(videoId: string, source: AnalysisInputSource): YouTubeAnalysisLease;
  observe(): YouTubeAnalysisLease;
  adopt(videoId: string, source: AnalysisInputSource): void;
  setMounted(mounted: boolean): void;
  isCurrent(lease: YouTubeAnalysisLease): boolean;
}

export function createYouTubeAnalysisSession(initial: {
  videoId: string;
  source: AnalysisInputSource;
}): YouTubeAnalysisSession {
  let generation = 0;
  let videoId = initial.videoId;
  let source = initial.source;
  let mounted = true;

  return {
    start(nextVideoId, nextSource) {
      generation += 1;
      videoId = nextVideoId;
      source = nextSource;
      return { videoId, generation, source };
    },
    observe() {
      return { videoId, generation, source };
    },
    adopt(nextVideoId, nextSource) {
      if (nextVideoId === videoId && nextSource === source) return;
      videoId = nextVideoId;
      source = nextSource;
      generation += 1;
    },
    setMounted(next) {
      if (mounted === next) return;
      mounted = next;
      generation += 1;
    },
    isCurrent(lease) {
      return mounted
        && source === 'youtube'
        && lease.source === 'youtube'
        && lease.videoId === videoId
        && lease.generation === generation;
    },
  };
}
