import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

// jsdom's File cannot stream or expose arrayBuffer. This stub only drives the
// view's match and mismatch branches. The real SHA-256 comparison is in
// desktopHistoryLibrary.test.ts.
jest.mock('@/services/audio/incrementalSha256', () => {
  const actual = jest.requireActual('@/services/audio/incrementalSha256');
  return {
    ...actual,
    hashBlobSha256: jest.fn(async (blob: Blob) => {
      const name = blob instanceof File ? blob.name : '';
      if (name === 'song.mp3') {
        return { digest: 'a'.repeat(64), incremental: false, maxChunkBytes: blob.size };
      }
      if (name === 'other.mp3') {
        return { digest: 'b'.repeat(64), incremental: false, maxChunkBytes: blob.size };
      }
      throw new Error('unreadable test blob');
    }),
  };
});
import { addToast } from '@heroui/react';
import { I18nProvider } from '@/i18n/I18nProvider';
import SavedAnalysisView from '@/components/analysis/SavedAnalysisView';
import SavedAnalysisPage from '@/app/analyze/history/[id]/page';
import type { RestoredAnalysis } from '@/services/audio/desktopHistoryLibrary';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

jest.mock('next/navigation', () => ({
  useParams: () => ({ id: '11111111-1111-4111-8111-111111111111' }),
}));

jest.mock('@heroui/react', () => ({
  addToast: jest.fn(),
  closeToast: jest.fn(),
}));

const RECORD: RestoredAnalysis = {
  id: '11111111-1111-4111-8111-111111111111',
  filename: 'song.mp3',
  analyzedAt: '2026-10-26T14:03:05.123Z',
  durationSeconds: null,
  beatModel: 'madmom',
  chordModel: 'chord-cnn-lstm',
  bpm: null,
  keyName: null,
  meterLabel: null,
  contentSha256: 'ab'.repeat(32),
  resultSha256: null,
  chords: [{ chord: 'Am', start: 0.25, end: 1.5, confidence: null }],
  beats: [{ time: 0.25 }, { time: 1.25 }],
  downbeats: [0.25],
  synchronizedChords: [{ chord: 'Am', beatIndex: 0 }],
};

function renderSaved(record: RestoredAnalysis = RECORD) {
  return render(
    <I18nProvider initialLocale="en-US">
      <SavedAnalysisView record={record} />
    </I18nProvider>,
  );
}

describe('saved analysis replay', () => {
  const originalRuntime = process.env.NEXT_PUBLIC_APP_RUNTIME;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_RUNTIME = 'electron';
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 Electron/30.0 ChordMini',
      configurable: true,
    });
    URL.createObjectURL = jest.fn(() => 'blob:relinked-audio');
    URL.revokeObjectURL = jest.fn();
    (global.fetch as jest.Mock).mockReset();
  });

  afterEach(() => {
    if (originalRuntime === undefined) delete process.env.NEXT_PUBLIC_APP_RUNTIME;
    else process.env.NEXT_PUBLIC_APP_RUNTIME = originalRuntime;
    URL.createObjectURL = typeof originalCreate === 'function' ? originalCreate : jest.fn();
    URL.revokeObjectURL = typeof originalRevoke === 'function' ? originalRevoke : jest.fn();
  });

  it('shows saved chords and beats without audio, defaults, or a new analysis', () => {
    renderSaved();
    expect(screen.getByText('Opened from saved results. AI was not run again.')).toBeInTheDocument();
    expect(screen.getByText('Audio playback needs the original file. The saved chords and beats stay visible without it.')).toBeInTheDocument();
    expect(screen.getByText('0.250–1.500 Am')).toBeInTheDocument();
    expect(screen.getAllByText('0.250').length).toBeGreaterThan(0);
    expect(screen.getByText('1.250')).toBeInTheDocument();
    expect(screen.getByText('0: Am @ 0.250')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to local history' })).toHaveAttribute('href', '/#local-history');
    expect(document.querySelector('audio')).toBeNull();
    expect(screen.queryByText(/120/)).not.toBeInTheDocument();
    expect(screen.queryByText('C major')).not.toBeInTheDocument();
    expect(screen.queryByText('4/4')).not.toBeInTheDocument();
    expect(screen.queryByText('0.8')).not.toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toHaveAttribute('accept', 'audio/mpeg,audio/wav,.mp3,.wav');
    expect(input).not.toHaveAttribute('webkitdirectory');
    expect(addToast).not.toHaveBeenCalled();
  });

  it('rejects a different file and plays only a matching file', async () => {
    const record = { ...RECORD, contentSha256: 'a'.repeat(64) };
    const snapshot = JSON.stringify(record);
    renderSaved(record);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['other'], 'other.mp3', { type: 'audio/mpeg' })] },
    });
    expect(await screen.findByText('This file does not match the saved analysis. The saved result was not changed.')).toBeInTheDocument();
    expect(document.querySelector('audio')).toBeNull();
    expect(screen.getByText('0.250–1.500 Am')).toBeInTheDocument();

    fireEvent.change(input, {
      target: { files: [new File(['original'], 'song.mp3', { type: 'audio/mpeg' })] },
    });
    expect(await screen.findByText('The selected file matches this saved analysis.')).toBeInTheDocument();
    expect(document.querySelector('audio')).toHaveAttribute('src', 'blob:relinked-audio');
    fireEvent.change(input, {
      target: { files: [new File(['other'], 'other.mp3', { type: 'audio/mpeg' })] },
    });
    expect(await screen.findByText('This file does not match the saved analysis. The saved result was not changed.')).toBeInTheDocument();
    expect(document.querySelector('audio')).toHaveAttribute('src', 'blob:relinked-audio');
    expect(screen.getByText('0.250–1.500 Am')).toBeInTheDocument();
    expect(JSON.stringify(record)).toBe(snapshot);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('opens a saved record from the history API and does not call inference', async () => {
    (global.fetch as jest.Mock).mockImplementation(async (url: string) => {
      const target = String(url);
      if (/detect-beats|recognize-chords|detect-key|lrclib/.test(target)) {
        throw new Error(`inference call ${target}`);
      }
      if (target.endsWith('/lyrics')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, lyrics: null }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          record: {
            schemaVersion: 1,
            id: '11111111-1111-4111-8111-111111111111',
            source: { displayName: 'song.mp3', contentSha256: 'cd'.repeat(32) },
            analyzedAt: '2026-10-26T14:03:05.123Z',
            models: { beat: 'madmom', chord: 'chord-cnn-lstm' },
            chords: [{ chord: 'Am', start: 0.25, end: 1.5 }],
            beats: [{ time: 0.25 }, { time: 1.25 }],
          },
        }),
      };
    });

    render(
      <I18nProvider initialLocale="en-US">
        <SavedAnalysisPage />
      </I18nProvider>,
    );
    expect(await screen.findByText('0.250–1.500 Am')).toBeInTheDocument();
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
    const urls = (global.fetch as jest.Mock).mock.calls.map((call) => String(call[0]));
    expect(urls).toEqual([
      '/api/desktop/analysis-history/11111111-1111-4111-8111-111111111111',
      '/api/desktop/analysis-history/11111111-1111-4111-8111-111111111111/lyrics',
    ]);
    expect(urls.some((url) => /detect-beats|recognize-chords|detect-key|lrclib/.test(url))).toBe(false);
    expect(await screen.findByText('This saved analysis has no synchronized lyrics.')).toBeInTheDocument();
  });

  it('does not request history on the website', () => {
    delete process.env.NEXT_PUBLIC_APP_RUNTIME;
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0',
      configurable: true,
    });
    render(
      <I18nProvider initialLocale="en-US">
        <SavedAnalysisPage />
      </I18nProvider>,
    );
    expect(screen.queryByText('0.250–1.500 Am')).not.toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
