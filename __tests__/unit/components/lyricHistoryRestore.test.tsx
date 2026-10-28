/**
 * Synthetic restore. This does not play a recording or call LRCLIB.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@/i18n/I18nProvider';
import LyricChordSyncPanel from '@/components/lyrics/LyricChordSyncPanel';
import type { LyricHistorySnapshot } from '@/components/lyrics/LyricChordSyncPanel';
import SavedAnalysisView from '@/components/analysis/SavedAnalysisView';
import type { RestoredAnalysis } from '@/services/audio/desktopHistoryLibrary';
import type { LyricHistoryDraft, StoredLyricSidecar } from '@/services/audio/lyricHistoryClient';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

const HASH = 'd'.repeat(64);

const SNAPSHOT: LyricHistorySnapshot = {
  parentResultSha256: HASH,
  offsetSeconds: 0,
  sourceOffsetSeconds: 0,
  userModified: false,
  identity: {
    source: 'local-lrc',
    trackTitle: 'Fixture Song',
    artist: 'Fixture Artist',
    catalogDurationSeconds: 20,
    recognizesAudio: false,
  },
  rows: [
    { time: 0, text: '', words: null },
    { time: 5, text: 'Line one has two chords', words: null },
    { time: 9, text: 'Line two', words: null },
    { time: 16, text: 'Line three', words: null },
  ],
};

const CHORDS = [
  { chord: 'Am', start: 1, end: 3 },
  { chord: 'C', start: 5.5, end: 7 },
  { chord: 'G', start: 7, end: 10 },
];

function renderPanel(persist: (draft: LyricHistoryDraft) => Promise<{ ok: boolean }>) {
  return render(
    <I18nProvider initialLocale="en-US">
      <LyricChordSyncPanel
        chords={CHORDS}
        currentTime={8}
        audioDuration={20}
        fileKey="saved-record"
        sessionId={0}
        historyResultSha256={HASH}
        initialSnapshot={SNAPSHOT}
        allowCatalogSearch={false}
        onPersistLyrics={persist}
        onSeek={() => undefined}
        lookup={async () => {
          throw new Error('catalog lookup is not used for a saved record');
        }}
      />
    </I18nProvider>,
  );
}

describe('saved lyric offset and restore', () => {
  beforeEach(() => {
    (global.fetch as jest.Mock).mockReset();
  });

  it('previews, confirms, and reverts an offset without rewriting source timestamps', async () => {
    const user = userEvent.setup();
    const persisted: LyricHistoryDraft[] = [];
    renderPanel(async (draft) => {
      persisted.push(draft);
      return { ok: true };
    });

    expect(screen.getByText('Line one has two chords')).toBeTruthy();
    expect(screen.getByText('Active offset 0.000 s')).toBeTruthy();
    expect(screen.getByText('Source offset 0.000 s')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Search catalog' })).toBeNull();
    expect(screen.getByRole('button', { name: /Line one/ }).textContent).toContain('0:05.00');

    const offset = screen.getByRole('textbox', { name: 'Time offset (seconds)' });
    await user.clear(offset);
    await user.type(offset, '0.5');
    await user.click(screen.getByRole('button', { name: 'Preview offset' }));

    expect(screen.getByText('Active offset 0.500 s')).toBeTruthy();
    expect(screen.getByText('Source offset 0.000 s')).toBeTruthy();
    expect(screen.getByText(/Previewing 0.500 s/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Line one/ }).textContent).toContain('0:05.50');
    expect(persisted).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Save this offset' }));
    await waitFor(() => expect(persisted).toHaveLength(1));
    expect(persisted[0].offsetSeconds).toBe(0.5);
    expect(persisted[0].sourceOffsetSeconds).toBe(0);
    expect(persisted[0].userModified).toBe(true);
    expect(persisted[0].rows[1].time).toBe(5);
    expect(persisted[0].recognizesAudio).toBe(false);
    expect(screen.getByText('Synchronized lyrics were saved with this analysis.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Revert to original timing' }));
    await waitFor(() => expect(persisted).toHaveLength(2));
    expect(persisted[1].offsetSeconds).toBe(0);
    expect(persisted[1].userModified).toBe(false);
    expect(persisted[1].rows[1].time).toBe(5);
    expect(screen.getByText('Active offset 0.000 s')).toBeTruthy();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rejects an offset that leaves the audio and keeps the confirmed timing', async () => {
    const user = userEvent.setup();
    const persisted: LyricHistoryDraft[] = [];
    renderPanel(async (draft) => {
      persisted.push(draft);
      return { ok: true };
    });
    const offset = screen.getByRole('textbox', { name: 'Time offset (seconds)' });
    await user.clear(offset);
    await user.type(offset, '16');
    await user.click(screen.getByRole('button', { name: 'Preview offset' }));

    expect(screen.getByText('That offset does not fit this audio, so the timestamps were not moved.')).toBeTruthy();
    expect(screen.getByText('Active offset 0.000 s')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Line one/ }).textContent).toContain('0:05.00');
    expect(screen.queryByRole('button', { name: 'Save this offset' })).toBeNull();
    expect(persisted).toHaveLength(0);
  });

  it('reopens saved lyrics on a history record without calling inference or LRCLIB', () => {
    const record: RestoredAnalysis = {
      id: '11111111-1111-4111-8111-111111111111',
      filename: 'song.mp3',
      analyzedAt: '2026-10-26T14:03:05.123Z',
      durationSeconds: null,
      beatModel: 'madmom',
      chordModel: 'chord-cnn-lstm',
      bpm: null,
      keyName: null,
      meterLabel: null,
      contentSha256: 'a'.repeat(64),
      resultSha256: HASH,
      chords: [{ chord: 'Am', start: 0.25, end: 1.5, confidence: null }],
      beats: [{ time: 0.25 }, { time: 1.25 }],
      downbeats: null,
      synchronizedChords: null,
    };
    const lyrics: StoredLyricSidecar = {
      schemaVersion: 1,
      parentId: record.id,
      parentResultSha256: HASH,
      savedAt: '2026-10-26T14:04:00.000Z',
      source: 'lrclib',
      trackTitle: 'Fixture Song',
      artist: 'Fixture Artist',
      catalogDurationSeconds: 20,
      audioDurationSeconds: 20,
      granularity: 'line',
      sourceOffsetSeconds: 0,
      offsetSeconds: 0.5,
      confirmedEdition: true,
      recognizesAudio: false,
      userModified: true,
      rows: SNAPSHOT.rows,
    };
    render(
      <I18nProvider initialLocale="en-US">
        <SavedAnalysisView record={record} lyrics={lyrics} lyricNotice="none" />
      </I18nProvider>,
    );

    expect(screen.getByText('Opened from saved results. AI was not run again.')).toBeTruthy();
    expect(screen.getByText('0.250–1.500 Am')).toBeTruthy();
    expect(screen.getByText('Line one has two chords')).toBeTruthy();
    expect(screen.getByText('Active offset 0.500 s')).toBeTruthy();
    expect(screen.getByText('Source offset 0.000 s')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Search catalog' })).toBeNull();
    expect(screen.queryByText(/120/)).toBeNull();
    expect(screen.queryByText('C major')).toBeNull();
    expect(screen.queryByText('4/4')).toBeNull();
    expect(screen.queryByText('0.8')).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toHaveAttribute('accept', 'audio/mpeg,audio/wav,.mp3,.wav');
  });

  it('does not attach lyrics whose parent hash belongs to another result', () => {
    const record: RestoredAnalysis = {
      id: '11111111-1111-4111-8111-111111111111',
      filename: 'song.mp3',
      analyzedAt: '2026-10-26T14:03:05.123Z',
      durationSeconds: 20,
      beatModel: 'madmom',
      chordModel: 'chord-cnn-lstm',
      bpm: null,
      keyName: null,
      meterLabel: null,
      contentSha256: 'a'.repeat(64),
      resultSha256: HASH,
      chords: [{ chord: 'Am', start: 0.25, end: 1.5, confidence: null }],
      beats: [{ time: 0.25 }, { time: 1.25 }],
      downbeats: null,
      synchronizedChords: null,
    };
    render(
      <I18nProvider initialLocale="en-US">
        <SavedAnalysisView
          record={record}
          lyrics={{
            schemaVersion: 1,
            parentId: record.id,
            parentResultSha256: 'e'.repeat(64),
            savedAt: '2026-10-26T14:04:00.000Z',
            source: 'lrclib',
            trackTitle: 'Other Song',
            artist: 'Other Artist',
            catalogDurationSeconds: 20,
            audioDurationSeconds: 20,
            granularity: 'line',
            sourceOffsetSeconds: 0,
            offsetSeconds: 0,
            confirmedEdition: true,
            recognizesAudio: false,
            userModified: false,
            rows: [{ time: 1, text: 'Foreign lyric', words: null }],
          }}
          lyricNotice="mismatch"
        />
      </I18nProvider>,
    );
    expect(screen.queryByText('Foreign lyric')).toBeNull();
    expect(screen.getByText('These lyrics do not match the saved analysis, so they were not attached.')).toBeTruthy();
    expect(screen.getByText('0.250–1.500 Am')).toBeTruthy();
  });
});
