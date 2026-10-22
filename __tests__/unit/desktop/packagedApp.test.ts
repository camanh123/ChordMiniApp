/**
 * @jest-environment node
 */
import path from 'path';
import { acceptanceDiagnosticFile, acceptancePidFile, resolveDesktopLaunch } from '@/desktop/packagedApp';

describe('packaged desktop paths', () => {
  it('reads the standalone server from the installer resources directory', () => {
    const resourcesPath = path.join('C:', 'Program Files', 'ChordMini', 'resources');
    const plan = resolveDesktopLaunch({
      isPackaged: true,
      resourcesPath,
      repoRoot: path.join('D:', 'source', 'ChordMiniApp'),
    });

    expect(plan.prepareFromRepo).toBe(false);
    expect(plan.serverEntry.split(path.sep)).toEqual([
      ...resourcesPath.split(path.sep),
      'standalone',
      'server.js',
    ]);
  });

  it('keeps repository development on the build output', () => {
    const repoRoot = path.join('D:', 'work', 'Chord Mini');
    const plan = resolveDesktopLaunch({
      isPackaged: false,
      resourcesPath: path.join(repoRoot, 'unused'),
      repoRoot,
    });

    expect(plan.prepareFromRepo).toBe(true);
    expect(plan.serverEntry).toBe(path.join(repoRoot, '.next', 'standalone', 'server.js'));
  });

  it('writes acceptance diagnostics only when the acceptance flag and an absolute path are set', () => {
    const absolute = path.join(path.parse(process.cwd()).root, 'tmp', 'owned.pid');
    expect(acceptancePidFile({ CHORDMINI_DESKTOP_PID_FILE: absolute })).toBeNull();
    expect(acceptancePidFile({
      CHORDMINI_DESKTOP_ACCEPTANCE: '1',
      CHORDMINI_DESKTOP_PID_FILE: 'owned.pid',
    })).toBeNull();
    expect(acceptancePidFile({
      CHORDMINI_DESKTOP_ACCEPTANCE: '1',
      CHORDMINI_DESKTOP_PID_FILE: absolute,
    })).toBe(absolute);
    expect(acceptanceDiagnosticFile({
      CHORDMINI_DESKTOP_DIAGNOSTIC_FILE: absolute,
    })).toBeNull();
    expect(acceptanceDiagnosticFile({
      CHORDMINI_DESKTOP_ACCEPTANCE: '1',
      CHORDMINI_DESKTOP_DIAGNOSTIC_FILE: absolute,
    })).toBe(absolute);
  });
});
