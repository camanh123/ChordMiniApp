/**
 * @jest-environment node
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { prepareStandalone, STANDALONE_ASSET_PLAN, STANDALONE_EXCLUDED } from '@/desktop/prepareStandalone';

describe('standalone asset preparation', () => {
  it('copies public and static assets and leaves secrets and Python models behind', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chordmini-standalone-'));
    fs.mkdirSync(path.join(root, '.next', 'standalone'), { recursive: true });
    fs.writeFileSync(path.join(root, '.next', 'standalone', 'server.js'), 'server');
    fs.mkdirSync(path.join(root, '.next', 'static', 'chunks'), { recursive: true });
    fs.writeFileSync(path.join(root, '.next', 'static', 'chunks', 'app.js'), 'chunk');
    fs.mkdirSync(path.join(root, 'public', 'python_backend'), { recursive: true });
    fs.writeFileSync(path.join(root, 'public', 'favicon.ico'), 'icon');
    fs.writeFileSync(path.join(root, 'public', '.env.local'), 'SECRET=1');
    fs.writeFileSync(path.join(root, 'public', 'python_backend', 'model.bin'), 'weights');
    fs.writeFileSync(path.join(root, '.env'), 'PYTHON_API_URL=hidden');
    fs.mkdirSync(path.join(root, 'python_backend', 'models'), { recursive: true });
    fs.writeFileSync(path.join(root, 'python_backend', 'models', 'checkpoint.pt'), 'weights');

    const layout = prepareStandalone(root);

    expect(STANDALONE_ASSET_PLAN.map((entry) => entry.from)).toEqual(['.next/static', 'public']);
    expect(STANDALONE_EXCLUDED).toEqual(expect.arrayContaining(['.env', 'python_backend']));
    expect(fs.readFileSync(path.join(root, '.next', 'standalone', '.next', 'static', 'chunks', 'app.js'), 'utf8')).toBe('chunk');
    expect(fs.readFileSync(path.join(root, '.next', 'standalone', 'public', 'favicon.ico'), 'utf8')).toBe('icon');
    expect(fs.existsSync(path.join(root, '.next', 'standalone', 'public', '.env.local'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.next', 'standalone', 'public', 'python_backend'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.next', 'standalone', '.env'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.next', 'standalone', 'python_backend'))).toBe(false);
    expect(layout.serverEntry).toBe(path.join(root, '.next', 'standalone', 'server.js'));

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reports a missing standalone server before opening a window', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chordmini-missing-'));
    expect(() => prepareStandalone(root)).toThrow(/standalone server is missing/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
