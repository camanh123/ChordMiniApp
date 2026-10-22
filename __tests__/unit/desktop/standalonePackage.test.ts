/**
 * @jest-environment node
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  bootStandaloneServer,
  materializeStandaloneDirectory,
  verifyStandaloneResolution,
} from '@/desktop/standalonePackage';

function writeNextPackage(directory: string, marker: string) {
  fs.mkdirSync(path.join(directory, 'dist', 'server', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
    name: 'next',
    version: '0.0.0',
    main: 'index.js',
  }));
  fs.writeFileSync(path.join(directory, 'index.js'), `module.exports = { marker: ${JSON.stringify(marker)} };`);
  fs.writeFileSync(
    path.join(directory, 'dist', 'server', 'lib', 'start-server.js'),
    'module.exports = { startServer() {} };',
  );
}

function linkDirectory(target: string, linkPath: string) {
  fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

function writeServer(standaloneDir: string, source: string) {
  fs.mkdirSync(standaloneDir, { recursive: true });
  fs.writeFileSync(path.join(standaloneDir, 'server.js'), source);
}

describe('standalone packaging', () => {
  it('materializes symlink dependencies as files inside the staged tree', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chordmini-materialize-'));
    const outside = path.join(root, 'checkout', 'next');
    const source = path.join(root, 'standalone');
    writeNextPackage(outside, 'traced');
    fs.mkdirSync(path.join(source, 'node_modules'), { recursive: true });
    linkDirectory(outside, path.join(source, 'node_modules', 'next'));
    fs.writeFileSync(path.join(source, 'server.js'), 'server');
    fs.writeFileSync(path.join(source, '.env'), 'SECRET=1');
    fs.mkdirSync(path.join(source, 'python_backend'), { recursive: true });
    fs.writeFileSync(path.join(source, 'python_backend', 'model.pt'), 'weights');

    const destination = path.join(root, 'desktop-resources', 'standalone');
    materializeStandaloneDirectory(source, destination);

    const packaged = path.join(destination, 'node_modules', 'next');
    expect(fs.lstatSync(packaged).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(packaged, 'index.js'), 'utf8')).toContain('traced');
    expect(fs.existsSync(path.join(destination, '.env'))).toBe(false);
    expect(fs.existsSync(path.join(destination, 'python_backend'))).toBe(false);
    const resolutions = verifyStandaloneResolution(destination);
    expect(resolutions.map((entry) => entry.id)).toEqual(['next', 'next/dist/server/lib/start-server']);
    expect(resolutions.every((entry) => entry.relativePath.startsWith('node_modules/next/'))).toBe(true);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('fails when next is only available from a parent checkout', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chordmini-parent-next-'));
    writeNextPackage(path.join(root, 'node_modules', 'next'), 'checkout');
    const standalone = path.join(root, 'desktop-resources', 'standalone');
    writeServer(standalone, 'require("next")');
    fs.mkdirSync(path.join(standalone, 'node_modules', 'next'), { recursive: true });
    fs.writeFileSync(path.join(standalone, 'node_modules', 'next', 'package.json'), JSON.stringify({
      name: 'next',
      main: 'missing.js',
    }));

    expect(() => verifyStandaloneResolution(standalone)).toThrow(/MODULE_NOT_FOUND/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('fails when the staged next package is a link outside the tree', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chordmini-link-next-'));
    const outside = path.join(root, 'checkout', 'next');
    writeNextPackage(outside, 'checkout');
    const standalone = path.join(root, 'standalone');
    writeServer(standalone, 'server');
    fs.mkdirSync(path.join(standalone, 'node_modules'), { recursive: true });
    linkDirectory(outside, path.join(standalone, 'node_modules', 'next'));

    expect(() => verifyStandaloneResolution(standalone)).toThrow(/outside the package/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('boots a standalone server only after its own modules load', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chordmini-boot-'));
    const standalone = path.join(root, 'standalone');
    writeNextPackage(path.join(standalone, 'node_modules', 'next'), 'packaged');
    writeServer(standalone, `
      require('next');
      require('next/dist/server/lib/start-server');
      const http = require('http');
      http.createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');
    `);

    const result = await bootStandaloneServer(standalone, 10000);
    expect(result.loopback).toBe(true);
    expect(result.port).toBeGreaterThan(0);
    fs.rmSync(root, { recursive: true, force: true });
  }, 20000);

  it('keeps standalone node_modules when copying with the shipped extraResources layout', () => {
    const script = path.join(os.tmpdir(), `chordmini-filter-${process.pid}.mjs`);
    fs.writeFileSync(script, `
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(process.cwd() + '/package.json');
const yaml = require('js-yaml');
const { FileMatcher } = require('app-builder-lib/out/fileMatcher');
const { copyDir } = require('builder-util/out/fs');
const config = yaml.load(fs.readFileSync(path.resolve('electron-builder.yml'), 'utf8'));
const extra = config.extraResources[0];
if (extra.from !== 'desktop-resources' || !extra.filter.includes('standalone/**/*')) {
  console.error('unexpected extraResources layout', JSON.stringify(extra));
  process.exit(1);
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chordmini-builder-'));
const source = path.join(root, 'desktop-resources');
const standalone = path.join(source, 'standalone');
fs.mkdirSync(path.join(standalone, 'node_modules', 'next'), { recursive: true });
fs.mkdirSync(path.join(standalone, '.next', 'static'), { recursive: true });
fs.mkdirSync(path.join(standalone, 'public'), { recursive: true });
fs.mkdirSync(path.join(standalone, 'python_backend'), { recursive: true });
fs.writeFileSync(path.join(source, 'manifest.json'), '{}');
fs.writeFileSync(path.join(standalone, 'server.js'), 'server');
fs.writeFileSync(path.join(standalone, '.env'), 'SECRET');
fs.writeFileSync(path.join(standalone, '.env.local'), 'SECRET');
fs.writeFileSync(path.join(standalone, 'node_modules', 'next', 'package.json'), '{"name":"next"}');
fs.writeFileSync(path.join(standalone, '.next', 'static', 'app.js'), 'chunk');
fs.writeFileSync(path.join(standalone, 'public', 'favicon.ico'), 'icon');
fs.writeFileSync(path.join(standalone, 'python_backend', 'model.pt'), 'weights');
const shipped = path.join(root, 'shipped');
const shippedMatcher = new FileMatcher(source, shipped, (value) => value, extra.filter);
await copyDir(shippedMatcher.from, shippedMatcher.to, { filter: shippedMatcher.createFilter() });
const nextPackage = path.join(shipped, 'standalone', 'node_modules', 'next', 'package.json');
if (!fs.existsSync(nextPackage)) process.exit(2);
if (!fs.existsSync(path.join(shipped, 'standalone', 'server.js'))) process.exit(8);
if (!fs.existsSync(path.join(shipped, 'standalone', 'public', 'favicon.ico'))) process.exit(9);
if (fs.readFileSync(path.join(shipped, 'standalone', '.next', 'static', 'app.js'), 'utf8') !== 'chunk') process.exit(3);
for (const blocked of ['.env', '.env.local', path.join('python_backend', 'model.pt')]) {
  if (fs.existsSync(path.join(shipped, 'standalone', blocked))) process.exit(4);
}
if (fs.existsSync(path.join(shipped, 'manifest.json'))) process.exit(5);
const dropped = path.join(root, 'dropped');
const oldMatcher = new FileMatcher(standalone, dropped, (value) => value, ['**/*', '!**/.env', '!**/.env.*', '!**/python_backend/**']);
await copyDir(oldMatcher.from, oldMatcher.to, { filter: oldMatcher.createFilter() });
if (!fs.existsSync(path.join(dropped, 'server.js'))) process.exit(6);
if (fs.existsSync(path.join(dropped, 'node_modules', 'next', 'package.json'))) process.exit(7);
fs.rmSync(root, { recursive: true, force: true });
`);
    const result = spawnSync(process.execPath, [script], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toMatchObject({ status: 0 });
    fs.rmSync(script, { force: true });
  });
});
