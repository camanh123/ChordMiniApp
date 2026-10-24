/**
 * Desktop practice notice derived only from the loopback decision.
 * This module does not open a socket, read a secret, or return a URL.
 * An explicit http://127.0.0.1 origin stays "requirement". Every other
 * desktop URL, including an unset value, is "not_configured".
 */

import { decideDesktopLoopback } from '@/server/desktopLoopback';

export const PRACTICE_INFERENCE_NOTICES = ['requirement', 'not_configured'] as const;

export type PracticeInferenceNotice = (typeof PRACTICE_INFERENCE_NOTICES)[number];

export function practiceInferenceNotice(
  env: NodeJS.ProcessEnv = process.env,
): PracticeInferenceNotice {
  const decision = decideDesktopLoopback(env);
  if (decision.scope === 'rejected') {
    return 'not_configured';
  }
  return 'requirement';
}
