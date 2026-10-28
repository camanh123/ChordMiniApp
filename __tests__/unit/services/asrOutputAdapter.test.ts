/**
 * @jest-environment node
 *
 * Synthetic recognizer payloads. These fixtures do not measure singing
 * recognition quality and do not load a model.
 */
import fs from 'fs';
import { AnalysisHistoryError } from '@/desktop/analysisHistory';
import { validateLyricSidecarDraft } from '@/desktop/analysisHistory/lyricSidecar';
import { createAnalysisSessionController } from '@/components/analysis/localAnalysisSession';
import { acceptMeasuredTranscription } from '@/services/lyrics/offlineTranscriptionContract';
import {
  ASR_SCHEDULING,
  ASR_PROCESS_LIMITS,
  ASR_TIMEOUT_POLICY,
  asrProcessingTimeoutMs,
  createAsrJobQueue,
  type AsrJobRequest,
} from '@/services/lyrics/asrJobContract';
import {
  adaptAsrOutput,
  alignAdaptedAsrToChords,
  asrResultAppliesToSession,
  type AsrRawOutput,
} from '@/services/lyrics/asrOutputAdapter';

const CHORDS = [
  { chord: 'Am', start: 1, end: 3 },
  { chord: 'C', start: 5.5, end: 7 },
  { chord: 'G', start: 7, end: 10 },
  { chord: 'F', start: 12.5, end: 15 },
  { chord: 'Dm', start: 16, end: 19 },
];

function raw(overrides: Partial<AsrRawOutput> = {}, segments: unknown[] = []): AsrRawOutput {
  return {
    engine: 'synthetic-asr',
    modelId: 'fixture-model',
    audioDurationSeconds: 20,
    fileKey: 'file-a',
    sessionToken: 1,
    language: 'vi',
    segments,
    ...overrides,
  };
}

function line(text: string, startTime: number, endTime: number, extra: Record<string, unknown> = {}) {
  return { text, startTime, endTime, ...extra };
}

describe('synthetic multilingual ASR adapter', () => {
  it('keeps Vietnamese text and measured line times without romanizing', () => {
    const result = adaptAsrOutput(raw({}, [
      line('Em ơi Hà Nội phố', 1.25, 3.5),
    ]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transcription.lines).toEqual([
      { text: 'Em ơi Hà Nội phố', startTime: 1.25, endTime: 3.5 },
    ]);
    expect(result.language).toMatchObject({ declared: 'vi', code: 'vi', confidence: null, translated: false, romanized: false });
    expect(result.timestampsAreEstimates).toBe(true);
    expect(result.transcription.provenance).toEqual({
      engine: 'synthetic-asr',
      modelId: 'fixture-model',
      granularity: 'line',
      timestamps: 'measured',
    });
    expect(acceptMeasuredTranscription(result.transcription)).toBe(true);
  });

  it('keeps English, Chinese, Japanese, and Korean writing systems', () => {
    const samples = [
      { language: 'en', text: 'Hello from the street' },
      { language: 'zh', text: '明月几时有' },
      { language: 'ja', text: '桜の花が咲く' },
      { language: 'ko', text: '봄이 오면' },
    ];
    for (const sample of samples) {
      const result = adaptAsrOutput(raw({ language: sample.language }, [
        line(sample.text, 2, 4),
      ]));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.transcription.lines[0].text).toBe(sample.text);
      expect(result.language.code).toBe(sample.language);
      expect(result.language.translated).toBe(false);
      expect(result.language.romanized).toBe(false);
      expect(JSON.stringify(result.transcription)).not.toMatch(/pinyin|romaji|romanization/i);
    }
  });

  it('records a mixed-language song per segment and does not translate either line', () => {
    const result = adaptAsrOutput(raw({ language: 'auto' }, [
      line('桜', 1, 2, { language: 'ja', languageConfidence: 0.66 }),
      line('안녕', 3, 4, { language: 'ko' }),
      line('明月', 5, 6, { language: 'zh', languageConfidence: 0.5 }),
      line('Em ơi', 7, 8, { language: 'vi' }),
    ]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.language.code).toBe('auto');
    expect(result.segmentLanguages.map((language) => language.code)).toEqual(['ja', 'ko', 'zh', 'vi']);
    expect(result.segmentLanguages.map((language) => language.confidence)).toEqual([0.66, null, 0.5, null]);
    expect(result.segmentLanguages.every((language) => language.romanized === false && language.translated === false)).toBe(true);
    expect(result.notes).toContain('mixed-language-segments');
    expect(result.transcription.lines.map((entry) => entry.text)).toEqual(['桜', '안녕', '明月', 'Em ơi']);
  });

  it('stores automatic detection only when the payload provides a confidence', () => {
    const detected = adaptAsrOutput(raw({ language: 'automatic', languageConfidence: 0.91 }, [
      line('Hello', 1, 2),
    ]));
    expect(detected.ok).toBe(true);
    if (!detected.ok) return;
    expect(detected.language).toMatchObject({ declared: 'auto', code: 'auto', confidence: 0.91 });

    const uncertain = adaptAsrOutput(raw({ language: undefined, languageConfidence: undefined }, [
      line('Không rõ', 1, 2),
    ]));
    expect(uncertain.ok).toBe(true);
    if (!uncertain.ok) return;
    expect(uncertain.language).toMatchObject({ declared: 'uncertain', confidence: null });
  });

  it('preserves a line that has no word timestamps and does not invent them', () => {
    const result = adaptAsrOutput(raw({}, [
      line('Một câu không có từ', 4, 6),
    ]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transcription.granularity).toBe('line');
    expect(result.transcription.lines[0].words).toBeUndefined();
    expect(result.notes).toContain('missing-word-timestamps');
    expect(result.transcription.lines[0].text).toBe('Một câu không có từ');
  });

  it('keeps word times only when every word is measured', () => {
    const measured = adaptAsrOutput(raw({}, [
      line('Hello there', 1, 3, {
        words: [
          { text: 'Hello', startTime: 1, endTime: 1.8 },
          { text: 'there', startTime: 1.8, endTime: 3 },
        ],
      }),
    ]));
    expect(measured.ok).toBe(true);
    if (!measured.ok) return;
    expect(measured.transcription.granularity).toBe('word');
    expect(measured.transcription.lines[0].words).toEqual([
      { text: 'Hello', startTime: 1, endTime: 1.8 },
      { text: 'there', startTime: 1.8, endTime: 3 },
    ]);

    const partial = adaptAsrOutput(raw({}, [
      line('Hello there', 1, 3, {
        words: [
          { text: 'Hello', startTime: 1, endTime: 1.8 },
          { text: 'there', startTime: 1.2, endTime: 3 },
        ],
      }),
    ]));
    expect(partial.ok).toBe(true);
    if (!partial.ok) return;
    expect(partial.transcription.granularity).toBe('line');
    expect(partial.transcription.lines[0].words).toBeUndefined();
    expect(partial.notes).toContain('invalid-word-timestamps');

    const mixed = adaptAsrOutput(raw({ language: 'en' }, [
      line('Hello there', 1, 3, {
        words: [
          { text: 'Hello', startTime: 1, endTime: 1.8 },
          { text: 'there', startTime: 1.8, endTime: 3 },
        ],
      }),
      line('No words here', 4, 6),
    ]));
    expect(mixed.ok).toBe(true);
    if (!mixed.ok) return;
    expect(mixed.transcription.granularity).toBe('line');
    expect(mixed.transcription.lines.every((entry) => entry.words === undefined)).toBe(true);
    expect(mixed.notes).toContain('partial-word-timestamps-dropped');
  });

  it('rejects invalid, overlapping, and out-of-duration events without rewriting times', () => {
    const chords = [{ chord: 'Am', start: 0, end: 4 }];
    const result = adaptAsrOutput(raw({}, [
      line('giữ lại', 1, 2),
      line('không số', Number.NaN, 2),
      line('ngược', 4, 3),
      line('quá dài', 21, 22),
      line('chồng', 1.5, 2.5),
    ]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transcription.lines).toEqual([{ text: 'giữ lại', startTime: 1, endTime: 2 }]);
    expect(result.notes).toEqual(expect.arrayContaining(['invalid-timing', 'out-of-duration', 'overlap']));
    expect(chords).toEqual([{ chord: 'Am', start: 0, end: 4 }]);

    const touching = adaptAsrOutput(raw({}, [
      line('trước', 0, 2),
      line('sau', 2, 4),
    ]));
    expect(touching.ok).toBe(true);
    if (!touching.ok) return;
    expect(touching.transcription.lines.map((entry) => entry.text)).toEqual(['trước', 'sau']);

    const rejected = adaptAsrOutput(raw({}, [line('chỉ lỗi', 30, 31)]));
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.issue).toBe('out-of-duration');
    expect(rejected.transcription).toEqual({ ok: false, reason: 'failed', lines: [] });
    expect(acceptMeasuredTranscription(rejected.transcription)).toBe(true);
  });

  it('keeps a repeated chorus and a dense rap line, and flags an instrumental candidate', () => {
    const chorus = adaptAsrOutput(raw({}, [
      line('Lại nhớ', 1, 3),
      line('Lại nhớ', 10, 12),
      line('Lại nhớ', 16, 18),
    ]));
    expect(chorus.ok).toBe(true);
    if (!chorus.ok) return;
    expect(chorus.transcription.lines.map((entry) => entry.text)).toEqual(['Lại nhớ', 'Lại nhớ', 'Lại nhớ']);
    expect(chorus.reviews.every((review) => review.warnings.length === 0)).toBe(true);
    expect(chorus.transcription.provenance).toMatchObject({ engine: 'synthetic-asr', modelId: 'fixture-model' });

    const frequent = adaptAsrOutput(raw({ audioDurationSeconds: 80 }, Array.from({ length: 8 }, (_, index) => (
      line('Lại nhớ', index * 10, index * 10 + 2)
    ))));
    expect(frequent.ok).toBe(true);
    if (!frequent.ok) return;
    expect(frequent.transcription.lines).toHaveLength(8);
    expect(frequent.reviews.map((review) => review.warnings)).toEqual(Array.from({ length: 8 }, () => ['repeated-phrase']));

    const rap = 'đi thật nhanh qua từng nhịp không chờ một ai trên đường này';
    expect(Array.from(rap).length).toBeGreaterThan(40);
    const dense = adaptAsrOutput(raw({ language: 'vi' }, [line(rap, 1, 2)]));
    expect(dense.ok).toBe(true);
    if (!dense.ok) return;
    expect(dense.transcription.lines).toEqual([{ text: rap, startTime: 1, endTime: 2 }]);
    expect(dense.reviews[0].warnings).toEqual(['high-text-density']);
    expect(dense.transcription.provenance.timestamps).toBe('measured');

    const candidate = adaptAsrOutput(raw({ instrumental: true, language: 'en' }, [
      line('Thanks for watching', 1, 3),
    ]));
    expect(candidate.ok).toBe(true);
    if (!candidate.ok) return;
    expect(candidate.transcription.lines).toEqual([{ text: 'Thanks for watching', startTime: 1, endTime: 3 }]);
    expect(candidate.reviews[0].warnings).toContain('instrumental-hallucination-candidate');
    expect(candidate.transcription.provenance.engine).toBe('synthetic-asr');
  });

  it('returns no fabricated lyric for instrumental or silence output', () => {
    const instrumental = adaptAsrOutput(raw({ instrumental: true, vadReportedSpeech: true }, []));
    expect(instrumental.ok).toBe(false);
    if (instrumental.ok) return;
    expect(instrumental.issue).toBe('instrumental');
    expect(instrumental.transcription).toEqual({ ok: false, reason: 'instrumental', lines: [] });
    expect(instrumental.vad).toEqual({ reportedSpeech: true, provesVocals: false });

    const silence = adaptAsrOutput(raw({ silence: true, vadReportedSpeech: false }, [
      line('   ', 0, 2),
    ]));
    expect(silence.ok).toBe(false);
    if (silence.ok) return;
    expect(silence.issue).toBe('silence');
    expect(silence.transcription.lines).toEqual([]);
  });

  it('flags a tight repeated phrase and still keeps every measured line', () => {
    const repeated = adaptAsrOutput(raw({ language: 'en' }, [0, 1, 2, 3].map((index) => (
      line('Thanks for watching', index, index + 1)
    ))));
    expect(repeated.ok).toBe(true);
    if (!repeated.ok) return;
    expect(repeated.transcription.lines.map((entry) => entry.text)).toEqual([
      'Thanks for watching',
      'Thanks for watching',
      'Thanks for watching',
      'Thanks for watching',
    ]);
    expect(repeated.reviews.map((review) => review.warnings)).toEqual([
      ['repeated-phrase'],
      ['repeated-phrase'],
      ['repeated-phrase'],
      ['repeated-phrase'],
    ]);
    expect(repeated.notes).toContain('repeated-phrase');
  });

  it('keeps a low-confidence line and stores only a score the model provided', () => {
    const result = adaptAsrOutput(raw({ language: 'vi' }, [
      line('có thể', 1, 2, { confidence: 0.1 }),
      line('giữ câu này', 3, 5),
    ]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.language.confidence).toBeNull();
    expect(result.transcription.lines.map((entry) => entry.text)).toEqual(['có thể', 'giữ câu này']);
    expect(result.reviews.map((review) => review.confidence)).toEqual([0.1, null]);
    expect(result.reviews[0].warnings).toContain('low-confidence');
    expect(result.reviews[1].warnings).not.toContain('low-confidence');

    const vadOnly = adaptAsrOutput(raw({ vadReportedSpeech: false }, [
      line('vẫn còn lời', 2, 4),
    ]));
    expect(vadOnly.ok).toBe(true);
    if (!vadOnly.ok) return;
    expect(vadOnly.transcription.lines[0].text).toBe('vẫn còn lời');
    expect(vadOnly.vad.provesVocals).toBe(false);
  });

  it('ignores syllable arrays instead of turning them into word times', () => {
    const result = adaptAsrOutput(raw({}, [
      line('さくら', 1, 2, { syllables: [{ text: 'さ', startTime: 1, endTime: 1.5 }] }),
    ]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transcription.lines[0].words).toBeUndefined();
    expect(result.notes).toContain('ignored-syllable-timestamps');
    expect(JSON.stringify(result.transcription)).not.toContain('syllables');
  });

  it('does not attach file A to file B after the analysis session moves on', () => {
    const session = createAnalysisSessionController();
    const tokenA = session.start();
    const adapted = adaptAsrOutput(raw({ fileKey: 'file-a', sessionToken: tokenA }, [
      line('file A', 1, 2, { language: 'en' }),
    ]));
    const chords = [{ chord: 'C', start: 0, end: 4 }];
    const tokenB = session.start();
    expect(asrResultAppliesToSession(adapted, {
      fileKey: 'file-a',
      sessionToken: tokenA,
      isCurrent: session.isCurrent(tokenA),
    })).toBe(false);
    expect(asrResultAppliesToSession(adapted, {
      fileKey: 'file-b',
      sessionToken: tokenB,
      isCurrent: session.isCurrent(tokenB),
    })).toBe(false);
    expect(session.isCurrent(tokenB)).toBe(true);
    expect(chords).toEqual([{ chord: 'C', start: 0, end: 4 }]);
  });

  it('aligns adapted lines to chord timestamps without an LRC provenance', () => {
    const adapted = adaptAsrOutput(raw({ language: 'mixed' }, [
      line('Một câu hát', 5, 9, { language: 'vi' }),
      line('Second line', 16, 19, { language: 'en' }),
    ]));
    expect(adapted.ok).toBe(true);
    if (!adapted.ok) return;
    const chords = CHORDS.map((chord) => ({ ...chord }));
    const preview = alignAdaptedAsrToChords(adapted, chords);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.lines.map((entry) => [entry.text, entry.startTime, entry.endTime])).toEqual([
      ['Một câu hát', 5, 9],
      ['Second line', 16, 19],
    ]);
    expect(preview.lines[0].chords.map((chord) => chord.chord)).toEqual(['C', 'G']);
    expect(preview.lines[1].chords.map((chord) => chord.chord)).toEqual(['Dm']);
    expect(preview.provenance).toMatchObject({
      kind: 'asr-preview',
      persisted: false,
      sidecarSchema: null,
      recognizesAudio: true,
      timestampsAreEstimates: true,
      fileKey: 'file-a',
    });
    expect(JSON.stringify(preview.provenance)).not.toMatch(/local-lrc|lrclib/);
    expect(chords).toEqual(CHORDS);
  });

  it('refuses to store the adapted payload in lyric sidecar v1', () => {
    expect(() => validateLyricSidecarDraft({
      parentResultSha256: 'a'.repeat(64),
      source: 'asr',
      trackTitle: 'Song',
      artist: 'Artist',
      catalogDurationSeconds: null,
      audioDurationSeconds: 20,
      granularity: 'line',
      sourceOffsetSeconds: 0,
      offsetSeconds: 0,
      confirmedEdition: true,
      recognizesAudio: true,
      userModified: false,
      rows: [{ time: 1, text: 'Em ơi', words: null }],
    })).toThrow(AnalysisHistoryError);
  });
});

describe('ASR process contract', () => {
  const request: AsrJobRequest = {
    fileKey: 'file-a',
    sessionToken: 4,
    audioDurationSeconds: 20,
    language: 'vi',
  };

  it('selects sequential scheduling and documents the parallel alternative', () => {
    expect(ASR_SCHEDULING.selected).toBe('sequential');
    expect(ASR_SCHEDULING.sequential.enabled).toBe(true);
    expect(ASR_SCHEDULING.parallel.enabled).toBe(false);
    expect(ASR_PROCESS_LIMITS.audioUploadPermitted).toBe(false);
    expect(ASR_PROCESS_LIMITS.modifiesChordBeatEnvironment).toBe(false);
    expect(ASR_PROCESS_LIMITS.offlineModelLoadingOnly).toBe(true);
    expect(ASR_PROCESS_LIMITS.rssEnforced).toBe(false);
    expect(ASR_PROCESS_LIMITS.maxRssMegabytes).toBe(4096);
    const queue = createAsrJobQueue();
    expect(queue.limits.maxConcurrentJobs).toBe(1);
    expect(queue.mode).toBe('standard');
    expect(() => createAsrJobQueue({ concurrency: 3 })).toThrow(/concurrency/);
    expect(() => createAsrJobQueue({ concurrency: 2 })).toThrow(/benchmark/);
    expect(() => createAsrJobQueue({ timeoutMs: ASR_TIMEOUT_POLICY.maxProcessingMs + 1 })).toThrow(/timeout/);
  });

  it('budgets a short clip and a long file without passing the processing maximum', async () => {
    const armed: number[] = [];
    const queue = createAsrJobQueue({
      armTimeout: (timeoutMs) => {
        armed.push(timeoutMs);
        return () => {};
      },
    });
    await queue.enqueue({ ...request, audioDurationSeconds: 12 }, async () => ({ ok: true }));
    await queue.enqueue({ ...request, fileKey: 'file-long', audioDurationSeconds: 120 }, async () => ({ ok: true }));
    expect(armed).toEqual([
      asrProcessingTimeoutMs(12, 'standard'),
      asrProcessingTimeoutMs(120, 'standard'),
    ]);
    expect(asrProcessingTimeoutMs(12, 'standard')).toBe(ASR_TIMEOUT_POLICY.shortClipTimeoutMs);
    expect(asrProcessingTimeoutMs(120, 'standard')).toBe(
      ASR_TIMEOUT_POLICY.shortClipTimeoutMs + (120 - ASR_TIMEOUT_POLICY.shortClipMaxSeconds) * ASR_TIMEOUT_POLICY.longAudioMsPerSecond,
    );
    expect(asrProcessingTimeoutMs(12, 'benchmark')).toBe(
      ASR_TIMEOUT_POLICY.shortClipTimeoutMs * ASR_TIMEOUT_POLICY.benchmarkMultiplier,
    );
    expect(asrProcessingTimeoutMs(3600, 'standard')).toBe(ASR_TIMEOUT_POLICY.maxProcessingMs);
    expect(asrProcessingTimeoutMs(3600, 'benchmark')).toBe(ASR_TIMEOUT_POLICY.maxProcessingMs);
  });

  it('bounds the queue, cancels, and times out without changing chord state', async () => {
    const chords = [{ chord: 'Am', start: 1, end: 3 }];
    const held: Array<(value: { ok: true }) => void> = [];
    const queue = createAsrJobQueue<{ ok: true }>({ maxQueued: 1, timeoutMs: 50_000, armTimeout: () => () => {} });
    const worker = () => new Promise<{ ok: true }>((resolve) => {
      held.push(resolve);
    });

    const first = queue.enqueue(request, worker);
    const second = queue.enqueue({ ...request, fileKey: 'file-b' }, worker);
    const third = await queue.enqueue({ ...request, fileKey: 'file-c' }, worker);
    expect(third).toMatchObject({ status: 'rejected', reason: 'queue-full', fileKey: 'file-c' });
    expect(queue.active()).toBe(1);
    expect(queue.queued()).toBe(1);
    expect(held).toHaveLength(1);

    held[0]({ ok: true });
    await expect(first).resolves.toMatchObject({ status: 'completed', fileKey: 'file-a' });
    await Promise.resolve();
    expect(held).toHaveLength(2);
    held[1]({ ok: true });
    await expect(second).resolves.toMatchObject({ status: 'completed', fileKey: 'file-b' });
    expect(chords).toEqual([{ chord: 'Am', start: 1, end: 3 }]);

    const parallel = createAsrJobQueue<{ ok: true }>({
      concurrency: 2,
      mode: 'benchmark',
      armTimeout: () => () => {},
    });
    const parallelHeld: Array<(value: { ok: true }) => void> = [];
    const left = parallel.enqueue(request, () => new Promise((resolve) => {
      parallelHeld.push(resolve);
    }));
    const right = parallel.enqueue(request, () => new Promise((resolve) => {
      parallelHeld.push(resolve);
    }));
    await Promise.resolve();
    expect(parallel.active()).toBe(2);
    parallelHeld.forEach((release) => release({ ok: true }));
    await left;
    await right;

    const cancellable = new AbortController();
    const cancelQueue = createAsrJobQueue({ armTimeout: () => () => {} });
    let sawAbort = false;
    const cancelled = cancelQueue.enqueue({ ...request, signal: cancellable.signal }, (_job, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        sawAbort = true;
        reject(new Error('aborted'));
      });
    }));
    cancellable.abort();
    await expect(cancelled).resolves.toMatchObject({ status: 'cancelled', fileKey: 'file-a' });
    expect(sawAbort).toBe(true);

    const released: string[] = [];
    jest.useFakeTimers();
    const timed = createAsrJobQueue({
      onWorkerRelease: (_job, status) => released.push(status),
    });
    const timedOut = timed.enqueue(request, (_job, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    await Promise.resolve();
    jest.advanceTimersByTime(asrProcessingTimeoutMs(request.audioDurationSeconds, 'standard'));
    await expect(timedOut).resolves.toMatchObject({ status: 'timed-out' });
    expect(released).toEqual(['timed-out']);
    expect(timed.active()).toBe(0);
    jest.useRealTimers();
    expect(chords).toEqual([{ chord: 'Am', start: 1, end: 3 }]);
  });

  it('releases a failed worker once and cancels queued work on close', async () => {
    const released: string[] = [];
    const queue = createAsrJobQueue({
      maxQueued: 1,
      armTimeout: () => () => {},
      onWorkerRelease: (_job, status) => released.push(status),
    });
    await expect(queue.enqueue(request, async () => {
      throw new Error('recognizer failed');
    })).resolves.toMatchObject({ status: 'failed', fileKey: 'file-a' });
    expect(released).toEqual(['failed']);
    expect(queue.active()).toBe(0);

    const calls: string[] = [];
    const hanging = (_job: AsrJobRequest, signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
      calls.push('started');
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
    const first = queue.enqueue(request, hanging);
    const second = queue.enqueue({ ...request, fileKey: 'file-b' }, hanging);
    await Promise.resolve();
    expect(calls).toEqual(['started']);
    await queue.close();
    await expect(first).resolves.toMatchObject({ status: 'cancelled', fileKey: 'file-a' });
    await expect(second).resolves.toMatchObject({ status: 'cancelled', fileKey: 'file-b' });
    expect(calls).toEqual(['started']);
    expect(released).toEqual(['failed', 'cancelled']);
    expect(queue.active()).toBe(0);
    expect(queue.queued()).toBe(0);
    await expect(queue.enqueue(request, hanging)).resolves.toMatchObject({ status: 'cancelled' });
    expect(calls).toEqual(['started']);
  });

  it('rejects upload and remote model URLs before the worker runs', async () => {
    const worker = jest.fn(async () => ({ ok: true }));
    const queue = createAsrJobQueue({ armTimeout: () => () => {} });
    await expect(queue.enqueue({ ...request, uploadUrl: 'https://example.invalid/audio' }, worker)).resolves.toMatchObject({
      status: 'rejected',
      reason: 'offline-violation',
    });
    await expect(queue.enqueue({ ...request, remoteModelUrl: 'https://example.invalid/model' }, worker)).resolves.toMatchObject({
      status: 'rejected',
      reason: 'offline-violation',
    });
    await expect(queue.enqueue({ ...request, audioDurationSeconds: 3601 }, worker)).resolves.toMatchObject({
      status: 'rejected',
      reason: 'duration',
    });
    expect(worker).not.toHaveBeenCalled();
  });
});

describe('ASR adapter stays outside inference and the lyric UI', () => {
  it('does not reference a recognizer package, upload, or the analyze screen', () => {
    const sources = [
      'src/services/lyrics/asrOutputAdapter.ts',
      'src/services/lyrics/asrJobContract.ts',
    ].map((file) => fs.readFileSync(file, 'utf8')).join('\n');
    expect(sources).not.toMatch(/faster-whisper|openai-whisper|child_process|FormData/);
    expect(sources).not.toMatch(/\/api\/detect-beats|\/api\/recognize-chords|\/api\/detect-key/);
    expect(sources).not.toMatch(/\bfetch\s*\(/);
    expect(fs.readFileSync('src/app/analyze/page.tsx', 'utf8')).not.toMatch(/asrOutputAdapter|asrJobContract/);
    expect(fs.readFileSync('src/components/lyrics/LyricChordSyncPanel.tsx', 'utf8')).not.toMatch(/asrOutputAdapter|asrJobContract/);
    expect(fs.readFileSync('package.json', 'utf8')).not.toMatch(/faster-whisper|openai-whisper/i);
    expect(fs.readFileSync('python_backend/requirements.txt', 'utf8')).not.toMatch(/whisper/i);
  });
});
