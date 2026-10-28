import { analyzeAudioWithRateLimit } from '@/services/audio/audioAnalysisService';
import { detectBeatsWithRateLimit } from '@/services/audio/beatDetectionService';
import { recognizeChordsWithRateLimit } from '@/services/chord-analysis/chordService';
import { getAudioDurationFromFile } from '@/utils/audioDurationUtils';
import { isLocalBackend } from '@/utils/backendConfig';

jest.mock('@/utils/backendConfig', () => ({
  isLocalBackend: jest.fn(() => true),
}));

jest.mock('@/utils/audioDurationUtils', () => ({
  getAudioDurationFromFile: jest.fn(),
}));

jest.mock('@/services/storage/offloadUploadService', () => ({
  offloadUploadService: {
    uploadToOffload: jest.fn(),
    recognizeChordsFromOffloadUrl: jest.fn(),
    detectBeatsFromOffloadUrl: jest.fn(),
    deleteOffload: jest.fn(),
    getFileSizeString: jest.fn(() => '1.00MB'),
  },
}));

jest.mock('@/services/audio/beatDetectionService', () => ({
  detectBeatsFromFile: jest.fn(),
  detectBeatsWithRateLimit: jest.fn(),
}));

jest.mock('@/services/chord-analysis/chordService', () => ({
  recognizeChordsWithRateLimit: jest.fn(),
}));

jest.mock('@/utils/chordSynchronization', () => ({
  synchronizeChords: jest.fn(() => [{ chord: 'C', beatIndex: 0 }]),
  scoreDownbeatAlignment: jest.fn(() => ({ score: 1 })),
}));

jest.mock('@/workers/chordAnalysisClient', () => ({
  getChordAnalysisWorker: jest.fn(() => null),
}));

jest.mock('@/utils/debug/beatGridDebug', () => ({
  beatGridDebugLog: jest.fn(),
}));

describe('file duration gate', () => {
  const file = new File([new Uint8Array(32)], 'clip.wav', { type: 'audio/wav' });

  beforeEach(() => {
    jest.clearAllMocks();
    (isLocalBackend as jest.Mock).mockReturnValue(true);
    (detectBeatsWithRateLimit as jest.Mock).mockResolvedValue({
      success: true,
      beats: [0, 1],
      downbeats: [0],
      time_signature: 4,
    });
    (recognizeChordsWithRateLimit as jest.Mock).mockResolvedValue([
      { start: 0, end: 1, chord: 'C', confidence: 0.5 },
    ]);
  });

  it('does not analyze when duration metadata fails', async () => {
    (getAudioDurationFromFile as jest.Mock).mockRejectedValue(new Error('metadata failed'));

    await expect(analyzeAudioWithRateLimit(file, 'madmom', 'chord-cnn-lstm')).rejects.toThrow(
      /could not be read/i,
    );
    expect(detectBeatsWithRateLimit).not.toHaveBeenCalled();
    expect(recognizeChordsWithRateLimit).not.toHaveBeenCalled();
  });

  it('does not analyze a file longer than 12 minutes', async () => {
    (getAudioDurationFromFile as jest.Mock).mockResolvedValue(800);

    await expect(analyzeAudioWithRateLimit(file, 'madmom', 'chord-cnn-lstm')).rejects.toThrow(
      /12 minutes/i,
    );
    expect(detectBeatsWithRateLimit).not.toHaveBeenCalled();
    expect(recognizeChordsWithRateLimit).not.toHaveBeenCalled();
  });

  it('analyzes a short file from its own measurement', async () => {
    (getAudioDurationFromFile as jest.Mock).mockResolvedValue(30);

    await analyzeAudioWithRateLimit(file, 'madmom', 'chord-cnn-lstm');

    expect(getAudioDurationFromFile).toHaveBeenCalledWith(file);
    expect(detectBeatsWithRateLimit).toHaveBeenCalled();
    expect(recognizeChordsWithRateLimit).toHaveBeenCalled();
  });
});
