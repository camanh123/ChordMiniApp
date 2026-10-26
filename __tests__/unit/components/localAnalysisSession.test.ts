/**
 * @jest-environment node
 */
import fs from 'fs';
import path from 'path';
import {
  createAnalysisSessionController,
  runGuardedAnalysis,
} from '@/components/analysis/localAnalysisSession';

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('local analysis session', () => {
  it('applies success and error only for the active token', async () => {
    const session = createAnalysisSessionController();
    const success = deferred<string>();
    const failure = deferred<string>();
    const applied: string[] = [];
    const errors: string[] = [];

    const successToken = session.start();
    const successTask = runGuardedAnalysis(
      session,
      successToken,
      success.promise,
      (value) => applied.push(value),
      () => errors.push('success-path'),
    );
    success.resolve('ok');
    await successTask;

    const errorToken = session.start();
    const errorTask = runGuardedAnalysis(
      session,
      errorToken,
      failure.promise,
      () => applied.push('unexpected'),
      (error) => errors.push(error instanceof Error ? error.message : 'bad'),
    );
    failure.reject(new Error('analysis failed'));
    await errorTask;

    expect(applied).toEqual(['ok']);
    expect(errors).toEqual(['analysis failed']);
  });

  it('drops a late success from audio A after the selection changes to audio B', async () => {
    const session = createAnalysisSessionController();
    const audioA = deferred<string>();
    const audioB = deferred<string>();
    const applied: string[] = [];

    const tokenA = session.start();
    const taskA = runGuardedAnalysis(
      session,
      tokenA,
      audioA.promise,
      (value) => applied.push(value),
      () => applied.push('error-A'),
    );

    session.invalidate();
    const tokenB = session.start();
    const taskB = runGuardedAnalysis(
      session,
      tokenB,
      audioB.promise,
      (value) => applied.push(value),
      () => applied.push('error-B'),
    );

    audioA.resolve('chords-A');
    audioB.resolve('chords-B');
    await Promise.all([taskA, taskB]);

    expect(session.isCurrent(tokenA)).toBe(false);
    expect(session.isCurrent(tokenB)).toBe(true);
    expect(applied).toEqual(['chords-B']);
  });

  it('drops a late success and a late error when the file is cleared', async () => {
    const session = createAnalysisSessionController();
    const success = deferred<string>();
    const failure = deferred<string>();
    const events: string[] = [];

    const successToken = session.start();
    const successTask = runGuardedAnalysis(
      session,
      successToken,
      success.promise,
      () => events.push('success'),
      () => events.push('error'),
    );
    session.invalidate();
    success.resolve('chords-A');
    await successTask;

    const errorToken = session.start();
    const errorTask = runGuardedAnalysis(
      session,
      errorToken,
      failure.promise,
      () => events.push('success'),
      () => events.push('error'),
    );
    session.invalidate();
    failure.reject(new Error('failed'));
    await errorTask;

    expect(events).toEqual([]);
  });

  it('drops a late result when the session is invalidated on unmount', async () => {
    const session = createAnalysisSessionController();
    const pending = deferred<string>();
    const events: string[] = [];
    const token = session.start();
    const task = runGuardedAnalysis(
      session,
      token,
      pending.promise,
      () => events.push('success'),
      () => events.push('error'),
    );

    session.invalidate();
    pending.resolve('chords-A');
    await task;

    expect(events).toEqual([]);
  });

  it('keeps only the latest token when analysis is started again', async () => {
    const session = createAnalysisSessionController();
    const first = deferred<string>();
    const second = deferred<string>();
    const applied: string[] = [];

    const firstToken = session.start();
    const firstTask = runGuardedAnalysis(
      session,
      firstToken,
      first.promise,
      (value) => applied.push(value),
      () => applied.push('error-1'),
    );
    const secondToken = session.start();
    const secondTask = runGuardedAnalysis(
      session,
      secondToken,
      second.promise,
      (value) => applied.push(value),
      () => applied.push('error-2'),
    );

    first.resolve('first');
    second.resolve('second');
    await Promise.all([firstTask, secondTask]);

    expect(applied).toEqual(['second']);
  });

  it('wires the upload page so a stale request cannot commit results', () => {
    const page = fs.readFileSync(
      path.join(path.resolve(__dirname, '../../..'), 'src/app/analyze/page.tsx'),
      'utf8',
    );
    expect(page).toContain('runGuardedAnalysis(');
    expect(page).toContain('analyzeAudioWithRateLimit(audioFile, beatDetector, chordDetector)');
    expect(page).toContain('analysisSessionRef.current.invalidate()');
    expect(page).toContain('session.invalidate()');
    expect(page).toContain('if (!session.isCurrent(token)) return;');
    expect(page).toContain('analysisSessionId={analysisSessionId}');
    const completeAt = page.indexOf("setStage('complete')");
    const guardedAt = page.indexOf('runGuardedAnalysis(');
    expect(guardedAt).toBeGreaterThan(-1);
    expect(completeAt).toBeGreaterThan(guardedAt);
  });
});