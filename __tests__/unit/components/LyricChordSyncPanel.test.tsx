/**
 * Synthetic fixture UI. This does not play a device recording or call LRCLIB.
 */
import React, { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@/i18n/I18nProvider';
import EnhancedLyricsDisplay from '@/components/lyrics/EnhancedLyricsDisplay';
import LyricChordSyncPanel from '@/components/lyrics/LyricChordSyncPanel';
import type { CatalogLookupResult } from '@/services/lyrics/lyricCatalogLookup';
import type { CatalogLyricCandidate } from '@/services/lyrics/lyricChordAlignment';

const LRC = `[ti:Fixture Song]
[ar:Fixture Artist]
[length:00:20.00]
[00:00.00]
[00:05.00]Line one has two chords
[00:09.00]Line two
[00:12.00]
[00:16.00]Line three
`;

const CHORDS = [
  { chord: 'Am', start: 1, end: 3 },
  { chord: 'C', start: 5.5, end: 7 },
  { chord: 'G', start: 7, end: 10 },
  { chord: 'F', start: 12.5, end: 15 },
  { chord: 'Dm', start: 16, end: 19 },
];

function candidate(overrides: Partial<CatalogLyricCandidate> = {}): CatalogLyricCandidate {
  return {
    id: '9',
    title: 'Catalog Song',
    artist: 'Catalog Artist',
    catalogDurationSeconds: 20,
    instrumental: false,
    granularity: 'line',
    recognizesAudio: false,
    rows: [
      { time: 1, text: 'Catalog line' },
      { time: 4, text: 'Second catalog line' },
    ],
    ...overrides,
  };
}

function renderPanel(props: Partial<React.ComponentProps<typeof LyricChordSyncPanel>> = {}) {
  const lookup = props.lookup ?? jest.fn(async (): Promise<CatalogLookupResult> => ({ ok: true, candidates: [] }));
  const onSeek = props.onSeek ?? jest.fn();
  const view = render(
    <I18nProvider initialLocale="en-US">
      <LyricChordSyncPanel
        chords={CHORDS}
        currentTime={0}
        audioDuration={20}
        fileKey="song-a.mp3:10:1"
        sessionId={1}
        onSeek={onSeek}
        lookup={lookup}
        {...props}
      />
    </I18nProvider>,
  );
  return { ...view, lookup, onSeek };
}

describe('LyricChordSyncPanel', () => {
  it('shows a truthful empty state and does not search or infer by itself', () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    fetchSpy.mockClear();
    const { lookup } = renderPanel();
    expect(screen.getByText(/This file was not transcribed/)).toBeTruthy();
    expect(screen.getByText(/not saved in analysis history/)).toBeTruthy();
    expect(lookup).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('waits for an explicit catalog choice before showing synchronized lines', async () => {
    const user = userEvent.setup();
    const lookup = jest.fn(async (): Promise<CatalogLookupResult> => ({
      ok: true,
      candidates: [candidate()],
    }));
    renderPanel({ lookup });
    await user.type(screen.getByLabelText('Song title'), 'Catalog Song');
    await user.type(screen.getByLabelText('Artist'), 'Catalog Artist');
    await user.click(screen.getByRole('button', { name: 'Search catalog' }));
    expect(await screen.findByText(/LRCLIB does not recognize lyrics/)).toBeTruthy();
    expect(screen.queryByText('Catalog line')).toBeNull();
    expect(lookup).toHaveBeenCalledWith({
      artist: 'Catalog Artist',
      title: 'Catalog Song',
      audioDurationSeconds: 20,
    });
    await user.click(screen.getByRole('button', { name: 'Use these lyrics' }));
    expect(screen.getByText('Catalog line')).toBeTruthy();
  });

  it('asks before synchronizing a catalog edition whose duration differs', async () => {
    const user = userEvent.setup();
    renderPanel({
      lookup: jest.fn(async () => ({
        ok: true,
        candidates: [candidate({ catalogDurationSeconds: 180 })],
      })),
    });
    await user.type(screen.getByLabelText('Song title'), 'Catalog Song');
    await user.type(screen.getByLabelText('Artist'), 'Catalog Artist');
    await user.click(screen.getByRole('button', { name: 'Search catalog' }));
    expect(await screen.findByText(/differs from this audio by 160.0 s/)).toBeTruthy();
    expect(screen.queryByText('Catalog line')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Confirm this edition' }));
    expect(screen.getByText('Catalog line')).toBeTruthy();
  });

  it('imports a local timestamped lrc file and highlights from currentTime', async () => {
    const user = userEvent.setup();
    const onSeek = jest.fn();
    const view = renderPanel({ onSeek, currentTime: 8 });
    const input = screen.getByLabelText('Import timestamped .lrc') as HTMLInputElement;
    await user.upload(input, new File([LRC], 'fixture.lrc', { type: 'text/plain' }));
    expect(await screen.findByText('Line one has two chords')).toBeTruthy();
    expect(document.querySelectorAll('[data-chord="C"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-chord="G"]').length).toBeGreaterThan(1);
    expect(screen.getAllByText(/Instrumental/).length).toBeGreaterThan(0);
    const active = document.querySelector('[data-active-line="true"]');
    expect(active?.textContent).toContain('Line one has two chords');
    expect(document.querySelector('[data-active-chord="true"]')?.getAttribute('data-chord')).toBe('G');

    view.rerender(
      <I18nProvider initialLocale="en-US">
        <LyricChordSyncPanel
          chords={CHORDS}
          currentTime={8}
          audioDuration={20}
          fileKey="song-a.mp3:10:1"
          sessionId={1}
          onSeek={onSeek}
          lookup={jest.fn()}
        />
      </I18nProvider>,
    );
    expect(document.querySelector('[data-active-line="true"]')?.textContent).toContain('Line one has two chords');

    view.rerender(
      <I18nProvider initialLocale="en-US">
        <LyricChordSyncPanel
          chords={CHORDS}
          currentTime={13}
          audioDuration={20}
          fileKey="song-a.mp3:10:1"
          sessionId={1}
          onSeek={onSeek}
          lookup={jest.fn()}
        />
      </I18nProvider>,
    );
    expect(document.querySelector('[data-active-gap="true"]')?.textContent).toContain('Instrumental');
    await user.click(screen.getByRole('button', { name: /Line two/ }));
    expect(onSeek).toHaveBeenCalledWith(9);
  });

  it('drops lyrics when the file or analysis session changes and ignores a late lookup', async () => {
    const user = userEvent.setup();
    let resolveLookup: (result: CatalogLookupResult) => void = () => undefined;
    const lookup = jest.fn(() => new Promise<CatalogLookupResult>((resolve) => {
      resolveLookup = resolve;
    }));
    function Harness({ fileKey, sessionId, chords }: { fileKey: string; sessionId: number; chords: typeof CHORDS }) {
      const [marker] = useState('chords-stay');
      return (
        <I18nProvider initialLocale="en-US">
          <p>{marker}</p>
          <p data-testid="chord-count">{chords.length}</p>
          <LyricChordSyncPanel
            chords={chords}
            currentTime={8}
            audioDuration={20}
            fileKey={fileKey}
            sessionId={sessionId}
            onSeek={jest.fn()}
            lookup={lookup}
          />
        </I18nProvider>
      );
    }
    const view = render(<Harness fileKey="a.mp3:1:1" sessionId={1} chords={CHORDS} />);
    const input = screen.getByLabelText('Import timestamped .lrc') as HTMLInputElement;
    await user.upload(input, new File([LRC], 'fixture.lrc', { type: 'text/plain' }));
    expect(await screen.findByText('Line one has two chords')).toBeTruthy();
    view.rerender(<Harness fileKey="b.mp3:2:2" sessionId={2} chords={[{ chord: 'Em', start: 0, end: 1 }]} />);
    expect(screen.queryByText('Line one has two chords')).toBeNull();
    expect(screen.getByTestId('chord-count')).toHaveTextContent('1');

    await user.type(screen.getByLabelText('Song title'), 'Late');
    await user.type(screen.getByLabelText('Artist'), 'Artist');
    await user.click(screen.getByRole('button', { name: 'Search catalog' }));
    view.rerender(<Harness fileKey="c.mp3:3:3" sessionId={3} chords={[{ chord: 'Em', start: 0, end: 1 }]} />);
    resolveLookup({
      ok: true,
      candidates: [candidate({ rows: [{ time: 1, text: 'ONLY-A' }] })],
    });
    await waitFor(() => expect(lookup).toHaveBeenCalled());
    expect(screen.queryByText('ONLY-A')).toBeNull();
    expect(screen.queryByText('Line one has two chords')).toBeNull();
  });

  it('keeps a failed lookup from removing the lyric panel and reports plain or instrumental entries', async () => {
    const user = userEvent.setup();
    const lookup = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        candidates: [
          candidate({ id: 'plain', rows: null, granularity: 'plain', instrumental: false }),
          candidate({ id: 'inst', rows: null, granularity: 'instrumental', instrumental: true, title: 'Inst Track' }),
        ],
      })
      .mockRejectedValueOnce(new Error('offline'));
    renderPanel({ lookup });
    await user.type(screen.getByLabelText('Song title'), 'Catalog Song');
    await user.type(screen.getByLabelText('Artist'), 'Catalog Artist');
    await user.click(screen.getByRole('button', { name: 'Search catalog' }));
    expect(await screen.findByText('Inst Track — Catalog Artist')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Use these lyrics' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Confirm this edition' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Search catalog' }));
    expect(await screen.findByText(/Chord and beat results are unchanged/)).toBeTruthy();
    expect(screen.getByTestId('lyric-sync-panel')).toBeTruthy();
  });

  it('keeps imported lyrics mounted while the parent tab is hidden', async () => {
    const user = userEvent.setup();
    function Tabs({ tab }: { tab: 'map' | 'lyrics' }) {
      return (
        <I18nProvider initialLocale="en-US">
          <div hidden={tab !== 'lyrics'}>
            <LyricChordSyncPanel
              chords={CHORDS}
              currentTime={8}
              audioDuration={20}
              fileKey="song-a.mp3:10:1"
              sessionId={1}
              onSeek={jest.fn()}
              lookup={jest.fn()}
            />
          </div>
        </I18nProvider>
      );
    }
    const view = render(<Tabs tab="lyrics" />);
    await user.upload(
      screen.getByLabelText('Import timestamped .lrc'),
      new File([LRC], 'fixture.lrc', { type: 'text/plain' }),
    );
    expect(await screen.findByText('Line three')).toBeTruthy();
    view.rerender(<Tabs tab="map" />);
    view.rerender(<Tabs tab="lyrics" />);
    expect(screen.getByText('Line three')).toBeTruthy();
  });

  it('does not render a fallback C chord when a lyric line has no chords', () => {
    render(
      <I18nProvider initialLocale="en-US">
        <EnhancedLyricsDisplay
          lyrics={{ lines: [{ startTime: 0, endTime: 2, text: 'Hello world' }] }}
          currentTime={0}
          autoScroll={false}
        />
      </I18nProvider>,
    );
    expect(screen.getByText('Hello')).toBeTruthy();
    expect(screen.queryByText('C')).toBeNull();
  });
});
