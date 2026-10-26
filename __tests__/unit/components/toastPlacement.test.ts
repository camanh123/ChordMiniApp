/**
 * @jest-environment node
 */
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../../..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('analysis toast placement', () => {
  const providers = read('src/app/providers.tsx');
  const css = read('src/app/globals.css');
  const navigation = read('src/components/common/Navigation.tsx');
  const banner = read('src/components/analysis/ProcessingStatusBanner.tsx');

  it('places the system region below the fixed 4rem navigation', () => {
    expect(navigation).toContain('!h-16');
    expect(navigation).toContain('!z-[100]');
    expect(providers).toContain('placement="top-right"');
    expect(providers).toContain('disableAnimation');
    expect(providers).toContain("className: 'chordmini-toast-region'");
    expect(css).toContain('.chordmini-toast-region[data-placement^="top"]');
    expect(css).toContain('top: calc(4rem + 1rem) !important;');
    expect(css).toContain('z-index: 80 !important;');
    expect(css).toContain('transform: none !important;');
    expect(css).toContain('width: min(22.25rem, calc(100vw - 1.5rem)) !important;');
    expect(css).toContain('max-height: calc(100dvh - 4rem - 2rem);');
    expect(css).toContain('gap: 0.5rem;');
    expect(css).toContain('height: auto !important;');
    expect(css).toContain('transform: none !important;');
    expect(css).not.toMatch(/z-index:\s*9999/);
  });

  it('keeps mini-game toasts out of the system region', () => {
    expect(css).toContain('.chordmini-toast-region .minigame-toast');
    expect(css).toContain('[data-placement="bottom-right"] > *:not(.minigame-toast)');
  });

  it('does not dismiss progress toasts on an estimated timer or change analysis requests', () => {
    expect(banner).not.toContain('setTimeout');
    expect(banner).not.toContain('/api/');
    expect(banner).not.toContain('.focus(');
    expect(banner).not.toContain('getAudioDurationFromUrl');
    expect(banner).not.toContain('width: 0%');
    expect(banner).not.toContain('width: 100%');
    expect(banner).toContain('infinite');
    expect(banner).toContain('timeout: 0');
    expect(banner).toContain("t('analyze.detectingTitle')");
    expect(banner).toContain("t('analyze.recognizingTitle')");
    expect(banner).toContain("t('analyze.completeDetail'");
  });

  it('keeps hover from translating the toast back under the header', () => {
    expect(providers).toContain('disableAnimation');
    expect(css).toContain('transform: none !important;');
    expect(css).toContain('height: auto !important;');
    expect(css).toContain('gap: 0.5rem;');
    expect(css).toContain('width: min(22.25rem, calc(100vw - 1.5rem)) !important;');
    expect(navigation).toContain('!h-16');
    expect(css).toContain('top: calc(4rem + 1rem) !important;');
  });
});
