/**
 * The packaged desktop process is an end-user-controlled machine.
 * It must not inherit a shared inference credential from the parent environment.
 */

const DESKTOP_INFERENCE_SECRET_KEYS = [
  'CHORDMINI_INFERENCE_SECRET',
  'NEXT_PUBLIC_CHORDMINI_INFERENCE_SECRET',
] as const;

export function omitDesktopInferenceSecret(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  for (const key of DESKTOP_INFERENCE_SECRET_KEYS) {
    delete next[key];
  }
  return next;
}
