/**
 * @jest-environment node
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'yaml';

const repoRoot = path.resolve(__dirname, '../../..');
const recordScript = path.join(repoRoot, 'scripts/record-unpacked-windows-build.mjs');
const workflowPath = path.join(repoRoot, '.github/workflows/windows-manual-build-01.yml');

function writeRuntimeTree(root: string, options: { buildId?: string; includeNext?: boolean } = {}) {
  const standalone = path.join(root, 'resources', 'standalone');
  fs.mkdirSync(standalone, { recursive: true });
  fs.writeFileSync(path.join(root, 'ChordMini.exe'), 'exe');
  fs.writeFileSync(path.join(standalone, 'server.js'), 'server');
  fs.mkdirSync(path.join(standalone, 'public'), { recursive: true });
  fs.writeFileSync(path.join(standalone, 'public', 'chordMiniLogo.webp'), 'logo');
  if (options.includeNext === false) return;
  const nextDir = path.join(standalone, '.next');
  fs.mkdirSync(path.join(nextDir, 'server'), { recursive: true });
  fs.mkdirSync(path.join(nextDir, 'static'), { recursive: true });
  fs.writeFileSync(path.join(nextDir, 'BUILD_ID'), options.buildId ?? 'build-id');
  fs.writeFileSync(path.join(nextDir, 'routes-manifest.json'), '{}');
  fs.writeFileSync(path.join(nextDir, 'prerender-manifest.json'), '{}');
  fs.writeFileSync(path.join(nextDir, 'server', 'app.js'), 'server');
  fs.writeFileSync(path.join(nextDir, 'static', 'app.js'), 'static');
}

function runRecord(unpackedDir: string) {
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chordmini-unpacked-report-'));
  const result = spawnSync(process.execPath, [recordScript], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      CHORDMINI_UNPACKED_DIR: unpackedDir,
      CHORDMINI_UNPACKED_REPORT_DIR: reportDir,
    },
  });
  return { ...result, reportDir };
}

describe('unpacked Next production runtime', () => {
  it('rejects the uploaded layout that has server.js and no .next', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chordmini-unpacked-'));
    writeRuntimeTree(root, { includeNext: false });
    const result = runRecord(root);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('resources/standalone/.next/BUILD_ID is missing');
    expect(fs.existsSync(path.join(result.reportDir, 'SHA256SUMS.txt'))).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(result.reportDir, { recursive: true, force: true });
  });

  it('rejects an empty BUILD_ID in the final unpacked tree', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chordmini-unpacked-'));
    writeRuntimeTree(root, { buildId: '' });
    const result = runRecord(root);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('resources/standalone/.next/BUILD_ID is empty');
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(result.reportDir, { recursive: true, force: true });
  });

  it('accepts production files only from the unpacked resources tree', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chordmini-unpacked-'));
    writeRuntimeTree(root);
    const staged = path.join(root, 'desktop-resources', 'standalone');
    fs.mkdirSync(path.join(staged, '.next'), { recursive: true });
    fs.writeFileSync(path.join(staged, 'server.js'), 'staged');
    const result = runRecord(root);
    expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
    const report = fs.readFileSync(path.join(result.reportDir, 'standalone-runtime.txt'), 'utf8');
    expect(report).toContain('nonempty-file\tresources/standalone/.next/BUILD_ID\tpresent');
    expect(report).toContain('nonempty-dir\tresources/standalone/.next/server\tpresent');
    expect(report).toContain('nonempty-dir\tresources/standalone/.next/static\tpresent');
    expect(report).toContain('file\tresources/standalone/public/chordMiniLogo.webp\tpresent');
    expect(result.stdout).toContain(`UNPACKED_DIR=${root}`);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(result.reportDir, { recursive: true, force: true });
  });
});

describe('windows manual unpacked workflow', () => {
  const workflow = yaml.parse(fs.readFileSync(workflowPath, 'utf8')) as {
    on: { push: { branches: string[] } };
    permissions: { contents: string; actions: string };
    jobs: Record<string, {
      needs?: string;
      'runs-on': string;
      steps: Array<{ name?: string; run?: string; with?: Record<string, unknown> }>;
    }>;
  };

  it('keeps one unpacked Windows build and uploads hidden Next files', () => {
    expect(workflow.on.push.branches).toEqual(['cursor/windows-manual-build-01-393f']);
    expect(Object.keys(workflow.on)).toEqual(['push']);
    expect(workflow.permissions).toEqual({ contents: 'read', actions: 'read' });
    expect(workflow.jobs['windows-unpacked']['runs-on']).toBe('windows-latest');
    const packageStep = workflow.jobs['windows-unpacked'].steps.find((step) => step.name === 'Package the unpacked Windows app');
    expect(packageStep?.run).toContain('npx electron-builder --win dir --x64 --publish never');
    expect(packageStep?.run).not.toContain('nsis');
    const names = workflow.jobs['windows-unpacked'].steps.map((step) => step.name);
    expect(names.indexOf('Reject installers and record package evidence')).toBeLessThan(names.indexOf('Upload unpacked Windows app'));
    const upload = workflow.jobs['windows-unpacked'].steps.find((step) => step.name === 'Upload unpacked Windows app');
    expect(upload?.with).toMatchObject({
      name: 'ChordMini-Windows-x64-unpacked',
      path: 'desktop-dist/win-unpacked',
      'include-hidden-files': true,
    });
    const verify = workflow.jobs['verify-uploaded-artifact'];
    expect(verify.needs).toBe('windows-unpacked');
    expect(verify['runs-on']).toBe('ubuntu-latest');
    expect(verify.steps.find((step) => step.name === 'Download the unpacked app')?.with).toMatchObject({
      name: 'ChordMini-Windows-x64-unpacked',
      path: 'uploaded-win-unpacked',
    });
    expect(verify.steps.find((step) => step.name === 'Require production runtime files in the uploaded app')?.run)
      .toBe('node scripts/record-unpacked-windows-build.mjs');
    const text = fs.readFileSync(workflowPath, 'utf8');
    expect(text).not.toMatch(/workflow_dispatch|softprops\/action-gh-release|--win nsis/);
  });
});
