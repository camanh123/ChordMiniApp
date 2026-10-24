/**
 * @jest-environment node
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'yaml';

const repoRoot = path.resolve(__dirname, '../../..');
const workflowPath = path.join(repoRoot, '.github/workflows/windows-integration-03.yml');
const installerWorkflowPath = path.join(repoRoot, '.github/workflows/windows-installer.yml');

describe('integration 03 Windows test workflow', () => {
  const workflow = yaml.parse(fs.readFileSync(workflowPath, 'utf8')) as {
    on: { push: { branches: string[] } };
    permissions: { contents: string };
    jobs: Record<string, { 'runs-on': string; steps: Array<{ name?: string; run?: string; env?: Record<string, string> }> }>;
  };
  const text = fs.readFileSync(workflowPath, 'utf8');
  const steps = workflow.jobs['windows-test-installer'].steps;

  it('pushes only the dedicated test branch and keeps the token read-only', () => {
    expect(workflow.on.push.branches).toEqual([
      'cursor/phase-integration-03-windows-test-installer-393f',
    ]);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs['windows-test-installer']['runs-on']).toBe('windows-latest');
    const executable = text.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
    expect(executable).not.toMatch(/pull_request_target|workflow_dispatch|secrets\./);
    expect(Object.keys(workflow.on)).toEqual(['push']);
  });

  it('reuses the installer commands and uploads the exe only after acceptance', () => {
    const names = steps.map((step) => step.name);
    const build = steps.find((step) => step.name === 'Build the unsigned NSIS installer');
    expect(build?.run).toContain('npx electron-builder --win nsis --x64 --publish never');
    expect(build?.env?.CSC_IDENTITY_AUTO_DISCOVERY).toBe(false);
    expect(names).toEqual(expect.arrayContaining([
      'Scan staged resources',
      'Scan the unpacked app',
      'List and extract the NSIS payload with 7-Zip',
      'Scan the extracted NSIS payload',
      'Install and launch the packaged app',
      'Upload the test installer',
    ]));
    expect(names.indexOf('Scan the extracted NSIS payload')).toBeLessThan(names.indexOf('Install and launch the packaged app'));
    expect(names.indexOf('Install and launch the packaged app')).toBeLessThan(names.indexOf('Upload the test installer'));
    expect(text).toContain('name: ChordMini-Windows-x64-Integration03');
    expect(text).toContain('retention-days: 14');
    expect(text).not.toContain('softprops/action-gh-release');
    const preserved = fs.readFileSync(installerWorkflowPath, 'utf8');
    expect(preserved).not.toContain('cursor/phase-integration-03-windows-test-installer-393f');
    const builder = yaml.parse(fs.readFileSync(path.join(repoRoot, 'electron-builder.yml'), 'utf8')) as {
      files: string[];
      extraResources: Array<{ filter: string[] }>;
    };
    expect(builder.files).toEqual(expect.arrayContaining([
      '!**/ffmpeg-static',
      '!**/ffmpeg-static/**',
    ]));
    expect(builder.extraResources[0].filter).toContain('!standalone/**/python_backend/**');
  });

  it('writes a summary without install paths or absolute roots', () => {
    const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'integration03-summary-'));
    const secretPath = 'C:\\Users\\PrivateOwner\\ChordMini Acceptance';
    fs.writeFileSync(path.join(artifactDir, 'packaged-report.json'), JSON.stringify({
      status: 'PASS',
      installDir: secretPath,
      checks: {
        install: { pass: true, installDir: secretPath },
        localPlayback: { pass: false, error: 'seek failed' },
      },
    }));
    fs.writeFileSync(path.join(artifactDir, 'build-metadata.json'), JSON.stringify({
      filename: 'ChordMini-Setup-0.6.5-x64.exe',
      bytes: 42,
      sha256: 'abc',
      signed: false,
      autoUpdate: false,
      pythonBundled: false,
      commit: '0a091c0a143bac0a14285126de3bb5507e5c7548',
    }));
    fs.writeFileSync(path.join(artifactDir, 'nsis-inspection.json'), JSON.stringify({
      listed: true,
      extracted: true,
      appAsarFound: true,
    }));
    fs.writeFileSync(path.join(artifactDir, 'staged-scan.json'), JSON.stringify({
      findingCount: 0,
      root: '/home/private/desktop-resources/standalone',
    }));
    fs.writeFileSync(path.join(artifactDir, 'unpacked-scan.json'), JSON.stringify({
      findingCount: 0,
      archiveCoverage: ['resources/app.asar'],
    }));
    fs.writeFileSync(path.join(artifactDir, 'nsis-payload-scan.json'), JSON.stringify({
      findingCount: 0,
      archiveCoverage: ['resources/app.asar'],
      nsisPayloadInspected: false,
    }));

    const result = spawnSync(process.execPath, [
      path.join(repoRoot, 'scripts/write-integration-03-summary.mjs'),
      artifactDir,
      '0a091c0a143bac0a14285126de3bb5507e5c7548',
    ], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    const summaryText = fs.readFileSync(path.join(artifactDir, 'acceptance-summary.json'), 'utf8');
    expect(summaryText).not.toContain('PrivateOwner');
    expect(summaryText).not.toContain('/home/private');
    const summary = JSON.parse(summaryText);
    expect(summary).toMatchObject({
      sourceSha: '0a091c0a143bac0a14285126de3bb5507e5c7548',
      installerName: 'ChordMini-Setup-0.6.5-x64.exe',
      installerBytes: 42,
      installerSha256: 'abc',
      autoUpdate: false,
      pythonBundled: false,
      acceptanceStatus: 'PASS',
      nsisListedBy7Zip: true,
      nsisExtractedBy7Zip: true,
      nsisAppAsarFound: true,
      scannerNsisFlag: false,
      checks: {
        install: 'PASS',
        localPlayback: 'FAIL',
        uninstall: 'NOT_RUN',
      },
    });
    expect(summary.unpackedArchiveCoverage).toEqual(['resources/app.asar']);
    fs.rmSync(artifactDir, { recursive: true, force: true });
  });
});
