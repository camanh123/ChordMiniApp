import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(repoRoot, 'desktop-resources', 'standalone');
const { prepareStandalone } = require(path.join(repoRoot, 'electron', 'dist', 'prepareStandalone.js'));
const { materializeStandaloneDirectory } = require(path.join(repoRoot, 'electron', 'dist', 'standalonePackage.js'));

const layout = prepareStandalone(repoRoot);
fs.rmSync(path.dirname(destination), { recursive: true, force: true });
materializeStandaloneDirectory(path.dirname(layout.serverEntry), destination);

const sharp = require('sharp');
const iconDir = path.join(repoRoot, 'build');
fs.mkdirSync(iconDir, { recursive: true });
const png = await sharp(path.join(repoRoot, 'public', 'chordMiniLogo.webp'))
  .resize(256, 256)
  .png()
  .toBuffer();
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
const entry = Buffer.alloc(16);
entry.writeUInt8(0, 0);
entry.writeUInt8(0, 1);
entry.writeUInt16LE(1, 4);
entry.writeUInt16LE(32, 6);
entry.writeUInt32LE(png.length, 8);
entry.writeUInt32LE(header.length + entry.length, 12);
fs.writeFileSync(path.join(iconDir, 'icon.ico'), Buffer.concat([header, entry, png]));
fs.writeFileSync(path.join(iconDir, 'icon.png'), png);

const topLevel = fs.readdirSync(destination);
if (!topLevel.includes('server.js')) {
  throw new Error('The staged desktop server is missing server.js.');
}
fs.writeFileSync(path.join(repoRoot, 'desktop-resources', 'manifest.json'), `${JSON.stringify({
  serverEntry: 'standalone/server.js',
  topLevel,
  nodeRuntime: 'electron-run-as-node',
  pythonBundled: false,
}, null, 2)}\n`);
console.log(`Staged the Next.js standalone server at ${destination}`);
