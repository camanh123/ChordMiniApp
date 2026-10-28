'use client';

import type { ReactNode } from 'react';
import LocalAudioSourceHint from '@/components/analysis/LocalAudioSourceHint';
import MicrophoneSourceNotice from '@/components/analysis/MicrophoneSourceNotice';
import SoundCloudSourcePanel from '@/components/analysis/SoundCloudSourcePanel';
import YouTubeSourceDraft from '@/components/analysis/YouTubeSourceDraft';
import { useAnalysisInputSource } from '@/stores/analysisInputSourceStore';

export default function AnalysisSourceDetail({
  context,
  localPractice = null,
  youtube = null,
  onAnalyzeRecording,
}: {
  context: 'input' | 'results';
  localPractice?: ReactNode;
  youtube?: ReactNode;
  onAnalyzeRecording?: (file: File) => void;
}) {
  const source = useAnalysisInputSource();
  if (source === 'youtube') {
    if (youtube) return <>{youtube}</>;
    if (context === 'results') return null;
    return <YouTubeSourceDraft />;
  }
  if (source === 'soundcloud') return <SoundCloudSourcePanel compact={context === 'results'} />;
  if (source === 'local-audio') {
    if (localPractice) return <>{localPractice}</>;
    return <LocalAudioSourceHint />;
  }
  return <MicrophoneSourceNotice onAnalyze={onAnalyzeRecording} />;
}
