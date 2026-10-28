import fs from 'fs';
import path from 'path';
import { analysisIdentity } from '@/desktop/analysisHistory/schema';
import {
  AUTHORIZED_AUDIO_MAX_BYTES,
  audioTimeForVideo,
  authorizedFileHistorySource,
  canRunAuthorizedAnalysis,
  canSynchronize,
  chordAtAudioTime,
  compareMediaDurations,
  guitarAccompanimentCapo,
  highlightChord,
  linkedResultApplies,
  presentLinkedMusicFacts,
  readPlayerDuration,
  shiftAnalysisToVideoTimeline,
  youtubeAudioExtractionAllowed,
} from '@/services/youtube/linkedAnalysisSession';
import { loadOfficialYouTubeMetadata, officialYouTubeOEmbedUrl } from '@/services/youtube/officialYouTubeMetadata';
import { extractYouTubeVideoId, parseYouTubeLink } from '@/utils/youtubeLink';
import { extractVideoId } from '@/utils/youtubeUtils';
import type { AnalysisResult } from '@/types/audioAnalysis';
import type { YouTubePlayer } from '@/types/youtube';

const VIDEO_A = 'abcdefghijk';
const VIDEO_B = 'zyxwvutsrqp';

function resultWithChord(start: number): AnalysisResult {
  return {
    chords: [{ chord: 'G', start, end: start + 2, time: start, confidence: 0.5 }],
    beats: [{ time: start, strength: 0.8, beatNum: 1 }],
    synchronizedChords: [],
    desktopHistory: {
      requestedBeat: 'madmom',
      beatReported: 'madmom',
      chordModel: 'chord-cnn-lstm',
      modelBpm: 96,
      meter: { beatsPerBar: 3, provenance: 'madmom-candidate-selection', downbeats: [start] },
      downbeats: [start],
    },
    beatDetectionResult: { bpm: 120, time_signature: 4 },
  };
}

describe('YouTube link parsing', () => {
  it('accepts watch, shorts, youtu.be, embed, and a bare id', () => {
    expect(parseYouTubeLink(`https://www.youtube.com/watch?v=${VIDEO_A}&list=PLxxxx`)).toMatchObject({ ok: true, videoId: VIDEO_A, kind: 'watch' });
    expect(parseYouTubeLink(`https://www.youtube.com/watch?v=${VIDEO_A}`)).toMatchObject({ ok: true, videoId: VIDEO_A, kind: 'watch' });
    expect(parseYouTubeLink(`https://youtube.com/shorts/${VIDEO_A}?feature=share`)).toMatchObject({ ok: true, videoId: VIDEO_A, kind: 'shorts' });
    expect(parseYouTubeLink(`https://youtu.be/${VIDEO_A}?si=abc`)).toMatchObject({ ok: true, videoId: VIDEO_A, kind: 'youtu.be' });
    expect(parseYouTubeLink(`https://www.youtube.com/embed/${VIDEO_A}`)).toMatchObject({ ok: true, kind: 'embed' });
    expect(parseYouTubeLink(VIDEO_A)).toMatchObject({ ok: true, kind: 'bare-id' });
    expect(extractVideoId(`https://youtu.be/${VIDEO_A}?si=abc`)).toBe(VIDEO_A);
    expect(extractYouTubeVideoId(`https://www.youtube.com/watch?v=${VIDEO_A}&list=PLxxxx`)).toBe(VIDEO_A);
  });

  it('rejects empty, invalid, and playlist-only links', () => {
    expect(parseYouTubeLink('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(parseYouTubeLink('https://example.com/watch?v=abcdefghijk')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseYouTubeLink('https://www.youtube.com/playlist?list=PLxxxxxxxxxxxxxxxxxxxx')).toEqual({ ok: false, reason: 'playlist-only' });
    expect(parseYouTubeLink('https://www.youtube.com/shorts/too-short')).toEqual({ ok: false, reason: 'invalid' });
    expect(extractVideoId('https://youtu.be/not-an-id')).toBeNull();
  });
});

describe('authorized YouTube-linked analysis', () => {
  it('blocks desktop extraction and allows the existing web runtime to keep its path', () => {
    expect(youtubeAudioExtractionAllowed('electron')).toBe(false);
    expect(youtubeAudioExtractionAllowed('web')).toBe(true);
    expect(youtubeAudioExtractionAllowed('pwa')).toBe(true);
  });

  it('enables analysis only for a non-empty authorized audio file', () => {
    expect(canRunAuthorizedAnalysis(null)).toBe(false);
    expect(canRunAuthorizedAnalysis({ name: 'notes.txt', sizeBytes: 20 })).toBe(false);
    expect(canRunAuthorizedAnalysis({ name: 'song.mp3', sizeBytes: 0 })).toBe(false);
    expect(canRunAuthorizedAnalysis({ name: 'song.mp3', sizeBytes: AUTHORIZED_AUDIO_MAX_BYTES + 1 })).toBe(false);
    expect(canRunAuthorizedAnalysis({ name: 'song.wav', sizeBytes: 1200 })).toBe(true);
    expect(canRunAuthorizedAnalysis({ name: 'song.aiff', sizeBytes: 1200 })).toBe(true);
    expect(canRunAuthorizedAnalysis({ name: 'song.aac', sizeBytes: 1200 })).toBe(false);
  });

  it('holds sync on an unknown duration and requires confirmation after a mismatch', () => {
    expect(compareMediaDurations(null, 180).status).toBe('unknown');
    expect(compareMediaDurations(180, 184).status).toBe('aligned');
    expect(compareMediaDurations(180, 190).status).toBe('mismatch');
    expect(canSynchronize({ alignment: 'aligned', userConfirmedSameArrangement: false })).toBe(false);
    expect(canSynchronize({ alignment: 'unknown', userConfirmedSameArrangement: true })).toBe(false);
    expect(canSynchronize({ alignment: 'mismatch', userConfirmedSameArrangement: true })).toBe(true);
  });

  it('follows playhead time, seek, and offset without mixing two videos', () => {
    const chords = [
      { chord: 'C', start: 0, end: 8 },
      { chord: 'G', start: 8, end: 16 },
    ];
    expect(chordAtAudioTime(chords, audioTimeForVideo(1, 0))?.chord).toBe('C');
    expect(chordAtAudioTime(chords, audioTimeForVideo(9, 0))?.chord).toBe('G');
    expect(highlightChord({
      chords,
      videoTimeSeconds: 9,
      offsetSeconds: 0,
      syncAllowed: true,
      videoId: VIDEO_A,
      resultVideoId: VIDEO_A,
    })?.chord).toBe('G');
    expect(highlightChord({
      chords,
      videoTimeSeconds: 9,
      offsetSeconds: -9,
      syncAllowed: true,
      videoId: VIDEO_A,
      resultVideoId: VIDEO_A,
    })?.chord).toBe('C');
    expect(highlightChord({
      chords,
      videoTimeSeconds: 9,
      offsetSeconds: 0,
      syncAllowed: false,
      videoId: VIDEO_A,
      resultVideoId: VIDEO_A,
    })).toBeNull();
    expect(highlightChord({
      chords,
      videoTimeSeconds: 9,
      offsetSeconds: 0,
      syncAllowed: true,
      videoId: VIDEO_B,
      resultVideoId: VIDEO_A,
    })).toBeNull();
    expect(linkedResultApplies({ videoId: VIDEO_A, token: 2 }, { videoId: VIDEO_A, token: 1 })).toBe(false);
  });

  it('shifts file timestamps onto the video timeline and keeps model facts', () => {
    const shifted = shiftAnalysisToVideoTimeline(resultWithChord(10), 2);
    expect(shifted.chords[0]).toMatchObject({ start: 8, end: 10, time: 8 });
    expect(shifted.beats[0].time).toBe(8);
    const facts = presentLinkedMusicFacts({
      provenance: 'authorized-file',
      chordCount: 1,
      modelBpm: 96,
      cachedBpm: null,
      displayBpm: 120,
      modelMeter: 3,
      cachedMeter: 4,
      key: 'Unknown',
      keyFromHeuristic: false,
      capoFret: null,
    });
    expect(facts.bpm).toEqual({ value: 96, provenance: 'model' });
    expect(facts.meter).toEqual({ value: '3/4', provenance: 'model' });
    expect(facts.key).toBeNull();
    expect(facts.capo).toBeNull();
  });

  it('does not turn a display default into a measured BPM or meter', () => {
    const facts = presentLinkedMusicFacts({
      provenance: 'authorized-file',
      chordCount: 4,
      modelBpm: null,
      cachedBpm: 120,
      displayBpm: 120,
      modelMeter: null,
      cachedMeter: 4,
      key: 'C major',
      keyFromHeuristic: true,
      capoFret: 2,
    });
    expect(facts.bpm).toBeNull();
    expect(facts.meter).toBeNull();
    expect(facts.key).toBeNull();
    expect(facts.capo).toEqual({
      value: 2,
      provenance: 'guitar-accompaniment-suggestion',
      detectedInRecording: false,
    });
  });

  it('labels cached numbers as cached and keeps history identity on the file hash', () => {
    const cached = presentLinkedMusicFacts({
      provenance: 'cached-annotation',
      chordCount: 2,
      modelBpm: null,
      cachedBpm: 88,
      displayBpm: null,
      modelMeter: null,
      cachedMeter: 4,
      key: 'A minor',
      keyFromHeuristic: false,
      capoFret: null,
    });
    expect(cached.provenance).toBe('cached-annotation');
    expect(cached.bpm?.provenance).toBe('cached-annotation');
    expect(cached.meter?.value).toBe('4/4');
    const source = authorizedFileHistorySource({
      displayName: 'song.mp3',
      sizeBytes: 40,
      contentSha256: 'a'.repeat(64),
    });
    const identity = analysisIdentity({
      source,
      models: { beat: 'madmom', chord: 'chord-cnn-lstm', beatReported: 'madmom' },
      resultSha256: 'b'.repeat(64),
    });
    expect(source.kind).toBe('local-audio');
    expect(identity).not.toContain(VIDEO_A);
    expect(guitarAccompanimentCapo([])).toBeNull();
  });

  it('reads a positive player duration and ignores zero', () => {
    expect(readPlayerDuration(null)).toBeNull();
    const player = {
      seekTo: () => undefined,
      playVideo: () => undefined,
      pauseVideo: () => undefined,
      setPlaybackRate: () => undefined,
      getCurrentTime: () => 3,
      muted: false,
    } as YouTubePlayer;
    expect(readPlayerDuration({ ...player, getDuration: () => 0 } as YouTubePlayer)).toBeNull();
    expect(readPlayerDuration({ ...player, getDuration: () => 212.5 } as YouTubePlayer)).toBe(212.5);
  });
});

describe('official YouTube metadata', () => {
  it('builds a fixed oEmbed URL and does not fetch media', async () => {
    const url = officialYouTubeOEmbedUrl(VIDEO_A);
    expect(url).toBe(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${VIDEO_A}`)}&format=json`);
    expect(officialYouTubeOEmbedUrl('short')).toBeNull();
    const seen: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          title: 'Public title',
          author_name: 'Channel',
          thumbnail_url: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg',
        }),
      } as Response;
    }) as typeof fetch;
    const loaded = await loadOfficialYouTubeMetadata(VIDEO_A, fetchImpl);
    expect(loaded.ok ? loaded.metadata : null).toMatchObject({
      title: 'Public title',
      author: 'Channel',
      durationSeconds: null,
      source: 'youtube-oembed',
    });
    expect(seen).toEqual([url]);
    expect(seen.join(' ')).not.toContain('extract');
  });
});

describe('YouTube desktop source boundaries', () => {
  const root = process.cwd();
  const files = [
    'src/services/youtube/linkedAnalysisSession.ts',
    'src/services/youtube/officialYouTubeMetadata.ts',
    'src/app/api/youtube/official-metadata/route.ts',
    'src/hooks/youtube/useAuthorizedYouTubeFile.ts',
    'src/components/analysis/YouTubeAuthorizedSourcePanel.tsx',
    'src/hooks/analyze/useAnalyzePageOrchestrator.ts',
  ];

  it('does not extend unofficial extraction', () => {
    const source = files.map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
    expect(source).not.toMatch(/yt-dlp|ytdlp|ffmpeg|pyodide|extract-audio/i);
    expect(fs.readFileSync(path.join(root, 'src/hooks/analyze/useAnalyzePageOrchestrator.ts'), 'utf8'))
      .toContain('youtubeAudioExtractionAllowed');
  });
});
