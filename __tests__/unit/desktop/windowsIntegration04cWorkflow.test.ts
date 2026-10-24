/**
 * @jest-environment node
 */
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';

const workflowPath = path.join(__dirname, '../../../.github/workflows/windows-integration-04c.yml');

describe('integration 04C Windows test workflow', () => {
  const text = fs.readFileSync(workflowPath, 'utf8');
  const workflow = yaml.parse(text) as {
    on: { push: { branches: string[] } };
    permissions: { contents: string };
    jobs: Record<string, { 'runs-on': string; steps: Array<{ name?: string; run?: string }> }>;
  };

  it('pushes only this test branch and keeps the 03 workflow untouched', () => {
    expect(workflow.on.push.branches).toEqual([
      'cursor/phase-integration-04c-windows-ai-connection-393f',
    ]);
    expect(Object.keys(workflow.on)).toEqual(['push']);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs['windows-test-installer']['runs-on']).toBe('windows-latest');
    const executable = text.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
    expect(executable).not.toMatch(/pull_request_target|workflow_dispatch|secrets\./);
    expect(text).toContain('name: ChordMini-Windows-x64-Integration04C');
    expect(text).toContain('8b3abf94ff4a69ae84b7d06707af2e3fcef8d003');
    expect(text).not.toContain('softprops/action-gh-release');
    const preserved = fs.readFileSync(
      path.join(__dirname, '../../../.github/workflows/windows-integration-03.yml'),
      'utf8',
    );
    expect(preserved).toContain('cursor/phase-integration-03-windows-test-installer-393f');
    expect(preserved).toContain('name: ChordMini-Windows-x64-Integration03');
    expect(preserved).not.toContain('cursor/phase-integration-04c-windows-ai-connection-393f');
  });
});
