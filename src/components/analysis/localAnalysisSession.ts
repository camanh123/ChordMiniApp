/**
 * Local-upload analysis identity.
 * The in-flight request is left to finish; only its UI side effects are dropped
 * when the selected audio or the component has moved on.
 */
export interface AnalysisSessionController {
  start(): number;
  invalidate(): number;
  isCurrent(token: number): boolean;
}

export function createAnalysisSessionController(): AnalysisSessionController {
  let generation = 0;
  return {
    start() {
      generation += 1;
      return generation;
    },
    invalidate() {
      generation += 1;
      return generation;
    },
    isCurrent(token: number) {
      return token === generation;
    },
  };
}

export async function runGuardedAnalysis<T>(
  session: Pick<AnalysisSessionController, 'isCurrent'>,
  token: number,
  task: Promise<T>,
  apply: (result: T) => void,
  fail: (error: unknown) => void,
): Promise<void> {
  let result: T;
  try {
    result = await task;
  } catch (error) {
    if (!session.isCurrent(token)) return;
    fail(error);
    return;
  }

  if (!session.isCurrent(token)) return;
  apply(result);
}
