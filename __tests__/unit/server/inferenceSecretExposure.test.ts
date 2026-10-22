/**
 * @jest-environment node
 *
 * SECRET EXPOSURE: public config and client/renderer sources.
 * This file does not call Flask.
 */
import fs from 'fs';
import path from 'path';
import { GET } from '@/app/api/config/route';

const SECRET = 'exposure-secret-0123456789abcdef0123456789abcdef';
const PUBLIC_SECRET = 'public-exposure-secret-0123456789abcdef0123';

function walk(dir: string, files: string[]): void {
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === '.git') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, files);
    } else if (/\.(ts|tsx|js|jsx|cjs|mjs|yml|yaml)$/.test(entry.name)) {
      files.push(full);
    }
  }
}

describe('SECRET EXPOSURE public runtime and client sources', () => {
  const original = {
    secret: process.env.CHORDMINI_INFERENCE_SECRET,
    publicSecret: process.env.NEXT_PUBLIC_CHORDMINI_INFERENCE_SECRET,
  };

  afterEach(() => {
    if (original.secret === undefined) delete process.env.CHORDMINI_INFERENCE_SECRET;
    else process.env.CHORDMINI_INFERENCE_SECRET = original.secret;
    if (original.publicSecret === undefined) delete process.env.NEXT_PUBLIC_CHORDMINI_INFERENCE_SECRET;
    else process.env.NEXT_PUBLIC_CHORDMINI_INFERENCE_SECRET = original.publicSecret;
  });

  it('does not publish the inference secret from /api/config', async () => {
    process.env.CHORDMINI_INFERENCE_SECRET = SECRET;
    process.env.NEXT_PUBLIC_CHORDMINI_INFERENCE_SECRET = PUBLIC_SECRET;

    const response = await GET();
    const text = await response.text();
    const body = JSON.parse(text) as Record<string, string>;

    expect(response.status).toBe(200);
    expect(body.CHORDMINI_INFERENCE_SECRET).toBeUndefined();
    expect(body.NEXT_PUBLIC_CHORDMINI_INFERENCE_SECRET).toBeUndefined();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(PUBLIC_SECRET);
  });

  it('keeps the inference secret name out of client, renderer, and packaging sources', () => {
    const root = process.cwd();
    const files: string[] = [];
    walk(path.join(root, 'src'), files);
    walk(path.join(root, 'electron'), files);
    walk(path.join(root, '.github', 'workflows'), files);

    const allowed = [
      `${path.sep}src${path.sep}server${path.sep}`,
      `${path.sep}src${path.sep}desktop${path.sep}`,
      `${path.sep}src${path.sep}app${path.sep}api${path.sep}detect-beats${path.sep}`,
      `${path.sep}src${path.sep}app${path.sep}api${path.sep}recognize-chords${path.sep}`,
    ];

    const offenders = files.filter((file) => {
      const text = fs.readFileSync(file, 'utf8');
      if (!text.includes('CHORDMINI_INFERENCE_SECRET')) {
        return false;
      }
      return !allowed.some((prefix) => file.includes(prefix));
    });

    expect(offenders).toEqual([]);
  });
});
