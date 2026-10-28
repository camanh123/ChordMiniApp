"use client";

import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { Button } from '@heroui/react';
import { addToast } from '@heroui/react';
import { mergeToastClassNames } from '@/utils/toastStyles';
import Navigation from '@/components/common/Navigation';
import { useI18n } from '@/i18n/I18nProvider';
import { analyzeAudioWithRateLimit, AnalysisResult } from '@/services/chord-analysis/chordRecognitionService';
import { createAnalysisSessionController, runGuardedAnalysis } from '@/components/analysis/localAnalysisSession';
import {
  createHistoryKeyGate,
  keyFactFromDetection,
  saveCompletedLocalAnalysis,
} from '@/services/audio/localAnalysisHistory';
import type { HistorySaveOutcome } from '@/services/audio/localAnalysisHistory';
import { deleteLyricHistory, saveLyricHistory } from '@/services/audio/lyricHistoryClient';
import { resolveRuntimeAfterHydration } from '@/runtime/appRuntime';
import { ProcessingStatusSkeleton } from '@/components/common/SkeletonLoaders';
import {
  getChordGridData as getChordGridDataService
} from '@/services/chord-analysis/chordGridCalculationService';

// Dynamic imports for heavy components with better loading states
const HeroUIBeatModelSelector = dynamic(() => import('@/components/analysis/HeroUIBeatModelSelector'), {
  loading: () => (
    <div className="space-y-2">
      <div className="h-4 w-24 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
      <div className="h-12 bg-gray-100 dark:bg-gray-800 animate-pulse rounded-lg" />
    </div>
  ),
  ssr: false
});

const HeroUIChordModelSelector = dynamic(() => import('@/components/analysis/HeroUIChordModelSelector'), {
  loading: () => (
    <div className="space-y-2">
      <div className="h-4 w-24 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
      <div className="h-12 bg-gray-100 dark:bg-gray-800 animate-pulse rounded-lg" />
    </div>
  ),
  ssr: false
});


// Lyrics section (dynamic)
const LyricsSectionDyn = dynamic(() => import('@/components/lyrics/LyricsSection').then(mod => ({ default: mod.LyricsSection })), {
  loading: () => <div className="w-full h-64 bg-gray-100 dark:bg-gray-800 animate-pulse rounded-lg" />,
  ssr: false
});

const ProcessingStatusBanner = dynamic(() => import('@/components/analysis/ProcessingStatusBanner'), {
  loading: () => <ProcessingStatusSkeleton />,
  ssr: true
});

// Chatbot interface (dynamic)
const ChatbotInterfaceDyn = dynamic(() => import('@/components/chatbot/ChatbotInterface'), {
  loading: () => <div className="w-full h-96 bg-gray-100 dark:bg-gray-800 animate-pulse rounded-lg" />,
  ssr: false
});





const ChordGridContainer = dynamic(() => import('@/components/chord-analysis/ChordGridContainer').then(mod => ({ default: mod.ChordGridContainer })), {
  loading: () => <div className="h-64 bg-gray-100 dark:bg-gray-800 animate-pulse rounded-lg" />,
  ssr: false
});

const GuitarChordsTab = dynamic(() => import('@/components/chord-analysis/GuitarChordsTab'), {
  loading: () => <div className="h-64 bg-gray-100 dark:bg-gray-800 animate-pulse rounded-lg" />,
  ssr: false
});

const PianoVisualizerTab = dynamic(() => import('@/components/piano-visualizer/PianoVisualizerTab'), {
  loading: () => <div className="h-64 bg-gray-100 dark:bg-gray-800 animate-pulse rounded-lg" />,
  ssr: false
});

import { useProcessing } from '@/contexts/ProcessingContext';
import BeatTimeline from '@/components/analysis/BeatTimeline';
import { simplifyChordArray } from '@/utils/chordSimplification';
import { useUIStore, useIsLoopEnabled, useLoopStartBeat, useLoopEndBeat, useIsPitchShiftEnabled, useIsPitchShiftReady } from '@/stores/uiStore';
import LocalPracticeEntry from '@/components/analysis/LocalPracticeEntry';
import AnalysisSourceSelector from '@/components/analysis/AnalysisSourceSelector';
import AnalysisSourceDetail from '@/components/analysis/AnalysisSourceDetail';
import {
  applyRouteIntent,
  capturePublicationSnapshot,
  publishLocalAnalysisAllowed,
  useAnalysisInputSource,
} from '@/stores/analysisInputSourceStore';

import { useMetronomeSync } from '@/hooks/chord-playback/useMetronomeSync';
import { useMelodicTranscriptionPlayback } from '@/hooks/chord-playback/useMelodicTranscriptionPlayback';
import { metronomeService } from '@/services/chord-playback/metronomeService';
import { resolveLoopRange } from '@/hooks/chord-playback/useLoopPlayback';
import { useLyricsState } from '@/hooks/lyrics/useLyricsState';
import { useSegmentationState } from '@/hooks/lyrics/useSegmentationState';
import { useAnalysisStore } from '@/stores/analysisStore';
import UtilityBar from '@/components/analysis/UtilityBar';
import ScrollableTabContainer from '@/components/chord-analysis/ScrollableTabContainer';
import AudioPlaybackDock from '@/components/analysis/AudioPlaybackDock';
import type { UseChordPlaybackReturn } from '@/hooks/chord-playback/useChordPlayback';
import { estimateKeySignatureFromChords } from '@/utils/chordUtils';
import type { KeyDetectionResult } from '@/services/audio/keyDetectionService';
import { DEFAULT_PIANO_VOLUME, DEFAULT_GUITAR_VOLUME, DEFAULT_VIOLIN_VOLUME, DEFAULT_FLUTE_VOLUME } from '@/config/audioDefaults';
import { ChordPlaybackManager } from '@/components/chord-playback/ChordPlaybackManager';
import { usePlaybackStore, useCurrentBeatIndex } from '@/stores/playbackStore';
import { usePitchShiftAudio } from '@/hooks/chord-playback/usePitchShiftAudio';
import ResultsTabs from '@/components/homepage/ResultsTabs';
import type { TabKey } from '@/components/homepage/ResultsTabs';
import { searchLyricsWithFallback } from '@/services/lyrics/lyricsService';
import { synchronizedLyricsData } from '@/services/lyrics/lyricChordAlignment';
import LyricChordSyncPanel from '@/components/lyrics/LyricChordSyncPanel';
import type { LyricsData } from '@/types/musicAiTypes';
import { requestSheetSageTranscription } from '@/services/sheetsage/sheetSageTranscriptionClient';
import { useSheetSageBackendAvailability } from '@/hooks/sheetsage/useSheetSageBackendAvailability';
import { getSafeBeatModel, getSafeChordModel } from '@/utils/modelFiltering';
import {
  MAX_ANALYSIS_DURATION_MINUTES,
  durationGateDecision,
  durationLimitMessage,
  isDurationGateError,
  localFileSourceId,
  observeLocalFileDuration,
  type DurationObservation,
} from '@/utils/analysisDurationLimit';
import { getAudioDurationFromFile } from '@/utils/audioDurationUtils';
import {
  abandonDiagnosticSession,
  bindDiagnosticSession,
  noteAnalysisCompleted,
  noteAnalysisFailed,
  noteAudioRejected,
  observeHistorySave,
} from '@/services/audio/analysisDiagnostics';
import { requestBackendRetryAndObserve } from '@/services/audio/backendReadiness';
import AnalysisDiagnosticsPanel from '@/components/analysis/AnalysisDiagnosticsPanel';
import {
  analysisServiceCodeFrom,
  buildPrivacySafeDiagnostics,
} from '@/utils/analysisServiceError';
import MelodyTranscriptionStatusToast from '@/components/analysis/MelodyTranscriptionStatusToast';

export default function LocalAudioAnalyzePage() {
  applyRouteIntent('analyze', 'local-audio');
  const { t } = useI18n();
  const inputSource = useAnalysisInputSource();
  const showSheetSage = true;
  useSheetSageBackendAvailability(showSheetSage);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [analysisErrorCode, setAnalysisErrorCode] = useState<string | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [diagnosticsCopied, setDiagnosticsCopied] = useState(false);
  const [diagnosticsFallback, setDiagnosticsFallback] = useState<string | null>(null);
  const [lyricSearchTitle, setLyricSearchTitle] = useState('');
  const [lyricSearchArtist, setLyricSearchArtist] = useState('');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const durationLimitToastShownRef = useRef(false);

  const { lyrics, completeLyricsTranscription } = useLyricsState();
  const [fileDuration, setFileDuration] = useState<DurationObservation | null>(null);
  const fileDurationRef = useRef<DurationObservation | null>(null);
  const activeFileId = audioFile ? localFileSourceId(audioFile) : '';
  const fileDurationDecision = durationGateDecision(fileDuration, activeFileId);
  const analysisDurationLimitReason = audioFile && !fileDurationDecision.eligible
    ? durationLimitMessage(fileDurationDecision)
    : null;
  const durationBannerReason = !fileDurationDecision.eligible && fileDurationDecision.reason !== 'missing'
    ? durationLimitMessage(fileDurationDecision)
    : null;

  useEffect(() => {
    const durationExceeded = Boolean(audioFile) && !fileDurationDecision.eligible && fileDurationDecision.reason === 'exceeded';
    if (durationExceeded && !durationLimitToastShownRef.current) {
      durationLimitToastShownRef.current = true;
      addToast({
        title: t('analyze.tooLongTitle'),
        description: t('analyze.tooLongBody', { minutes: MAX_ANALYSIS_DURATION_MINUTES }),
        color: 'default',
        timeout: 5000,
        shouldShowTimeoutProgress: true,
        classNames: mergeToastClassNames({
          icon: 'text-warning-500',
          title: 'text-warning-600 dark:text-warning-400',
        }),
      });
      return;
    }

    if (!durationExceeded) {
      durationLimitToastShownRef.current = false;
    }
  }, [audioFile, fileDurationDecision, t]);
  const {
    segmentationData,
    showSegmentation,
    isSegmenting,
    segmentationError,
    toggleSegmentation,
    resetSegmentation,
  } = useSegmentationState();

  // Cleanup object URL on unmount
  useEffect(() => {
    return () => {
      if (objectUrlRef.current) {
        try { URL.revokeObjectURL(objectUrlRef.current); } catch {}
        objectUrlRef.current = null;
      }
    };
  }, []);

  const normalizeLyricsResponse = useCallback((resp: unknown): LyricsData | null => {
    return synchronizedLyricsData(resp);
  }, []);

  const handleManualLyricsSearch = useCallback(async () => {
    try {
      const resp = await searchLyricsWithFallback({ artist: lyricSearchArtist.trim(), title: lyricSearchTitle.trim(), prefer_synchronized: true });
      const normalized = normalizeLyricsResponse(resp);
      if (normalized) {
        completeLyricsTranscription(normalized);
      }
    } catch (e) {
      console.error('Manual lyrics search failed', e);
    }
  }, [lyricSearchArtist, lyricSearchTitle, normalizeLyricsResponse, completeLyricsTranscription]);


  // Use processing context
  const {
    // stage,
    // progress,
    setStage,
    setProgress,
    setStatusMessage,
    startProcessing,
    completeProcessing,
    failProcessing,
    reset: resetProcessing,
  } = useProcessing();
  // const { theme } = useTheme();

  // Define detector types
  type BeatDetectorType = 'madmom' | 'beat-transformer';
  type ChordDetectorType = 'chord-cnn-lstm' | 'btc-sl' | 'btc-pl';

  // Initialize model states with localStorage persistence
  const [beatDetector, setBeatDetector] = useState<BeatDetectorType>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('chordmini_beat_detector');
      if (saved && ['madmom', 'beat-transformer'].includes(saved)) {
        return getSafeBeatModel(saved as BeatDetectorType);
      }
      // If saved value was 'auto', default to 'madmom'
      if (saved === 'auto') {
        localStorage.setItem('chordmini_beat_detector', 'madmom');
      }
    }
    return 'madmom';
  });

  const [chordDetector, setChordDetector] = useState<ChordDetectorType>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('chordmini_chord_detector');
      if (saved && ['chord-cnn-lstm', 'btc-sl', 'btc-pl'].includes(saved)) {
        return getSafeChordModel(saved as ChordDetectorType);
      }
    }
    return 'chord-cnn-lstm';
  });

  // Audio processing state
  const [audioProcessingState, setAudioProcessingState] = useState({
    isExtracting: false,
    isExtracted: false,
    isAnalyzing: false,
    isAnalyzed: false,
    error: null as string | null,
    audioBuffer: null as AudioBuffer | null,
    audioUrl: null as string | null,
  });
  // Analysis results state (must be declared before dependent memos)
  const [analysisResults, setAnalysisResults] = useState<AnalysisResult | null>(null);

  // Lyrics state (before memos that depend on it)
  const [fontSize, setFontSize] = useState<number>(16);
  const theme = 'light';

  // Stable upload session id for chatbot context
  const uploadSessionId = useMemo(() => `upload_${Date.now().toString(36)}`, []);

  // Build SongContext for Chatbot (upload source)
  const uploadSongContext = useMemo(() => {
    if (!analysisResults) return undefined;
    return {
      uploadId: uploadSessionId,
      title: audioFile?.name || 'Uploaded Audio',
      duration,
      beats: analysisResults?.beats,
      downbeats: analysisResults?.downbeats,
      downbeats_with_measures: analysisResults?.downbeats_with_measures,
      beats_with_positions: analysisResults?.beats_with_positions,
      bpm: analysisResults?.beatDetectionResult?.bpm,
      time_signature: analysisResults?.beatDetectionResult?.time_signature,
      beatModel: analysisResults?.beatModel || beatDetector,
      chords: analysisResults?.chords,
      synchronizedChords: analysisResults?.synchronizedChords,
      chordModel: analysisResults?.chordModel || chordDetector,
      lyrics: lyrics || undefined,
      audioUrl: audioProcessingState.audioUrl || undefined,
    } as const;
  }, [analysisResults, uploadSessionId, audioFile?.name, duration, lyrics, beatDetector, chordDetector, audioProcessingState.audioUrl]);

  useEffect(() => {
    resetSegmentation();
  }, [analysisResults, resetSegmentation]);

  const segmentationDisabledReason = !uploadSongContext?.audioUrl
    ? 'Song segmentation becomes available after audio extraction finishes.'
    : uploadSongContext.audioUrl.startsWith('blob:')
      ? 'Song segmentation requires a backend-accessible extracted audio URL.'
      : !uploadSongContext.beats?.length
        ? 'Song segmentation becomes available after beat analysis finishes.'
        : undefined;

  const canAnalyzeSegmentation = !segmentationDisabledReason;

  const handleSegmentationToggle = useCallback(() => {
    void toggleSegmentation(uploadSongContext);
  }, [toggleSegmentation, uploadSongContext]);



  // Chord playback state (will be managed by ChordPlaybackManager)
  const [chordPlayback, setChordPlayback] = useState<UseChordPlaybackReturn>({
    isEnabled: false,
    pianoVolume: DEFAULT_PIANO_VOLUME,
    guitarVolume: DEFAULT_GUITAR_VOLUME,
    violinVolume: DEFAULT_VIOLIN_VOLUME,
    fluteVolume: DEFAULT_FLUTE_VOLUME,
    isReady: false,
    togglePlayback: () => {},
    setPianoVolume: () => {},
    setGuitarVolume: () => {},
    setViolinVolume: () => {},
    setFluteVolume: () => {}
  });

  const handleChordPlaybackChange = useCallback((next: UseChordPlaybackReturn) => {
    setChordPlayback(next);
  }, []);

  // Panels and countdown
  const [isLyricsPanelOpen, setIsLyricsPanelOpen] = useState<boolean>(false);
  const [isChatbotOpen, setIsChatbotOpen] = useState<boolean>(false);
  const [isCountdownEnabled, setIsCountdownEnabled] = useState<boolean>(false);
  const [isCountingDown, setIsCountingDown] = useState<boolean>(false);
  const [countdownDisplay, setCountdownDisplay] = useState<string>('');

  // Tempo context
  const timeSignature = analysisResults?.beatDetectionResult?.time_signature || 4;
  const bpm = analysisResults?.beatDetectionResult?.bpm || 120;

  // Countdown controller state (HTML audio)
  const countdownCtrlRef = useRef<{ intervalId: ReturnType<typeof setInterval> | null; aborted: boolean; token: number } | null>(null);
  const countdownStateRef = useRef<{ inProgress: boolean; completed: boolean }>({ inProgress: false, completed: false });

  const cancelCountdown = useCallback(() => {
    const ctrl = countdownCtrlRef.current;
    if (ctrl) {
      ctrl.aborted = true;
      if (ctrl.intervalId) clearInterval(ctrl.intervalId as unknown as number);
      countdownCtrlRef.current = null;
    }
    countdownStateRef.current.inProgress = false;
    setIsCountingDown(false);
    setCountdownDisplay('');
  }, []);

  const runCountdown = useCallback(async () => {
    if (!isCountdownEnabled) return true;
    if (countdownStateRef.current.inProgress) return false;

    const beatsPerMeasure = Math.max(2, Math.min(12, timeSignature || 4));
    const beatDurationSec = 60 / Math.max(1, bpm || 120);
    const totalMs = beatsPerMeasure * beatDurationSec * 1000;

    const start = Date.now();
    const token = Math.random();
    const ctrl = { intervalId: null as ReturnType<typeof setInterval> | null, aborted: false, token };
    countdownCtrlRef.current = ctrl;

    // Prepare state and ensure audio paused
    countdownStateRef.current.inProgress = true;
    countdownStateRef.current.completed = false;
    try { audioRef.current?.pause(); } catch {}
    setIsCountingDown(true);
    setCountdownDisplay(`${beatsPerMeasure}`);

    const ok = await new Promise<boolean>((resolve) => {
      ctrl.intervalId = setInterval(() => {
        if (!countdownCtrlRef.current || countdownCtrlRef.current.token !== token || countdownCtrlRef.current.aborted) {
          if (ctrl.intervalId) clearInterval(ctrl.intervalId as unknown as number);
          countdownStateRef.current.inProgress = false;
          setIsCountingDown(false);
          setCountdownDisplay('');
          resolve(false);
          return;
        }
        const elapsed = Date.now() - start;
        const remaining = Math.max(0, totalMs - elapsed);
        const remainingBeats = Math.ceil(remaining / (beatDurationSec * 1000));
        setCountdownDisplay(`${remainingBeats}`);
        if (remaining <= 0) {
          if (ctrl.intervalId) clearInterval(ctrl.intervalId as unknown as number);
          countdownCtrlRef.current = null;
          countdownStateRef.current.inProgress = false;
          countdownStateRef.current.completed = true;
          setIsCountingDown(false);
          setCountdownDisplay('');
          resolve(true);
        }
      }, 100);
    });

    return ok;
  }, [isCountdownEnabled, timeSignature, bpm]);


  // Metronome state
  const [isMetronomeEnabled, setIsMetronomeEnabled] = useState<boolean>(false);

  const disableMetronomeService = useCallback(() => {
    if (typeof window === 'undefined') {
      return;
    }

    void metronomeService.setEnabled(false);
  }, []);

  const toggleFollowMode = () => setIsFollowModeEnabled(prev => !prev);
  const toggleLyricsPanel = () => setIsLyricsPanelOpen(prev => !prev);
  const toggleChatbot = () => setIsChatbotOpen(prev => !prev);


  // Current state for playback
  // SSoT: currentBeatIndex is owned by playbackStore. We subscribe here so the
  // component re-renders when the animation loop publishes a new beat, and we
  // keep a ref for synchronous reads inside the rAF callback below.
  const currentBeatIndex = useCurrentBeatIndex();
  const setCurrentBeatIndex = useCallback((index: number) => {
    usePlaybackStore.getState().setCurrentBeatIndex(index);
  }, []);
  const currentBeatIndexRef = useRef(-1);
  const lastScrollTimeRef = useRef(0);

  const [isFollowModeEnabled, setIsFollowModeEnabled] = useState(true);

  // Tab state
  const [activeTab, setActiveTab] = useState<TabKey>('beatChordMap');
  const sheetSageResult = useAnalysisStore((state) => state.sheetSageResult);
  const isComputingSheetSage = useAnalysisStore((state) => state.isComputingSheetSage);
  const sheetSageError = useAnalysisStore((state) => state.sheetSageError);
  const isCheckingSheetSageBackend = useAnalysisStore((state) => state.isCheckingSheetSageBackend);
  const isSheetSageBackendAvailable = useAnalysisStore((state) => state.isSheetSageBackendAvailable);
  const sheetSageBackendError = useAnalysisStore((state) => state.sheetSageBackendError);
  const isMelodicTranscriptionPlaybackEnabled = useUIStore((state) => state.isMelodicTranscriptionPlaybackEnabled);
  const setIsMelodicTranscriptionPlaybackEnabled = useUIStore((state) => state.setIsMelodicTranscriptionPlaybackEnabled);


  // Key signature and chord correction states - now with proper key detection
  const [keySignature, setKeySignature] = useState<string | null>(null);
  const [isDetectingKey, setIsDetectingKey] = useState(false);
  const [keyDetectionAttempted, setKeyDetectionAttempted] = useState(false);
  const showCorrectedChords = false;
  const chordCorrections = useMemo(() => ({} as Record<string, string>), []);
  const [sequenceCorrections, setSequenceCorrections] = useState<
    KeyDetectionResult['sequenceCorrections'] | null
  >(null);

  // Get state from Zustand stores (only what's actually used in this page)

  const analysisSessionRef = useRef(createAnalysisSessionController());
  const [analysisSessionId, setAnalysisSessionId] = useState(0);
  const audioFileRef = useRef<File | null>(audioFile);
  audioFileRef.current = audioFile;
  const mountedRef = useRef(true);
  const historyKeyGateRef = useRef(createHistoryKeyGate());
  const historyRetryRef = useRef<(() => void) | null>(null);
  const activeAnalysisTokenRef = useRef(0);
  const [historyNotice, setHistoryNotice] = useState<'saved' | 'failed' | null>(null);
  const [historyAnchor, setHistoryAnchor] = useState<{ id: string; resultSha256: string } | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    const session = analysisSessionRef.current;
    const gate = historyKeyGateRef.current;
    return () => {
      mountedRef.current = false;
      session.invalidate();
      gate.abandon();
    };
  }, []);

  // Note: simplifyChords, showRomanNumerals, showSegmentation are managed by Zustand
  // and accessed directly by child components via their own selectors
  const hasSheetSageNotes = (sheetSageResult?.noteEvents?.length ?? 0) > 0;
  const hasSheetSageAudioSource = Boolean(audioFile || audioProcessingState.audioUrl);
  const hasReadySheetSageBackend = isSheetSageBackendAvailable === true;
  const needsSheetSageBackendForCompute = !hasSheetSageNotes;
  const melodicTranscriptionDisabledReason = isCheckingSheetSageBackend
    ? (needsSheetSageBackendForCompute ? 'Checking Sheet Sage backend...' : undefined)
    : needsSheetSageBackendForCompute && !hasReadySheetSageBackend
      ? (sheetSageBackendError || 'Sheet Sage backend unavailable.')
    : !hasSheetSageAudioSource
    ? 'Load audio before computing melodic transcription.'
    : undefined;

  const toggleMelodicTranscriptionPlayback = useCallback(async () => {
    if (!hasSheetSageAudioSource || isComputingSheetSage) {
      return;
    }

    const analysisActions = useAnalysisStore.getState();

    if (isMelodicTranscriptionPlaybackEnabled) {
      setIsMelodicTranscriptionPlaybackEnabled(false);
      return;
    }

    if (!hasSheetSageNotes) {
      if (!hasReadySheetSageBackend) {
        analysisActions.setSheetSageError(sheetSageBackendError || 'Sheet Sage backend unavailable.');
        return;
      }

      analysisActions.setIsComputingSheetSage(true);
      analysisActions.setSheetSageError(null);

      try {
        const result = await requestSheetSageTranscription(audioFile, audioProcessingState.audioUrl || null);
        analysisActions.setSheetSageResult(result);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown Sheet Sage error';
        analysisActions.setSheetSageError(message);
        analysisActions.setIsComputingSheetSage(false);
        return;
      } finally {
        analysisActions.setIsComputingSheetSage(false);
      }
    }

    setActiveTab('pianoVisualizer');
    setIsMelodicTranscriptionPlaybackEnabled(true);
  }, [
    audioFile,
    audioProcessingState.audioUrl,
    hasSheetSageAudioSource,
    hasReadySheetSageBackend,
    hasSheetSageNotes,
    isComputingSheetSage,
    isMelodicTranscriptionPlaybackEnabled,
    setActiveTab,
    setIsMelodicTranscriptionPlaybackEnabled,
    sheetSageBackendError,
  ]);

  // Use pitch shift audio hook
  usePitchShiftAudio({
    youtubePlayer: null, // No YouTube player in upload page
    audioRef,
    firebaseAudioUrl: audioProcessingState.audioUrl,
    isPlaying,
    currentTime,
    playbackRate,
    setIsPlaying,
    setCurrentTime,
  });

  useMelodicTranscriptionPlayback({
    sheetSageResult,
    audioUrl: audioProcessingState.audioUrl || null,
    segmentationData,
    audioRef,
    currentTime,
    isPlaying,
    isEnabled: isMelodicTranscriptionPlaybackEnabled,
  });

  // Persist model preferences to localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('chordmini_beat_detector', beatDetector);
    }
  }, [beatDetector]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('chordmini_chord_detector', chordDetector);
    }
  }, [chordDetector]);

  // Handle file upload. Playback uses the file immediately; analysis stays opt-in.
  const applySelectedAudioFile = (file: File) => {
    const nextSession = analysisSessionRef.current.invalidate();
    historyKeyGateRef.current.abandon();
    historyRetryRef.current = null;
    setHistoryNotice(null);
    setHistoryAnchor(null);
    setAnalysisSessionId(nextSession);
    abandonDiagnosticSession();
    fileDurationRef.current = null;
    setFileDuration(null);
    resetProcessing();
    setAudioFile(file);

    // Reset states
    setAudioProcessingState({
      isExtracting: false,
      isExtracted: false,
      isAnalyzing: false,
      isAnalyzed: false,
      error: null,
      audioBuffer: null,
      audioUrl: null,
    });
    setAnalysisResults(null);
    setAnalysisErrorCode(null);
    setPlaybackError(null);
    setDiagnosticsCopied(false);
    setDiagnosticsFallback(null);
    setKeyDetectionAttempted(false);
    setSequenceCorrections(null);

    // Create a blob URL for the audio element (Safari-safe) and track it for cleanup
    if (audioRef.current) {
      if (objectUrlRef.current) {
        try { URL.revokeObjectURL(objectUrlRef.current); } catch {}
        objectUrlRef.current = null;
      }
      const u = URL.createObjectURL(file);
      objectUrlRef.current = u;
      audioRef.current.src = u;
      audioRef.current.load();
    }

    const sourceId = localFileSourceId(file);
    void observeLocalFileDuration(file, () => getAudioDurationFromFile(file)).then((observation) => {
      if (audioFileRef.current !== file || localFileSourceId(audioFileRef.current) !== sourceId) return;
      fileDurationRef.current = observation;
      setFileDuration(observation);
    });
  };

  // Process and analyze the audio file
  const processAudioFile = async (override?: File) => {
    const selectedFile = override ?? audioFile;
    if (!selectedFile) return;
    const publication = capturePublicationSnapshot();
    if (!publishLocalAnalysisAllowed(publication)) return;
    audioFileRef.current = selectedFile;
    const sourceId = localFileSourceId(selectedFile);
    const measured = fileDurationRef.current?.sourceId === sourceId
      ? fileDurationRef.current
      : await observeLocalFileDuration(selectedFile, () => getAudioDurationFromFile(selectedFile));
    if (!publishLocalAnalysisAllowed(publication) || audioFileRef.current !== selectedFile) return;
    fileDurationRef.current = measured;
    setFileDuration(measured);
    const decision = durationGateDecision(measured, sourceId);

    const session = analysisSessionRef.current;
    const token = session.start();
    const diagnosticSessionId = bindDiagnosticSession(token);
    setAnalysisSessionId(token);
    setHistoryNotice(null);
    setHistoryAnchor(null);

    if (!decision.eligible) {
      noteAudioRejected(diagnosticSessionId, decision);
      setAudioProcessingState(prev => ({
        ...prev,
        error: durationLimitMessage(decision),
        isExtracting: false,
        isAnalyzing: false,
      }));
      return;
    }

    const reportFailure = (error: unknown) => {
      if (!session.isCurrent(token)) return;
      console.error('Error in audio processing:', error);
      if (!isDurationGateError(error)) {
        noteAnalysisFailed(diagnosticSessionId, analysisServiceCodeFrom(error));
      }

      let errorMessage = t('analyze.unknown');
      if (error instanceof Error) {
        errorMessage = error.message;
      } else if (typeof error === 'string') {
        errorMessage = error;
      }
      setAnalysisErrorCode(analysisServiceCodeFrom(error));
      setDiagnosticsCopied(false);
      setDiagnosticsFallback(null);

      setAudioProcessingState(prev => ({
        ...prev,
        error: errorMessage,
        isExtracting: false,
        isAnalyzing: false
      }));

      failProcessing(errorMessage);
    };

    try {
      setKeyDetectionAttempted(false);
      setSequenceCorrections(null);

      // Start processing context
      startProcessing();
      setStage('chord-recognition');
      setProgress(0);
      setStatusMessage(t('analyze.recognizing'));

      // Use existing object URL from audio element or create new one (track and cleanup)
      let audioUrl = audioRef.current?.src;
      if (!audioUrl) {
        if (objectUrlRef.current) {
          try { URL.revokeObjectURL(objectUrlRef.current); } catch {}
          objectUrlRef.current = null;
        }
        const u = URL.createObjectURL(selectedFile);
        objectUrlRef.current = u;
        audioUrl = u;
      }

      setAudioProcessingState(prev => ({
        ...prev,
        isExtracting: true,
        error: null,
        audioUrl,
      }));

      if (audioRef.current && audioRef.current.duration && duration === 0) {
        setDuration(audioRef.current.duration);
      }

      setAudioProcessingState(prev => ({
        ...prev,
        isExtracted: true,
        isExtracting: false,
        audioBuffer: null, // No longer using AudioBuffer
        isAnalyzing: true
      }));

      // Start chord and beat analysis with selected detectors using original File object
      // This avoids the 10x size bloat from AudioBuffer conversion (3.6MB → 41.7MB)
      // A newer file selection invalidates this token. The request itself is not cancelled.
      await runGuardedAnalysis(
        session,
        token,
        analyzeAudioWithRateLimit(selectedFile, beatDetector, chordDetector),
        (results) => {
          if (!publishLocalAnalysisAllowed(publication)) {
            setAudioProcessingState(prev => ({
              ...prev,
              isExtracting: false,
              isAnalyzing: false,
            }));
            resetProcessing();
            return;
          }

          setKeyDetectionAttempted(false);
          setIsDetectingKey(false);
          noteAnalysisCompleted(diagnosticSessionId);
          setAnalysisResults(results);
          activeAnalysisTokenRef.current = token;

          if (results.audioDuration && results.audioDuration > 0) {
            setDuration(results.audioDuration);
          }

          setAudioProcessingState(prev => ({
            ...prev,
            isExtracting: false,
            isAnalyzing: false,
            isAnalyzed: true
          }));

          setStage('complete');
          setProgress(100);
          setStatusMessage(t('analyze.complete'));
          completeProcessing();
          const runtime = resolveRuntimeAfterHydration({
            matchMedia: (query) => window.matchMedia(query),
            navigator: window.navigator,
          }).runtime;
          if (runtime !== 'electron') return;
          const keyObservation = results.chords.length > 0
            ? historyKeyGateRef.current.arm(token)
            : Promise.resolve(null);
          const analyzedFile = selectedFile;
          const publish = (outcome: HistorySaveOutcome) => {
            if (!session.isCurrent(token) || !mountedRef.current) return;
            if (outcome.state === 'saved' && outcome.visible) {
              setHistoryNotice('saved');
              if (outcome.resultSha256 && /^[0-9a-f]{64}$/.test(outcome.resultSha256)) {
                setHistoryAnchor({ id: outcome.id, resultSha256: outcome.resultSha256 });
              } else {
                setHistoryAnchor(null);
              }
            }
            if (outcome.state === 'failed' && outcome.visible) setHistoryNotice('failed');
          };
          const runSave = () => observeHistorySave(diagnosticSessionId, () => saveCompletedLocalAnalysis({
            token,
            file: analyzedFile,
            isCurrent: (value) => session.isCurrent(value),
            isMounted: () => mountedRef.current,
            activeFile: () => audioFileRef.current,
            result: results,
            keyObservation,
            runtime: 'electron',
            analyzedAt: new Date().toISOString(),
          }));
          historyRetryRef.current = () => {
            if (!session.isCurrent(token) || !mountedRef.current) return;
            void runSave().then(publish);
          };
          void runSave().then(publish);
        },
        reportFailure,
      );
    } catch (error) {
      reportFailure(error);
    }
  };

  // Audio player controls
  const reportPlaybackFailure = () => {
    setPlaybackError(t('analyze.playbackFailed'));
  };

  const playPause = () => {
    if (!audioRef.current) return;
    setPlaybackError(null);

    if (isPlaying) {
      audioRef.current.pause();
    } else {
      // Gate first play with optional 1-measure countdown
      if (isCountdownEnabled && !countdownStateRef.current.inProgress && !countdownStateRef.current.completed) {
        try { audioRef.current.pause(); } catch {}
        // Run countdown asynchronously, then start playback if not aborted
        void (async () => {
          const ok = await runCountdown();
          if (ok) {
            countdownStateRef.current.completed = false; // consume
            try {
              await audioRef.current?.play();
            } catch {
              reportPlaybackFailure();
            }
          }
        })();
        return;
      }
      const started = audioRef.current.play();
      if (started && typeof started.catch === 'function') {
        void started.catch(() => {
          reportPlaybackFailure();
        });
      }
    }
  };

  const changePlaybackRate = (rate: number) => {
    setPlaybackRate(rate);
    // Fan out through the store so the pitch shift service and HTMLAudioElement
    // stay aligned with the slider even when the local <audio> ref is not yet
    // attached.
    try {
      usePlaybackStore.getState().setPlayerPlaybackRate(rate);
    } catch (error) {
      console.warn('setPlayerPlaybackRate fan-out failed:', error);
    }
    if (audioRef.current) {
      audioRef.current.playbackRate = rate;
    }
  };


  // Set up audio element event listeners
  // Pitch-shift gating: used by the audio-element `timeupdate` listener
  // below to honour the "GrainPlayer is the sole writer of currentTime"
  // invariant. Declared here so the useEffect below captures a stable
  // selector subscription (Zustand re-renders when either flag flips).
  const isPitchShiftEnabledForGuard = useIsPitchShiftEnabled();
  const isPitchShiftReadyForGuard = useIsPitchShiftReady();
  useEffect(() => {
    const audioElement = audioRef.current;
    if (!audioElement) return;

    const handleLoadedMetadata = () => {
      if (audioElement) {
        setDuration(audioElement.duration);
      }
    };

    const handlePlay = () => {
      setIsPlaying(true);
    };
    const handlePause = () => {
      setIsPlaying(false);
    };
    const handleTimeUpdate = () => {
      if (!audioElement) return;
      // CLOCK AUTHORITY GUARD: see matching comment in usePlaybackState.ts.
      // During pitch-shift mode, GrainPlayer is the sole writer of
      // `currentTime`. The muted <audio> element keeps running its own
      // native clock and must NOT race the GrainPlayer tick here.
      if (isPitchShiftEnabledForGuard && isPitchShiftReadyForGuard) return;
      setCurrentTime(audioElement.currentTime);
    };

    audioElement.addEventListener('loadedmetadata', handleLoadedMetadata);

    audioElement.addEventListener('play', handlePlay);
    audioElement.addEventListener('pause', handlePause);
    audioElement.addEventListener('timeupdate', handleTimeUpdate);

    return () => {
      if (audioElement) {
        audioElement.removeEventListener('loadedmetadata', handleLoadedMetadata);
        audioElement.removeEventListener('play', handlePlay);
        audioElement.removeEventListener('pause', handlePause);
        audioElement.removeEventListener('timeupdate', handleTimeUpdate);
      }
    };
  }, [isPitchShiftEnabledForGuard, isPitchShiftReadyForGuard]);

  // Use standardized chord grid data processing from service
  // This ensures perfect consistency with the YouTube workflow
  const chordGridData = useMemo(() => {
    if (!analysisResults) {
      return {
        chords: [],
        beats: [],
        hasPadding: false,


        paddingCount: 0,
        shiftCount: 0,
        totalPaddingCount: 0,
        originalAudioMapping: []

      };
    }
    return getChordGridDataService(analysisResults);
  }, [analysisResults]);

  // Key detection effect - automatically detect key after chord analysis
  useEffect(() => {
    if (analysisResults?.chords && analysisResults.chords.length > 0 && !isDetectingKey && !keyDetectionAttempted) {
      const token = activeAnalysisTokenRef.current;
      setIsDetectingKey(true);
      setKeyDetectionAttempted(true);

      // Prepare chord data for key detection


      // CRITICAL FIX: Deduplicate consecutive identical chords to avoid beat-level analysis
      const rawChordData = analysisResults.chords


        .filter((chord) => chord.time !== undefined && chord.time !== null)
        .map((chord) => ({
          chord: chord.chord,
          time: chord.time as number // Safe to cast since we filtered out undefined/null
        }));

      // Remove consecutive duplicate chords to get only chord changes
      const chordData = rawChordData.filter((chord, index) => {
        if (index === 0) return true; // Always include first chord
        return chord.chord !== rawChordData[index - 1].chord; // Include only if different from previous
      });
      const heuristicKeySignature = estimateKeySignatureFromChords(chordData.map((entry) => entry.chord)).keySignature;

      setKeySignature(heuristicKeySignature);



      // Import and call key detection service with enharmonic correction and Roman numerals
      import('@/services/audio/keyDetectionService').then(({ detectKey }) => {
        // Use cache for sequence corrections (no bypass); request Roman numerals.
        // History persistence observes this same request. It does not call detectKey again.
        detectKey(chordData, true, false, true)
          .then(result => {
            const fact = keyFactFromDetection(result);
            if (!analysisSessionRef.current.isCurrent(token)) {
              historyKeyGateRef.current.provide(token, null);
              return;
            }
            historyKeyGateRef.current.provide(token, fact);
            setKeySignature(
              result.primaryKey && result.primaryKey !== 'Unknown'
                ? result.primaryKey
                : heuristicKeySignature
            );
            setSequenceCorrections(result.sequenceCorrections ?? null);
            // Update Roman numeral data in UI store for display
            try {
              useUIStore.getState().updateRomanNumeralData(result.romanNumerals ?? null);
            } catch {}
          })
          .catch(error => {
            historyKeyGateRef.current.provide(token, null);
            if (!analysisSessionRef.current.isCurrent(token)) return;
            console.error('Failed to detect key:', error);
            setSequenceCorrections(null);
            try { useUIStore.getState().updateRomanNumeralData(null); } catch {}
          })
          .finally(() => {
            setIsDetectingKey(false);
          });
      }).catch(() => {
        historyKeyGateRef.current.provide(token, null);
        setIsDetectingKey(false);
      });
    }
  }, [analysisResults?.chords, isDetectingKey, keyDetectionAttempted]);

// Apply optional chord simplification (UI toggle)
const simplifyChords = useUIStore((state) => state.simplifyChords);
const simplifiedChordGridData = useMemo(() => {
  if (!chordGridData) return chordGridData;
  let processedChords = chordGridData.chords || [];
  if (simplifyChords) {
    processedChords = simplifyChordArray(processedChords);
  }
  return { ...chordGridData, chords: processedChords } as typeof chordGridData;
}, [chordGridData, simplifyChords]);

  // Beat animation tracking for HTML audio elements
  useEffect(() => {
    if (!analysisResults || !chordGridData || chordGridData.chords.length === 0) {
      return;
    }

    const rafRef = { current: undefined as number | undefined };

    const updateBeatTracking = () => {
      // Stop scheduling when not playing to save battery
      if (!isPlaying) {
        return;
      }

      if (!audioRef.current) {
        rafRef.current = requestAnimationFrame(updateBeatTracking);
        return;
      }

      // Use audio element's currentTime directly for most accurate timing
      const time = audioRef.current.currentTime;

      // Only update beat index when playing
      if (isPlaying) {
        // Find current beat index based on time
        let newBeatIndex = -1;

        if (chordGridData.beats && chordGridData.beats.length > 0) {
          // FIXED: Handle (number | null)[] format correctly
          for (let i = 0; i < chordGridData.beats.length; i++) {
            const beatTime = chordGridData.beats[i];

            // Skip null entries (padding/shift beats)
            if (beatTime === null) {
              continue;
            }

            if (typeof beatTime === 'number' && time >= beatTime) {
              newBeatIndex = i;
            } else if (typeof beatTime === 'number') {
              // Stop when we find a beat time that's greater than current time
              break;
            }
          }


        }

        // Update beat index if it changed
        if (newBeatIndex !== currentBeatIndexRef.current && newBeatIndex >= 0) {
          currentBeatIndexRef.current = newBeatIndex;
          setCurrentBeatIndex(newBeatIndex);
        }
      }

      if (isPlaying) {
        rafRef.current = requestAnimationFrame(updateBeatTracking);
      }
    };

    // Start the animation loop only when playing
    if (isPlaying) {
      rafRef.current = requestAnimationFrame(updateBeatTracking);
    }
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, analysisResults]); // CRITICAL FIX: Intentionally limited dependencies to prevent animation loop restarts

  // FIXED: Auto-scroll with layout stability for superscript rendering

  // UtilityBar metronome toggle handler
  const handleMetronomeToggle = async (): Promise<boolean> => {
    const newEnabled = await toggleMetronomeWithSync();
    setIsMetronomeEnabled(newEnabled);
    return newEnabled;
  };

  useEffect(() => {
    if (!isFollowModeEnabled || currentBeatIndex === -1) return;

    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    // Throttle scrolls to at most ~1/sec to reduce layout thrashing
    if (now - lastScrollTimeRef.current < 1000) {
      return;
    }

    const beatElement = document.getElementById(`chord-${currentBeatIndex}`);
    if (beatElement) {
      // Wait for layout stability before scrolling to prevent jitter
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          lastScrollTimeRef.current = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
          beatElement.scrollIntoView({
            behavior: 'smooth',
            block: 'center',
            inline: 'nearest'
          });
        });
      });
    }
  }, [currentBeatIndex, isFollowModeEnabled]);



  // Metronome synchronization hook - use duration from audio element
  const { toggleMetronomeWithSync } = useMetronomeSync({
    currentBeatIndex,
    chordGridBeats: chordGridData.beats || [],
    currentTime,
    isPlaying,
    timeSignature: analysisResults?.beatDetectionResult?.time_signature || 4,
  });

  // Note: Beat click handling is managed internally by ChordGrid component via Zustand
  // No need for explicit handleBeatClick prop in upload page


  // Loop playback selectors (UI store)
  const isLoopEnabled = useIsLoopEnabled();
  const loopStartBeat = useLoopStartBeat();
  const loopEndBeat = useLoopEndBeat();

  // HTML Audio loop playback for upload page
  useEffect(() => {
    if (!isLoopEnabled || !audioRef.current) return;
    const beats = (simplifiedChordGridData?.beats || []) as Array<number | null>;
    if (!beats.length) return;
    const resolvedLoopRange = resolveLoopRange(beats, loopStartBeat, loopEndBeat, duration);
    if (!resolvedLoopRange) return;

    if (typeof currentTime === 'number' && currentTime >= resolvedLoopRange.endBoundary) {
      try {
        audioRef.current.currentTime = resolvedLoopRange.startTimestamp;
        // Maintain play state for seamless looping
        if (isPlaying) audioRef.current.play?.();
      } catch {}
    }
  }, [isLoopEnabled, loopStartBeat, loopEndBeat, currentTime, duration, simplifiedChordGridData?.beats, isPlaying]);

  // Inform UI store about original audio availability (enables pitch shift/UI)
  useEffect(() => {
    try {
      useUIStore.getState().initializeFirebaseAudioAvailable(Boolean(audioRef.current || audioProcessingState.audioUrl));
    } catch {}
  }, [audioProcessingState.audioUrl]);


  // Reset countdown flags when playback is paused
  useEffect(() => {
    if (!isPlaying) {
      cancelCountdown();
      countdownStateRef.current.completed = false;
      countdownStateRef.current.inProgress = false;
    }
  }, [isPlaying, cancelCountdown]);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      // Abort any active countdown interval
      cancelCountdown();

      useUIStore.getState().resetAnalysisUtilityBarState();
      usePlaybackStore.getState().setIsFollowModeEnabled(true);
      disableMetronomeService();
    };
  }, [cancelCountdown, disableMetronomeService]);


  // Initialize Zustand stores with page state
  // CRITICAL: Do NOT include Zustand-managed state (showRomanNumerals, simplifyChords) in dependencies
  // as that creates a circular loop causing race conditions during playback
  useEffect(() => {
    const analysisStore = useAnalysisStore.getState();
    const playbackStore = usePlaybackStore.getState();

    // Initialize AnalysisStore with local audio upload state
    analysisStore.setAnalysisResults(analysisResults);
    analysisStore.setIsAnalyzing(audioProcessingState.isAnalyzing);
    analysisStore.setAnalysisError(audioProcessingState.error || null);

    // Set stub values for upload page (not used but required for consistency)
    analysisStore.setCacheAvailable(false);
    analysisStore.setCacheCheckCompleted(true);
    analysisStore.setCacheCheckInProgress(false);
    analysisStore.setModelsInitialized(true);
    analysisStore.setLyrics(null);
    analysisStore.setShowLyrics(false);
    analysisStore.setHasCachedLyrics(false);
    analysisStore.setIsTranscribingLyrics(false);
    analysisStore.setLyricsError(null);

    // Initialize PlaybackStore
    playbackStore.setIsPlaying(isPlaying);
    playbackStore.setCurrentTime(currentTime);
    playbackStore.setDuration(duration);
    playbackStore.setPlaybackRate(playbackRate);
    playbackStore.setYoutubePlayer(null); // No YouTube player in upload page
    playbackStore.setAudioRef(audioRef as React.RefObject<HTMLAudioElement>);
    // NOTE: currentBeatIndex is owned by playbackStore directly (see useCurrentBeatIndex
    // hook at top of component); do NOT re-mirror it here or you create a feedback loop.
  }, [
    // CRITICAL: Do NOT include showRomanNumerals, simplifyChords, or other Zustand-managed state
    // Only include local state that needs to be synced to Zustand
    analysisResults, audioProcessingState.isAnalyzing, audioProcessingState.error,
    isPlaying, currentTime, duration, playbackRate
  ]);

  useEffect(() => {
    useAnalysisStore.getState().clearSheetSage();
    setIsMelodicTranscriptionPlaybackEnabled(false);
  }, [audioProcessingState.audioUrl, setIsMelodicTranscriptionPlaybackEnabled]);

  return (
    <div className="min-h-screen bg-background dark:bg-gray-900">
      <div className="flex flex-col min-h-screen bg-background dark:bg-dark-bg transition-colors duration-300">
      {/* Use the Navigation component */}
      <Navigation />

      {/* Processing Status Banner */}
      <ProcessingStatusBanner
        audioUrl={audioProcessingState.audioUrl || undefined}
        beatDetector={beatDetector}
        analysisSessionId={analysisSessionId}
      />
      <MelodyTranscriptionStatusToast
        isComputing={isComputingSheetSage}
        durationSeconds={duration}
        hasResult={hasSheetSageNotes}
        errorMessage={sheetSageError}
      />

      <main className="flex-grow container mx-auto px-1 sm:px-2 md:px-3" style={{ maxWidth: "98%" }}>
        {/* Removed heading to reclaim vertical space */}

        <div className="flex flex-col gap-6">
          {/* Main content - Chord Grid (full width) */}
          <div className="w-full">
            <div className="p-6 h-full transition-colors duration-300">
              {/* Hidden audio element */}
              <audio ref={audioRef} className="hidden" controls={false} />
              <AnalysisSourceSelector context="input" />
              <AnalysisDiagnosticsPanel />
              <AnalysisSourceDetail
                context="input"
                onAnalyzeRecording={(file) => {
                  audioFileRef.current = file;
                  applySelectedAudioFile(file);
                  void processAudioFile(file);
                }}
                localPractice={(
              <LocalPracticeEntry
                file={audioFile}
                onFileSelected={applySelectedAudioFile}
                hasAnalysis={Boolean(analysisResults)}
                serviceState={
                  analysisErrorCode === 'ANALYSIS_SERVICE_UNAVAILABLE'
                    ? 'unavailable'
                    : analysisErrorCode === 'ANALYSIS_SERVICE_NOT_CONFIGURED'
                      ? 'not_configured'
                      : undefined
                }
              >
                {audioFile && (
                  <div>
                    <AudioPlaybackDock
                      isPlaying={isPlaying}
                      onTogglePlayPause={playPause}
                      playbackRate={playbackRate}
                      onChangePlaybackRate={changePlaybackRate}
                      currentTime={currentTime}
                      duration={duration}
                      onSeek={(t: number) => {
                        if (audioRef.current) {
                          try { audioRef.current.currentTime = t; } catch {}
                        }
                      }}
                      disabled={!audioFile}
                      bpm={analysisResults?.beatDetectionResult?.bpm}
                    />
                    {playbackError && (
                      <p className="mt-2 text-sm text-red-600 dark:text-red-400">{playbackError}</p>
                    )}
                  </div>
                )}
              </LocalPracticeEntry>
                )}
              />
              <div className="flex flex-wrap items-center gap-4 md:gap-6 mb-4">
                {analysisResults ? (
                  <div className="w-full">
                    <AnalysisSourceSelector context="results" />
                  </div>
                ) : null}
                {/* LEFT: Tabs inline (wraps on small screens) */}
                {analysisResults && (
                  <div className="flex-1 min-w-[260px] md:min-w-[420px]">
                    <ResultsTabs
                      activeTab={activeTab}
                      setActiveTab={setActiveTab}
                      showLyrics
                      hasCachedLyrics={false}
                    />
                  </div>
                )}

                {/* RIGHT: File upload and Analyze controls */}
                {inputSource === 'local-audio' ? (
                <div className="flex flex-row gap-2 items-center ml-auto pl-2 md:pl-6">
                  <Button
                    onClick={() => { void processAudioFile(); }}
                    disabled={!audioFile || audioProcessingState.isExtracting || audioProcessingState.isAnalyzing || !!analysisDurationLimitReason}
                    color="primary"
                    variant="solid"
                    size="md"
                    className="font-medium bg-blue-600 hover:bg-blue-700 text-white border-blue-600 hover:border-blue-700 disabled:bg-gray-400 disabled:border-gray-400 disabled:text-gray-200"
                  >
                    {audioProcessingState.isExtracting ? t('analyze.processing') : t('analyze.analyze')}
                  </Button>
                </div>
                ) : null}
              </div>

              {durationBannerReason && (
                <div className="mb-4 rounded-md border border-warning-200 bg-warning-50 px-3 py-2 text-sm text-warning-800">
                  {!fileDurationDecision.eligible && fileDurationDecision.reason === 'exceeded'
                    ? `${t('analyze.tooLongTitle')}. ${t('analyze.tooLongBody', { minutes: MAX_ANALYSIS_DURATION_MINUTES })}`
                    : !fileDurationDecision.eligible && fileDurationDecision.reason === 'failed'
                      ? t('analyze.durationFailed')
                      : t('analyze.durationInvalid')}
                </div>
              )}
              {historyNotice === 'saved' && (
                <p className="mb-4 text-sm text-green-700 dark:text-green-400" role="status">
                  {t('analyze.historySaved')}
                </p>
              )}
              {historyNotice === 'failed' && (
                <div className="mb-4 text-sm text-amber-800 dark:text-amber-300" role="status">
                  <p>{t('analyze.historyFailed')}</p>
                  <button
                    type="button"
                    className="mt-1 underline"
                    onClick={() => historyRetryRef.current?.()}
                  >
                    {t('analyze.historyRetry')}
                  </button>
                </div>
              )}

              {/* Model Selectors - Hide when analysis is complete */}
              {!analysisResults && inputSource === 'local-audio' && (
                <div className="flex flex-col md:flex-row gap-4 mb-4">
                  <HeroUIBeatModelSelector
                    onChange={setBeatDetector}
                    defaultValue={beatDetector}
                    className={audioProcessingState.isAnalyzing ? 'opacity-50 pointer-events-none' : ''}
                  />
                  <HeroUIChordModelSelector
                    selectedModel={chordDetector}
                    onModelChange={setChordDetector}
                    disabled={audioProcessingState.isAnalyzing}
                    className=""
                  />
                </div>
              )}

              {/* Audio Analysis Status Indicator - Hide when analysis is complete */}
              {!analysisResults && (
                <div className="flex items-center justify-end text-sm mb-4">
                  {audioProcessingState.isExtracting && (
                    <div className="flex items-center text-gray-600 dark:text-gray-300">
                      <div className="animate-spin h-4 w-4 border-2 border-primary-500 border-t-transparent rounded-full mr-2"></div>
                      <span>{t('analyze.extracting')}</span>
                    </div>
                  )}

                  {audioProcessingState.isAnalyzing && (
                    <div className="flex items-center text-gray-600 dark:text-gray-300">
                      <div className="animate-spin h-4 w-4 border-2 border-primary-500 border-t-transparent rounded-full mr-2"></div>
                      <span>{t('analyze.analyzing')}</span>
                    </div>
                  )}

                  {audioProcessingState.error && (
                    <div className="w-full text-left text-red-600 dark:text-red-400">
                      <div className="flex items-start gap-2">
                        <svg xmlns="http://www.w3.org/2000/svg" className="mt-0.5 h-4 w-4 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                        </svg>
                        <div className="min-w-0">
                          <p>
                            {analysisErrorCode === 'ANALYSIS_BACKEND_NOT_READY'
                              ? audioProcessingState.error
                              : analysisErrorCode === 'ANALYSIS_SERVICE_NOT_CONFIGURED'
                              ? t('errors.notConfigured')
                              : analysisErrorCode === 'ANALYSIS_SERVICE_UNAVAILABLE'
                                ? t('errors.unavailable')
                                : audioProcessingState.error}
                          </p>
                          {analysisErrorCode === 'ANALYSIS_BACKEND_NOT_READY' && (
                            <button
                              type="button"
                              className="mt-2 text-xs font-medium text-gray-700 underline dark:text-gray-200"
                              onClick={() => {
                                void requestBackendRetryAndObserve();
                              }}
                            >
                              {t('analyze.retryBackend')}
                            </button>
                          )}
                          {analysisErrorCode === 'ANALYSIS_SERVICE_NOT_CONFIGURED' && (
                            <p className="mt-1">{t('errors.notConfiguredSuggestion')}</p>
                          )}
                          {analysisErrorCode === 'ANALYSIS_SERVICE_UNAVAILABLE' && (
                            <p className="mt-1">{t('errors.unavailableSuggestion')}</p>
                          )}
                          <button
                            type="button"
                            className="mt-2 text-xs font-medium text-gray-700 underline dark:text-gray-200"
                            onClick={() => {
                              const payload = buildPrivacySafeDiagnostics({
                                code: analysisErrorCode,
                                message: audioProcessingState.error || '',
                                runtime: process.env.NEXT_PUBLIC_APP_RUNTIME || 'web',
                                version: '0.6.5',
                              });
                              const write = navigator.clipboard?.writeText(payload);
                              if (!write) {
                                setDiagnosticsCopied(false);
                                setDiagnosticsFallback(payload);
                                return;
                              }
                              void write.then(() => {
                                setDiagnosticsCopied(true);
                                setDiagnosticsFallback(null);
                              }).catch(() => {
                                setDiagnosticsCopied(false);
                                setDiagnosticsFallback(payload);
                              });
                            }}
                          >
                            {diagnosticsCopied ? t('analyze.diagnosticsCopied') : t('analyze.copyDiagnostics')}
                          </button>
                          <pre className="sr-only" data-testid="analysis-diagnostics">
                            {buildPrivacySafeDiagnostics({
                              code: analysisErrorCode,
                              message: audioProcessingState.error || '',
                              runtime: process.env.NEXT_PUBLIC_APP_RUNTIME || 'web',
                              version: '0.6.5',
                            })}
                          </pre>
                          {diagnosticsFallback && (
                            <textarea
                              readOnly
                              aria-label={t('analyze.diagnosticsLabel')}
                              className="mt-2 w-full rounded border border-gray-300 bg-white p-2 text-xs text-gray-800 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                              value={diagnosticsFallback}
                            />
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  {audioProcessingState.isAnalyzed && !audioProcessingState.isAnalyzing && (
                    <div className="text-green-600 flex items-center">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-1" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                      <span>{t('analyze.complete')}</span>
                    </div>
                  )}
                </div>
              )}

              {/* UtilityBar will be rendered inline below tabs together with the AudioPlaybackDock */}


              {/* Analysis Results Tabs moved inline above with controls */}
              {analysisResults && (
                <div className="mb-4">

                  {/* Tab content */}
                  <div className="tab-content">
                    {/* Beat & Chord Map Tab */}
                    {activeTab === 'beatChordMap' && (
                      <ScrollableTabContainer variant="plain" heightClass="h-[60vh] md:h-[66vh]">
                        <div className={`flex flex-col md:flex-row gap-4`}>
                          {/* Grid area */}
                          <div className={`w-full transition-all duration-200`}>
                            <ChordGridContainer
                              analysisResults={analysisResults}
                              chordGridData={simplifiedChordGridData}
                              keySignature={keySignature}
                              isDetectingKey={isDetectingKey}
                              isChatbotOpen={isChatbotOpen}
                              isLyricsPanelOpen={isLyricsPanelOpen}
                              isUploadPage={true}
                              showCorrectedChords={showCorrectedChords}
                              chordCorrections={chordCorrections}
                              sequenceCorrections={sequenceCorrections}
                              segmentationData={segmentationData}
                            />
                            <div className="mt-3">
                              <BeatTimeline
                                beats={analysisResults?.beats || []}
                                downbeats={analysisResults?.downbeats || []}
                                currentBeatIndex={currentBeatIndex}
                                currentDownbeatIndex={-1}
                                duration={duration}
                              />
                            </div>
                          </div>

                          {/* Side panel area (md+) - disabled on upload page */}
                          {false && (
                            <div className="hidden md:block md:w-2/5">
                              {/* Lyrics Panel with manual search */}
                              {isLyricsPanelOpen && (
                                <div className="space-y-3">
                                  <div className="flex gap-2">
                                    <input
                                      type="text"
                                      placeholder="Song title"
                                      value={lyricSearchTitle}
                                      onChange={(e) => setLyricSearchTitle(e.target.value)}
                                      className="flex-1 px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                                    />
                                    <input
                                      type="text"
                                      placeholder="Artist"
                                      value={lyricSearchArtist}
                                      onChange={(e) => setLyricSearchArtist(e.target.value)}
                                      className="flex-1 px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                                    />
                                    <Button color="primary" variant="solid" onPress={handleManualLyricsSearch}>Search</Button>
                                  </div>
                                  <LyricsSectionDyn
                                    showLyrics={isLyricsPanelOpen}
                                    lyrics={lyrics}
                                    hasCachedLyrics={false}
                                    currentTime={currentTime}
                                    fontSize={fontSize}
                                    theme={theme}
                                    analysisResults={analysisResults}
                                    onFontSizeChange={setFontSize}
                                    segmentationData={segmentationData}
                                  />
                                </div>
                              )}

                              {/* Chatbot Panel */}
                              {isChatbotOpen && (
                                <div className="mt-4">
                                  <ChatbotInterfaceDyn
                                    isOpen={isChatbotOpen}
                                    onClose={() => setIsChatbotOpen(false)}
                                    songContext={uploadSongContext}
                                    className=""
                                    embedded={false}
                                  />
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </ScrollableTabContainer>
                    )}

                    {/* Guitar Chords Tab */}
                    {activeTab === 'guitarChords' && (
                      <GuitarChordsTab
                        analysisResults={analysisResults}
                        chordGridData={simplifiedChordGridData}
                        keySignature={keySignature}
                        isDetectingKey={isDetectingKey}
                        isChatbotOpen={isChatbotOpen}
                        isLyricsPanelOpen={isLyricsPanelOpen}
                        isUploadPage={true}
                        showCorrectedChords={showCorrectedChords}
                        chordCorrections={chordCorrections}
                        sequenceCorrections={sequenceCorrections}
                        segmentationData={segmentationData}
                        isChordPlaybackEnabled={chordPlayback.isEnabled}
                        audioUrl={audioProcessingState.audioUrl || null}
                      />
                    )}

                    <div hidden={activeTab !== 'lyricsChords'}>
                      <LyricChordSyncPanel
                        key={`${audioFile ? `${audioFile.name}:${audioFile.size}:${audioFile.lastModified}` : ''}:${analysisSessionId}`}
                        chords={analysisResults.chords}
                        currentTime={currentTime}
                        audioDuration={duration}
                        fileKey={audioFile ? `${audioFile.name}:${audioFile.size}:${audioFile.lastModified}` : ''}
                        sessionId={analysisSessionId}
                        historyResultSha256={historyAnchor?.resultSha256 ?? null}
                        onPersistLyrics={historyAnchor ? async (draft) => {
                          const outcome = await saveLyricHistory(historyAnchor.id, draft);
                          return outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason };
                        } : undefined}
                        onDeleteLyrics={historyAnchor ? async () => {
                          const outcome = await deleteLyricHistory(historyAnchor.id);
                          return { ok: outcome.ok };
                        } : undefined}
                        onSeek={(time) => {
                          if (audioRef.current) {
                            try { audioRef.current.currentTime = time; } catch { /* clock not ready */ }
                          }
                          setCurrentTime(time);
                        }}
                      />
                    </div>

                    {/* Piano Visualizer Tab */}
                    {activeTab === 'pianoVisualizer' && (
                      <PianoVisualizerTab
                        analysisResults={analysisResults}
                        chordGridData={simplifiedChordGridData}
                        keySignature={keySignature}
                        showCorrectedChords={showCorrectedChords}
                        chordCorrections={chordCorrections}
                        sequenceCorrections={sequenceCorrections}
                        segmentationData={segmentationData}
                        currentTime={currentTime}
                        isPlaying={isPlaying}
                        isChordPlaybackEnabled={chordPlayback.isEnabled}
                        audioUrl={audioProcessingState.audioUrl || null}
                        sheetSageResult={sheetSageResult}
                        showMelodicOverlay={isMelodicTranscriptionPlaybackEnabled && hasSheetSageNotes}
                      />
                    )}

                  </div>

                </div>
              )}

              {/* Local playback is available as soon as a file is selected.
                  Analysis-only controls stay behind a successful analysis. */}
              {(audioFile || analysisResults) && (
                <div className="mt-4">
                  <div className="flex flex-col md:flex-row md:items-center gap-3">
                    {analysisResults && (
                    <div className="flex-1 min-w-[280px] overflow-x-auto">
                      <div className="inline-flex w-max min-w-full">
                        <UtilityBar
                          isFollowModeEnabled={isFollowModeEnabled}
                          chordPlayback={chordPlayback}
                          melodicTranscriptionPlayback={showSheetSage ? {
                            isEnabled: isMelodicTranscriptionPlaybackEnabled,
                            hasTranscription: hasSheetSageNotes,
                            isLoading: isComputingSheetSage || (isCheckingSheetSageBackend && !hasSheetSageNotes),
                            disabled: !hasSheetSageAudioSource,
                            disabledReason: melodicTranscriptionDisabledReason,
                            errorMessage: sheetSageBackendError || sheetSageError,
                            canAdjustVolume: hasSheetSageNotes,
                            togglePlayback: toggleMelodicTranscriptionPlayback,
                          } : undefined}
                          youtubePlayer={undefined}
                          playbackRate={playbackRate}
                          setPlaybackRate={(rate: number) => changePlaybackRate(rate)}
                          toggleFollowMode={toggleFollowMode}
                          isCountdownEnabled={isCountdownEnabled}
                          isCountingDown={isCountingDown}
                          countdownDisplay={countdownDisplay}
                          toggleCountdown={() => setIsCountdownEnabled(prev => !prev)}
                          isChatbotOpen={isChatbotOpen}
                          isLyricsPanelOpen={isLyricsPanelOpen}
                          toggleChatbot={toggleChatbot}
                          toggleLyricsPanel={toggleLyricsPanel}
                          segmentation={{
                            isVisible: showSegmentation && !!segmentationData,
                            hasData: !!segmentationData,
                            isLoading: isSegmenting,
                            disabled: !canAnalyzeSegmentation && !segmentationData,
                            disabledReason: !segmentationData ? segmentationDisabledReason : undefined,
                            errorMessage: segmentationError,
                            onToggle: handleSegmentationToggle,
                          }}
                          metronome={{
                            isEnabled: isMetronomeEnabled,
                            toggleMetronomeWithSync: handleMetronomeToggle,
                          }}
                          totalBeats={simplifiedChordGridData?.beats?.length || 0}
                          isUploadPage={true}
                        />
                      </div>
                    </div>
                    )}

                  </div>

                  {/* Chord Playback Manager: manages state for UtilityBar mixer */}
                  {analysisResults && (
                  <div className="mt-3">
                    <ChordPlaybackManager
                      currentBeatIndex={currentBeatIndex}
                      chordGridData={simplifiedChordGridData}
                      isPlaying={isPlaying}
                      currentTime={currentTime}
                      segmentationData={segmentationData}
                      audioUrl={audioProcessingState.audioUrl || null}
                      bpm={analysisResults?.beatDetectionResult?.bpm || 120}
                      timeSignature={timeSignature}
                      onChordPlaybackChange={handleChordPlaybackChange}
                    />
                  </div>
                  )}

                </div>
              )}






            </div>
          </div>


        </div>
      </main>


      </div>
    </div>
  );
}
