'use client';

import { useCallback, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { createAnalysisSessionController } from '@/components/analysis/localAnalysisSession';
import { analyzeAudioWithRateLimit } from '@/services/audio/audioAnalysisService';
import {
  keyFactFromDetection,
  saveCompletedLocalAnalysis,
} from '@/services/audio/localAnalysisHistory';
import { detectKey } from '@/services/audio/keyDetectionService';
import {
  guitarAccompanimentCapo,
  linkedResultApplies,
  presentLinkedMusicFacts,
  shiftAnalysisToVideoTimeline,
  type LinkedMusicFacts,
} from '@/services/youtube/linkedAnalysisSession';
import {
  directUploadRejectionMessage,
  inspectDirectUploadFile,
} from '@/services/audio/directUploadPolicy';
import type { AnalysisResult } from '@/types/audioAnalysis';
import type { AudioProcessingState } from '@/services/audio/audioProcessingService';
import type { BeatDetectorType, ChordDetectorType } from '@/hooks/chord-analysis/useModelState';
import { getHydrationSafeRuntime } from '@/runtime/appRuntime';
import { startYouTubeAnalysisAllowed } from '@/stores/analysisInputSourceStore';
import {
  abandonDiagnosticSession,
  bindDiagnosticSession,
  noteAnalysisCompleted,
  noteAnalysisFailed,
  noteAudioRejectedCode,
  observeHistorySave,
} from '@/services/audio/analysisDiagnostics';
import { isDurationGateError } from '@/utils/analysisDurationLimit';
import { analysisServiceCodeFrom } from '@/utils/analysisServiceError';

export interface AuthorizedRunRequest {
  file: File;
  offsetSeconds: number;
  syncAllowed: boolean;
}

export interface AuthorizedRunResult {
  appliedToVideo: boolean;
  stale: boolean;
  facts: LinkedMusicFacts;
  videoId: string;
}

interface UseAuthorizedYouTubeFileParams {
  videoId: string;
  beatDetector: BeatDetectorType;
  chordDetector: ChordDetectorType;
  setAnalysisResults: Dispatch<SetStateAction<AnalysisResult | null>>;
  setAudioProcessingState: Dispatch<SetStateAction<AudioProcessingState>>;
}

export function useAuthorizedYouTubeFile({
  videoId,
  beatDetector,
  chordDetector,
  setAnalysisResults,
  setAudioProcessingState,
}: UseAuthorizedYouTubeFileParams) {
  const sessionRef = useRef(createAnalysisSessionController());
  const videoRef = useRef(videoId);
  const fileRef = useRef<File | null>(null);
  const lastRawRef = useRef<{ videoId: string; token: number; result: AnalysisResult } | null>(null);
  const [trackedVideoId, setTrackedVideoId] = useState(videoId);
  if (trackedVideoId !== videoId) {
    setTrackedVideoId(videoId);
    videoRef.current = videoId;
    fileRef.current = null;
    lastRawRef.current = null;
    sessionRef.current.invalidate();
    abandonDiagnosticSession();
    setAnalysisResults(null);
    setAudioProcessingState((prev) => ({
      ...prev,
      isAnalyzing: false,
      isAnalyzed: false,
      fromCache: false,
      fromFirestoreCache: false,
      error: null,
    }));
  }

  const run = useCallback(async (request: AuthorizedRunRequest): Promise<AuthorizedRunResult> => {
    const token = sessionRef.current.start();
    const diagnosticSessionId = bindDiagnosticSession(token);
    const activeVideoId = videoId;
    fileRef.current = request.file;
    const emptyFacts = presentLinkedMusicFacts({
      provenance: 'authorized-file',
      chordCount: 0,
      modelBpm: null,
      cachedBpm: null,
      displayBpm: null,
      modelMeter: null,
      cachedMeter: null,
      key: null,
      keyFromHeuristic: false,
      capoFret: null,
    });
    const stale = (): AuthorizedRunResult => ({
      appliedToVideo: false,
      stale: true,
      facts: emptyFacts,
      videoId: activeVideoId,
    });
    if (!linkedResultApplies({ videoId: activeVideoId, token }, { videoId, token })) return stale();

    const inspection = await inspectDirectUploadFile(request.file);
    if (!sessionRef.current.isCurrent(token) || videoRef.current !== activeVideoId || fileRef.current !== request.file) {
      return stale();
    }
    if (!inspection.ok && inspection.reason) {
      noteAudioRejectedCode(diagnosticSessionId, inspection.reason);
      const message = directUploadRejectionMessage(inspection.reason);
      setAudioProcessingState((prev) => ({
        ...prev,
        isAnalyzing: false,
        error: message,
      }));
      throw new Error(message);
    }

    setAudioProcessingState((prev) => ({
      ...prev,
      isAnalyzing: true,
      error: null,
    }));

    let raw: AnalysisResult;
    try {
      raw = await analyzeAudioWithRateLimit(request.file, beatDetector, chordDetector, undefined, diagnosticSessionId);
    } catch (error) {
      if (sessionRef.current.isCurrent(token) && videoRef.current === activeVideoId && !isDurationGateError(error)) {
        noteAnalysisFailed(diagnosticSessionId, analysisServiceCodeFrom(error));
      }
      if (sessionRef.current.isCurrent(token) && videoRef.current === activeVideoId) {
        setAudioProcessingState((prev) => ({
          ...prev,
          isAnalyzing: false,
          error: error instanceof Error ? error.message : 'Analysis failed',
        }));
      }
      throw error;
    }

    if (!sessionRef.current.isCurrent(token) || videoRef.current !== activeVideoId || fileRef.current !== request.file) {
      return stale();
    }

    const detectedKey = raw.chords.length > 0
      ? await detectKey(raw.chords.map((chord) => ({ chord: chord.chord, time: chord.time })), true, false, false)
        .then((detected) => ({
          fact: keyFactFromDetection(detected),
          heuristic: Boolean(detected.fromHeuristicFallback),
        }))
        .catch(() => ({ fact: null, heuristic: false }))
      : { fact: null, heuristic: false };

    if (!sessionRef.current.isCurrent(token) || videoRef.current !== activeVideoId || fileRef.current !== request.file) {
      return stale();
    }
    if (!startYouTubeAnalysisAllowed()) {
      setAudioProcessingState((prev) => ({
        ...prev,
        isAnalyzing: false,
        isExtracting: false,
        isDownloading: false,
      }));
      return stale();
    }

    if (getHydrationSafeRuntime() === 'electron') {
      await observeHistorySave(diagnosticSessionId, () => saveCompletedLocalAnalysis({
        token,
        file: request.file,
        isCurrent: (value) => sessionRef.current.isCurrent(value) && videoRef.current === activeVideoId,
        isMounted: () => videoRef.current === activeVideoId,
        activeFile: () => fileRef.current,
        result: raw,
        keyObservation: Promise.resolve(detectedKey.fact),
        runtime: 'electron',
        analyzedAt: new Date().toISOString(),
      }));
    }

    if (!sessionRef.current.isCurrent(token) || videoRef.current !== activeVideoId || fileRef.current !== request.file) {
      return stale();
    }

    lastRawRef.current = { videoId: activeVideoId, token, result: raw };

    const facts = presentLinkedMusicFacts({
      provenance: 'authorized-file',
      chordCount: raw.chords.length,
      modelBpm: raw.desktopHistory?.modelBpm ?? null,
      cachedBpm: null,
      displayBpm: typeof raw.beatDetectionResult?.bpm === 'number' ? raw.beatDetectionResult.bpm : null,
      modelMeter: raw.desktopHistory?.meter?.beatsPerBar ?? null,
      cachedMeter: null,
      key: detectedKey.fact?.value ?? null,
      keyFromHeuristic: detectedKey.heuristic,
      capoFret: guitarAccompanimentCapo(raw.chords.map((chord) => chord.chord)),
    });

    noteAnalysisCompleted(diagnosticSessionId);
    if (request.syncAllowed) {
      setAnalysisResults(shiftAnalysisToVideoTimeline(raw, request.offsetSeconds));
      setAudioProcessingState((prev) => ({
        ...prev,
        isAnalyzing: false,
        isAnalyzed: true,
        isExtracted: false,
        isExtracting: false,
        isDownloading: false,
        fromCache: false,
        fromFirestoreCache: false,
        error: null,
      }));
    } else {
      setAudioProcessingState((prev) => ({
        ...prev,
        isAnalyzing: false,
        error: null,
      }));
    }

    return {
      appliedToVideo: request.syncAllowed,
      stale: false,
      facts,
      videoId: activeVideoId,
    };
  }, [beatDetector, chordDetector, setAnalysisResults, setAudioProcessingState, videoId]);

  const publish = useCallback((offsetSeconds: number, syncAllowed: boolean) => {
    const saved = lastRawRef.current;
    if (!startYouTubeAnalysisAllowed()) return;
    if (!saved || saved.videoId !== videoId || !sessionRef.current.isCurrent(saved.token) || !syncAllowed) return;
    setAnalysisResults(shiftAnalysisToVideoTimeline(saved.result, offsetSeconds));
    setAudioProcessingState((prev) => ({
      ...prev,
      isAnalyzing: false,
      isAnalyzed: true,
      isExtracted: false,
      isExtracting: false,
      isDownloading: false,
      fromCache: false,
      fromFirestoreCache: false,
      error: null,
    }));
  }, [setAnalysisResults, setAudioProcessingState, videoId]);

  return { run, publish };
}
