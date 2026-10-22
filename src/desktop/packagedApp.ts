import path from 'path';

export interface DesktopLaunchPlan {
  serverEntry: string;
  prepareFromRepo: boolean;
}

/**
 * Dev builds prepare the standalone folder inside the repository.
 * Packaged builds read the snapshot electron-builder placed in resources/standalone.
 * The server path is always an absolute path so installation directories with spaces
 * stay a single spawn argument.
 */
export function resolveDesktopLaunch(input: {
  isPackaged: boolean;
  resourcesPath: string;
  repoRoot: string;
}): DesktopLaunchPlan {
  if (input.isPackaged) {
    return {
      serverEntry: path.join(input.resourcesPath, 'standalone', 'server.js'),
      prepareFromRepo: false,
    };
  }

  return {
    serverEntry: path.join(input.repoRoot, '.next', 'standalone', 'server.js'),
    prepareFromRepo: true,
  };
}

export function isDesktopAcceptance(env: NodeJS.ProcessEnv): boolean {
  return env.CHORDMINI_DESKTOP_ACCEPTANCE === '1';
}

/**
 * The PID file is an acceptance diagnostic. A normal install never sets the
 * acceptance flag, so a stray CHORDMINI_DESKTOP_PID_FILE value does not write
 * anything. Relative paths are rejected so the hook cannot depend on the
 * process working directory.
 */
export function acceptancePidFile(env: NodeJS.ProcessEnv): string | null {
  if (!isDesktopAcceptance(env)) {
    return null;
  }
  const file = env.CHORDMINI_DESKTOP_PID_FILE;
  if (!file || !path.isAbsolute(file)) {
    return null;
  }
  return file;
}

export function acceptanceDiagnosticFile(env: NodeJS.ProcessEnv): string | null {
  if (!isDesktopAcceptance(env)) {
    return null;
  }
  const file = env.CHORDMINI_DESKTOP_DIAGNOSTIC_FILE;
  if (!file || !path.isAbsolute(file)) {
    return null;
  }
  return file;
}
