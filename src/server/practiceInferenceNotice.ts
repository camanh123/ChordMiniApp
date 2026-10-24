/**
 * Desktop practice notice derived only from environment classification.
 * This module does not open a socket, read a secret, or return a URL.
 * A loopback default and a remote URL both stay "requirement": availability
 * is not claimed unless the configuration itself is invalid.
 */

import { classifyPythonBackend } from '@/runtime/backendConnectivity';

export const PRACTICE_INFERENCE_NOTICES = ['requirement', 'not_configured'] as const;

export type PracticeInferenceNotice = (typeof PRACTICE_INFERENCE_NOTICES)[number];

export function practiceInferenceNotice(
  env: NodeJS.ProcessEnv = process.env,
): PracticeInferenceNotice {
  if (env.CHORDMINI_DESKTOP_MODE !== '1') {
    return 'requirement';
  }

  const classification = classifyPythonBackend(env);
  if (classification.deploymentClass === 'invalid') {
    return 'not_configured';
  }

  return 'requirement';
}
