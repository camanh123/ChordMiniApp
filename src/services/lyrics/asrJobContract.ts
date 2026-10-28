/**
 * Process and queue contract for a future Windows CPU ASR engine.
 *
 * This module does not spawn a process, load a model, modify the chord or
 * beat Python environment, or transmit audio. A host may later run the worker
 * in a separate process. The queue below only schedules an injected worker.
 *
 * Scheduling:
 * - sequential: one job at a time. This is the product default.
 * - parallel: concurrency 2, and only when the queue is created in benchmark
 *   mode. Concurrency above 2 is refused.
 *
 * Timeout follows audio duration. Short clips use a fixed budget. Longer
 * audio adds time per second and then stops at maxProcessingMs. Benchmark
 * mode may multiply the budget and still cannot pass that maximum.
 * maxRssMegabytes is a planning note. rssEnforced is false, so this queue
 * does not measure or limit process memory.
 *
 * Every started worker is released exactly once on completion, failure,
 * cancellation, timeout, or close. A job that never started has no worker
 * to release. Close aborts started work and cancels jobs still waiting.
 */

import type { AsrLanguageCode } from '@/services/lyrics/asrOutputAdapter';

export const ASR_TIMEOUT_POLICY = {
  shortClipMaxSeconds: 30,
  shortClipTimeoutMs: 30_000,
  longAudioMsPerSecond: 2_000,
  maxProcessingMs: 15 * 60_000,
  benchmarkMultiplier: 2,
} as const;

export type AsrQueueMode = 'standard' | 'benchmark';

/**
 * Processing budget for one audio duration. The result is never above
 * maxProcessingMs. This is a scheduling bound, not a measurement of a model.
 */
export function asrProcessingTimeoutMs(audioDurationSeconds: number, mode: AsrQueueMode = 'standard'): number {
  const policy = ASR_TIMEOUT_POLICY;
  const base = audioDurationSeconds <= policy.shortClipMaxSeconds
    ? policy.shortClipTimeoutMs
    : policy.shortClipTimeoutMs + (audioDurationSeconds - policy.shortClipMaxSeconds) * policy.longAudioMsPerSecond;
  const scaled = mode === 'benchmark' ? base * policy.benchmarkMultiplier : base;
  return Math.min(policy.maxProcessingMs, scaled);
}

export const ASR_PROCESS_LIMITS = {
  maxConcurrentJobs: 1,
  maxBenchmarkConcurrency: 2,
  maxQueuedJobs: 2,
  maxAudioDurationSeconds: 3600,
  /** Planning ceiling only. The queue does not read or enforce process memory. */
  maxRssMegabytes: 4096,
  rssEnforced: false,
  offlineModelLoadingOnly: true,
  audioUploadPermitted: false,
  modifiesChordBeatEnvironment: false,
} as const;

export const ASR_SCHEDULING = {
  selected: 'sequential',
  sequential: {
    concurrency: 1,
    enabled: true,
    note: 'One Windows CPU job at a time. Use this until a benchmark measures wall time and memory.',
  },
  parallel: {
    concurrency: null,
    enabled: false,
    note: 'Benchmark experiments may create a queue with mode benchmark and concurrency 2. The product default stays sequential.',
  },
} as const;

export interface AsrJobRequest {
  fileKey: string;
  sessionToken: number;
  audioDurationSeconds: number;
  language: AsrLanguageCode | null;
  signal?: AbortSignal;
  /** Non-empty values are an offline-contract violation and are rejected. */
  uploadUrl?: string;
  remoteModelUrl?: string;
}

export type AsrJobStatus = 'completed' | 'cancelled' | 'timed-out' | 'failed';

export type AsrJobSettlement<T> =
  | { status: 'completed'; fileKey: string; sessionToken: number; output: T }
  | { status: 'cancelled'; fileKey: string; sessionToken: number }
  | { status: 'timed-out'; fileKey: string; sessionToken: number }
  | { status: 'failed'; fileKey: string; sessionToken: number }
  | {
      status: 'rejected';
      fileKey: string;
      sessionToken: number;
      reason: 'queue-full' | 'duration' | 'offline-violation';
    };

export type AsrWorker<T> = (request: AsrJobRequest, signal: AbortSignal) => Promise<T>;

export type AsrTimeoutArm = (
  timeoutMs: number,
  signal: AbortSignal,
  settle: (kind: 'timeout') => void,
) => () => void;

export interface AsrJobQueueOptions {
  concurrency?: number;
  maxQueued?: number;
  /**
   * Replaces the duration budget for every job. Still cannot exceed
   * ASR_TIMEOUT_POLICY.maxProcessingMs.
   */
  timeoutMs?: number;
  mode?: AsrQueueMode;
  armTimeout?: AsrTimeoutArm;
  /** Called once for each worker that actually started. */
  onWorkerRelease?: (request: AsrJobRequest, status: AsrJobStatus) => void;
}

function defaultArmTimeout(timeoutMs: number, signal: AbortSignal, settle: (kind: 'timeout') => void): () => void {
  const timer = setTimeout(() => settle('timeout'), timeoutMs);
  const disarm = () => clearTimeout(timer);
  if (signal.aborted) {
    disarm();
    return () => {};
  }
  signal.addEventListener('abort', disarm, { once: true });
  return () => {
    disarm();
    signal.removeEventListener('abort', disarm);
  };
}

function violation(request: AsrJobRequest): AsrJobSettlement<never> | null {
  if (
    (typeof request.uploadUrl === 'string' && request.uploadUrl.length > 0)
    || (typeof request.remoteModelUrl === 'string' && request.remoteModelUrl.length > 0)
  ) {
    return {
      status: 'rejected',
      fileKey: request.fileKey,
      sessionToken: request.sessionToken,
      reason: 'offline-violation',
    };
  }
  if (
    !Number.isFinite(request.audioDurationSeconds)
    || request.audioDurationSeconds <= 0
    || request.audioDurationSeconds > ASR_PROCESS_LIMITS.maxAudioDurationSeconds
  ) {
    return {
      status: 'rejected',
      fileKey: request.fileKey,
      sessionToken: request.sessionToken,
      reason: 'duration',
    };
  }
  return null;
}

interface RunningJob<T> {
  promise: Promise<AsrJobSettlement<T>>;
  release: () => void;
}

function runOne<T>(
  request: AsrJobRequest,
  worker: AsrWorker<T>,
  timeoutMs: number,
  armTimeout: AsrTimeoutArm,
  onWorkerRelease: AsrJobQueueOptions['onWorkerRelease'],
): RunningJob<T> {
  const identity = { fileKey: request.fileKey, sessionToken: request.sessionToken };
  const controller = new AbortController();
  let timedOut = false;
  let settled = false;
  let notified = false;
  const onParentAbort = () => controller.abort();
  if (request.signal) {
    if (request.signal.aborted) controller.abort();
    else request.signal.addEventListener('abort', onParentAbort, { once: true });
  }
  const disarm = armTimeout(timeoutMs, controller.signal, () => {
    timedOut = true;
    controller.abort();
  });

  const detach = () => {
    disarm();
    request.signal?.removeEventListener('abort', onParentAbort);
  };

  if (controller.signal.aborted) {
    detach();
    return {
      promise: Promise.resolve({ status: timedOut ? 'timed-out' : 'cancelled', ...identity }),
      release: () => {},
    };
  }

  let release = () => {};
  const promise = new Promise<AsrJobSettlement<T>>((resolve) => {
    const finish = (settlement: AsrJobSettlement<T>) => {
      if (settled) return;
      settled = true;
      detach();
      if (!notified && settlement.status !== 'rejected') {
        notified = true;
        onWorkerRelease?.(request, settlement.status);
      }
      if (!controller.signal.aborted) controller.abort();
      resolve(settlement);
    };
    release = () => finish({ status: 'cancelled', ...identity });
    controller.signal.addEventListener('abort', () => {
      if (settled) return;
      finish({ status: timedOut ? 'timed-out' : 'cancelled', ...identity });
    });
    worker(request, controller.signal).then(
      (output) => {
        if (settled || timedOut || controller.signal.aborted) {
          if (!settled) finish({ status: timedOut ? 'timed-out' : 'cancelled', ...identity });
          return;
        }
        finish({ status: 'completed', ...identity, output });
      },
      () => {
        if (settled) return;
        if (timedOut) finish({ status: 'timed-out', ...identity });
        else if (request.signal?.aborted || controller.signal.aborted) finish({ status: 'cancelled', ...identity });
        else finish({ status: 'failed', ...identity });
      },
    );
  });
  return { promise, release };
}

export function createAsrJobQueue<T>(options: AsrJobQueueOptions = {}) {
  const mode = options.mode ?? 'standard';
  const concurrency = options.concurrency ?? ASR_PROCESS_LIMITS.maxConcurrentJobs;
  const maxQueued = options.maxQueued ?? ASR_PROCESS_LIMITS.maxQueuedJobs;
  const armTimeout = options.armTimeout ?? defaultArmTimeout;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > ASR_PROCESS_LIMITS.maxBenchmarkConcurrency) {
    throw new Error('ASR concurrency is outside the contract limit.');
  }
  if (concurrency > 1 && mode !== 'benchmark') {
    throw new Error('ASR concurrency above 1 is limited to benchmark mode.');
  }
  if (!Number.isInteger(maxQueued) || maxQueued < 0 || maxQueued > ASR_PROCESS_LIMITS.maxQueuedJobs) {
    throw new Error('ASR queue length is outside the contract limit.');
  }
  if (
    options.timeoutMs !== undefined
    && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > ASR_TIMEOUT_POLICY.maxProcessingMs)
  ) {
    throw new Error('ASR timeout is outside the contract limit.');
  }

  let active = 0;
  let closed = false;
  const waiting: Array<{ start: () => void; cancel: () => void }> = [];
  const running: RunningJob<T>[] = [];

  function timeoutFor(request: AsrJobRequest): number {
    if (options.timeoutMs !== undefined) return options.timeoutMs;
    return asrProcessingTimeoutMs(request.audioDurationSeconds, mode);
  }

  function start(request: AsrJobRequest, worker: AsrWorker<T>): Promise<AsrJobSettlement<T>> {
    active += 1;
    const job = runOne(request, worker, timeoutFor(request), armTimeout, options.onWorkerRelease);
    running.push(job);
    return job.promise.finally(() => {
      active -= 1;
      const index = running.indexOf(job);
      if (index >= 0) running.splice(index, 1);
      waiting.shift()?.start();
    });
  }

  return {
    limits: ASR_PROCESS_LIMITS,
    scheduling: ASR_SCHEDULING,
    mode,
    active: () => active,
    queued: () => waiting.length,
    enqueue(request: AsrJobRequest, worker: AsrWorker<T>): Promise<AsrJobSettlement<T>> {
      if (closed) {
        return Promise.resolve({
          status: 'cancelled',
          fileKey: request.fileKey,
          sessionToken: request.sessionToken,
        });
      }
      const blocked = violation(request);
      if (blocked) return Promise.resolve(blocked);
      if (active >= concurrency) {
        if (waiting.length >= maxQueued) {
          return Promise.resolve({
            status: 'rejected',
            fileKey: request.fileKey,
            sessionToken: request.sessionToken,
            reason: 'queue-full',
          });
        }
        return new Promise((resolve) => {
          const waiter = {
            start: () => {
              start(request, worker).then(resolve, () => resolve({
                status: 'failed',
                fileKey: request.fileKey,
                sessionToken: request.sessionToken,
              }));
            },
            cancel: () => resolve({
              status: 'cancelled',
              fileKey: request.fileKey,
              sessionToken: request.sessionToken,
            }),
          };
          waiting.push(waiter);
        });
      }
      return start(request, worker);
    },
    async close(): Promise<void> {
      closed = true;
      const queued = waiting.splice(0);
      for (const waiter of queued) waiter.cancel();
      const stopping = running.splice(0);
      for (const job of stopping) job.release();
      await Promise.all(stopping.map((job) => job.promise));
    },
  };
}
