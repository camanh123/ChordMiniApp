/**
 * Single-process admission for the hosted inference gateway.
 *
 * Counters live in this Node process. CHORDMINI_GATEWAY_ADMISSION=process and
 * CHORDMINI_GATEWAY_INSTANCES=1 are both required. REDIS_URL, or
 * WEB_CONCURRENCY other than 1, fails closed instead of pretending that
 * these counters are shared. A process restart clears every counter.
 * This is not distributed admission.
 *
 * tryAdmit is a synchronous critical section. Node runs that section on one
 * thread, so two in-flight requests cannot both pass the one-active-job gate.
 *
 * Idempotency is DESIGN_ONLY. A caller-supplied request id is not
 * authentication and is not stored. Replays count against the same quotas.
 *
 * Cancellation keeps the slot until the original admission deadline when the
 * outbound request has started and the gateway has not received the upstream
 * response. An aborted HTTP client does not prove that Flask stopped the model.
 */

import { NextResponse } from 'next/server';

export const DEFAULT_UID_PER_MINUTE = 2;
export const DEFAULT_UID_PER_DAY = 20;
export const DEFAULT_UID_ACTIVE = 1;
export const DEFAULT_GLOBAL_ACTIVE = 2;
export const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const DEFAULT_MAX_AUDIO_SECONDS = 5 * 60;
export const DEFAULT_INFERENCE_BOUND_MS = 300_000;
export const UPLOAD_FRAMING_BYTES = 16 * 1024;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const QUOTA_NOT_CONFIGURED = {
  success: false as const,
  error: 'Inference quota is not configured',
  code: 'QUOTA_NOT_CONFIGURED',
};

const UID_MINUTE_QUOTA = {
  success: false as const,
  error: 'Inference minute quota is exhausted',
  code: 'UID_MINUTE_QUOTA',
};

const UID_DAILY_QUOTA = {
  success: false as const,
  error: 'Inference daily quota is exhausted',
  code: 'UID_DAILY_QUOTA',
};

const UID_INFERENCE_ACTIVE = {
  success: false as const,
  error: 'An inference request is already active for this user',
  code: 'UID_INFERENCE_ACTIVE',
};

const GLOBAL_INFERENCE_ACTIVE = {
  success: false as const,
  error: 'Inference capacity is in use',
  code: 'GLOBAL_INFERENCE_ACTIVE',
};

const REQUEST_CANCELLED = {
  success: false as const,
  error: 'The analysis request was cancelled. The model worker was not confirmed to have stopped.',
  code: 'INFERENCE_REQUEST_CANCELLED',
};

const UPSTREAM_UNCONFIRMED = {
  success: false as const,
  error: 'The gateway lost the analysis response. The model worker was not confirmed to have stopped.',
  code: 'INFERENCE_UPSTREAM_UNCONFIRMED',
};

const BOUND_EXCEEDED = {
  success: false as const,
  error: 'The gateway stopped waiting. The model worker was not confirmed to have stopped.',
  code: 'INFERENCE_BOUND_EXCEEDED',
};

export type GatewayLimits = {
  perMinute: number;
  perDay: number;
  uidActive: number;
  globalActive: number;
  maxUploadBytes: number;
  maxDurationSeconds: number;
  boundMs: number;
};

type Reservation = {
  id: number;
  uid: string;
  released: boolean;
};

const minuteHits = new Map<string, number[]>();
const dayHits = new Map<string, number[]>();
const uidActive = new Map<string, number>();
const reservations = new Map<number, Reservation>();
const timers = new Set<ReturnType<typeof setTimeout>>();
let globalActive = 0;
let nextId = 1;
let nowFn: () => number = () => Date.now();

function positiveInt(raw: string | undefined, fallback: number, max: number): number | null {
  if (raw == null || raw.trim() === '') {
    return fallback;
  }
  if (!/^[0-9]+$/.test(raw.trim())) {
    return null;
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    return null;
  }
  return value;
}

export function readGatewayAdmissionConfig(
  env: NodeJS.ProcessEnv,
): { ok: true; limits: GatewayLimits } | { ok: false; status: 503; body: typeof QUOTA_NOT_CONFIGURED } {
  if ((env.CHORDMINI_GATEWAY_ADMISSION || '').trim() !== 'process') {
    return { ok: false, status: 503, body: QUOTA_NOT_CONFIGURED };
  }
  if ((env.CHORDMINI_GATEWAY_INSTANCES || '').trim() !== '1') {
    return { ok: false, status: 503, body: QUOTA_NOT_CONFIGURED };
  }
  if ((env.REDIS_URL || '').trim() !== '') {
    return { ok: false, status: 503, body: QUOTA_NOT_CONFIGURED };
  }
  const webConcurrency = (env.WEB_CONCURRENCY || '').trim();
  if (webConcurrency !== '' && webConcurrency !== '1') {
    return { ok: false, status: 503, body: QUOTA_NOT_CONFIGURED };
  }

  const perMinute = positiveInt(env.CHORDMINI_GATEWAY_UID_PER_MINUTE, DEFAULT_UID_PER_MINUTE, 1000);
  const perDay = positiveInt(env.CHORDMINI_GATEWAY_UID_PER_DAY, DEFAULT_UID_PER_DAY, 100_000);
  const uidLimit = positiveInt(env.CHORDMINI_GATEWAY_UID_ACTIVE, DEFAULT_UID_ACTIVE, 100);
  const globalLimit = positiveInt(env.CHORDMINI_GATEWAY_GLOBAL_ACTIVE, DEFAULT_GLOBAL_ACTIVE, 100);
  const maxUploadBytes = positiveInt(
    env.CHORDMINI_GATEWAY_MAX_UPLOAD_BYTES,
    DEFAULT_MAX_UPLOAD_BYTES,
    DEFAULT_MAX_UPLOAD_BYTES,
  );
  const maxDurationSeconds = positiveInt(
    env.CHORDMINI_GATEWAY_MAX_AUDIO_SECONDS,
    DEFAULT_MAX_AUDIO_SECONDS,
    DEFAULT_MAX_AUDIO_SECONDS,
  );
  const boundMs = positiveInt(
    env.CHORDMINI_GATEWAY_INFERENCE_BOUND_MS,
    DEFAULT_INFERENCE_BOUND_MS,
    DEFAULT_INFERENCE_BOUND_MS,
  );
  if (
    perMinute == null || perDay == null || uidLimit == null || globalLimit == null
    || maxUploadBytes == null || maxDurationSeconds == null || boundMs == null
  ) {
    return { ok: false, status: 503, body: QUOTA_NOT_CONFIGURED };
  }
  return {
    ok: true,
    limits: {
      perMinute,
      perDay,
      uidActive: uidLimit,
      globalActive: globalLimit,
      maxUploadBytes,
      maxDurationSeconds,
      boundMs,
    },
  };
}

function prune(stamps: number[], now: number, windowMs: number): number[] {
  return stamps.filter((stamp) => now - stamp < windowMs);
}

function retryAfterSeconds(stamps: number[], now: number, windowMs: number): number {
  const oldest = stamps[0] ?? now;
  return Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000));
}

export type AdmissionContext = {
  trackUpstream: <T>(work: () => Promise<T>) => Promise<T>;
};

export type AdmissionDenial = {
  ok: false;
  status: 429;
  body: { success: false; error: string; code: string };
  retryAfter?: number;
};

export type AdmissionGrant = { ok: true; id: number };

function tryAdmit(uid: string, limits: GatewayLimits, now: number): AdmissionGrant | AdmissionDenial {
  const minute = prune(minuteHits.get(uid) ?? [], now, MINUTE_MS);
  const day = prune(dayHits.get(uid) ?? [], now, DAY_MS);
  minuteHits.set(uid, minute);
  dayHits.set(uid, day);

  if ((uidActive.get(uid) ?? 0) >= limits.uidActive) {
    return { ok: false, status: 429, body: UID_INFERENCE_ACTIVE };
  }
  if (globalActive >= limits.globalActive) {
    return { ok: false, status: 429, body: GLOBAL_INFERENCE_ACTIVE };
  }
  if (minute.length >= limits.perMinute) {
    return {
      ok: false,
      status: 429,
      body: UID_MINUTE_QUOTA,
      retryAfter: retryAfterSeconds(minute, now, MINUTE_MS),
    };
  }
  if (day.length >= limits.perDay) {
    return {
      ok: false,
      status: 429,
      body: UID_DAILY_QUOTA,
      retryAfter: retryAfterSeconds(day, now, DAY_MS),
    };
  }

  minute.push(now);
  day.push(now);
  minuteHits.set(uid, minute);
  dayHits.set(uid, day);
  uidActive.set(uid, (uidActive.get(uid) ?? 0) + 1);
  globalActive += 1;
  const id = nextId;
  nextId += 1;
  reservations.set(id, { id, uid, released: false });
  return { ok: true, id };
}

function releaseReservation(id: number): void {
  const reservation = reservations.get(id);
  if (!reservation || reservation.released) {
    return;
  }
  reservation.released = true;
  reservations.delete(id);
  const next = (uidActive.get(reservation.uid) ?? 1) - 1;
  if (next <= 0) {
    uidActive.delete(reservation.uid);
  } else {
    uidActive.set(reservation.uid, next);
  }
  globalActive = Math.max(0, globalActive - 1);
}

function quotaResponse(denial: AdmissionDenial): NextResponse {
  const headers: Record<string, string> = {};
  if (denial.retryAfter != null) {
    headers['Retry-After'] = String(denial.retryAfter);
  }
  return NextResponse.json(denial.body, { status: denial.status, headers });
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any(signals);
  }
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller.signal;
}

/**
 * Run one admitted hosted inference.
 * Quota and active slots are reserved together, before the callback.
 * A returned HTTP response, including an upstream 4xx or 5xx, releases
 * the slot. A caller abort or a lost upstream connection after the outbound
 * request starts keeps the slot until the original deadline: this process
 * cannot see whether Flask is still computing. The deadline is the
 * enforceable occupancy limit, and it is not a model-interrupt confirmation.
 */
export async function withHostedAdmission(
  uid: string,
  env: NodeJS.ProcessEnv,
  incoming: AbortSignal | undefined,
  run: (signal: AbortSignal, admission: AdmissionContext) => Promise<NextResponse>,
): Promise<NextResponse> {
  const config = readGatewayAdmissionConfig(env);
  if (!config.ok) {
    return NextResponse.json(config.body, { status: config.status });
  }
  if (incoming?.aborted) {
    return NextResponse.json(REQUEST_CANCELLED, { status: 503 });
  }

  const grant = tryAdmit(uid, config.limits, nowFn());
  if (!grant.ok) {
    return quotaResponse(grant);
  }

  const deadlineAt = Date.now() + config.limits.boundMs;
  let upstreamStarted = false;
  let upstreamSettled = false;
  let released = false;
  const client = new AbortController();
  const bound = new AbortController();
  const onClientAbort = () => client.abort();
  incoming?.addEventListener('abort', onClientAbort, { once: true });
  const boundTimer = setTimeout(() => bound.abort(), config.limits.boundMs);
  timers.add(boundTimer);
  const signal = anySignal([client.signal, bound.signal]);

  const releaseOnce = () => {
    if (released) {
      return;
    }
    released = true;
    clearTimeout(boundTimer);
    timers.delete(boundTimer);
    incoming?.removeEventListener('abort', onClientAbort);
    releaseReservation(grant.id);
  };

  const holdUntilDeadline = () => {
    const wait = Math.max(0, deadlineAt - Date.now());
    clearTimeout(boundTimer);
    timers.delete(boundTimer);
    if (wait === 0) {
      releaseOnce();
      return;
    }
    const hold = setTimeout(() => {
      timers.delete(hold);
      releaseOnce();
    }, wait);
    timers.add(hold);
  };

  const admission: AdmissionContext = {
    async trackUpstream(work) {
      upstreamStarted = true;
      upstreamSettled = false;
      const value = await work();
      upstreamSettled = true;
      return value;
    },
  };

  try {
    const response = await run(signal, admission);
    releaseOnce();
    return response;
  } catch (error) {
    const clientAborted = Boolean(incoming?.aborted || client.signal.aborted);
    if (upstreamStarted && !upstreamSettled && !bound.signal.aborted) {
      holdUntilDeadline();
      if (clientAborted) {
        return NextResponse.json(REQUEST_CANCELLED, { status: 503 });
      }
      return NextResponse.json(UPSTREAM_UNCONFIRMED, { status: 502 });
    }
    releaseOnce();
    if (bound.signal.aborted) {
      return NextResponse.json(BOUND_EXCEEDED, { status: 504 });
    }
    if (clientAborted) {
      return NextResponse.json(REQUEST_CANCELLED, { status: 503 });
    }
    throw error;
  }
}

export function gatewayAdmissionSnapshot(uid?: string): { globalActive: number; uidActive: number } {
  return {
    globalActive,
    uidActive: uid ? (uidActive.get(uid) ?? 0) : 0,
  };
}

export function setGatewayClockForTests(clock: (() => number) | null): void {
  nowFn = clock ?? (() => Date.now());
}

export function resetGatewayAdmissionForTests(): void {
  for (const timer of timers) {
    clearTimeout(timer);
  }
  timers.clear();
  minuteHits.clear();
  dayHits.clear();
  uidActive.clear();
  reservations.clear();
  globalActive = 0;
  nextId = 1;
  nowFn = () => Date.now();
}

export function measureAdmissionOverhead(iterations = 1000): number {
  const limits: GatewayLimits = {
    perMinute: iterations,
    perDay: iterations,
    uidActive: iterations,
    globalActive: iterations,
    maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
    maxDurationSeconds: DEFAULT_MAX_AUDIO_SECONDS,
    boundMs: DEFAULT_INFERENCE_BOUND_MS,
  };
  const started = Date.now();
  for (let index = 0; index < iterations; index += 1) {
    const grant = tryAdmit(`overhead-${index}`, limits, 1_000_000 + index);
    if (grant.ok) {
      releaseReservation(grant.id);
    }
  }
  return Date.now() - started;
}
