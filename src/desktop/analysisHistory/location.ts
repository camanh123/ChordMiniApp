import path from 'path';

export const ANALYSIS_HISTORY_DIRECTORY = 'analysis-history';

/**
 * History lives under the Electron userData directory. The renderer does not
 * choose this path, and nothing in the installer tree is used as storage.
 */
export function analysisHistoryDir(userDataDir: string): string {
  if (
    typeof userDataDir !== 'string'
    || userDataDir.length === 0
    || userDataDir.includes('\0')
    || !path.isAbsolute(userDataDir)
    || userDataDir.split(/[\\/]+/).includes('..')
  ) {
    throw new Error('Analysis history requires an absolute Electron userData directory.');
  }
  return path.join(path.resolve(userDataDir), ANALYSIS_HISTORY_DIRECTORY);
}
