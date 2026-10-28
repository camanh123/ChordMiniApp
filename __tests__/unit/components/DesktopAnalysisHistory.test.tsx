import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider } from '@/i18n/I18nProvider';
import { addToast } from '@heroui/react';
import DesktopAnalysisHistory from '@/components/homepage/DesktopAnalysisHistory';
import type { HistoryCard, HistoryLoadResult } from '@/services/audio/desktopHistoryLibrary';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

jest.mock('@heroui/react', () => ({
  addToast: jest.fn(),
  closeToast: jest.fn(),
}));

function card(index: number, filename = `song-${index}.mp3`): HistoryCard {
  return {
    id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
    filename,
    analyzedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    durationSeconds: index === 2 ? 65 : null,
    beatModel: 'madmom',
    chordModel: 'chord-cnn-lstm',
    bpm: index === 2 ? 96 : null,
    keyName: index === 2 ? 'D minor' : null,
    meterLabel: index === 2 ? '3/4' : null,
    chordPreview: index === 2 ? ['Am', 'G'] : [],
  };
}

function renderHistory(
  load: (fetchImpl?: typeof fetch) => Promise<HistoryLoadResult>,
  fetchImpl?: typeof fetch,
) {
  return render(
    <I18nProvider initialLocale="en-US">
      <DesktopAnalysisHistory load={load} fetchImpl={fetchImpl} />
    </I18nProvider>,
  );
}

describe('desktop analysis history section', () => {
  it('shows an empty local library without invented musical defaults', async () => {
    renderHistory(async () => ({ state: 'ready', records: [], isolatedCount: 0 }));
    expect(await screen.findByText('No local analyses have been saved on this device yet.')).toBeInTheDocument();
    expect(screen.queryByText(/120 BPM/)).not.toBeInTheDocument();
    expect(screen.queryByText('C major')).not.toBeInTheDocument();
    expect(screen.queryByText('4/4')).not.toBeInTheDocument();
    expect(screen.queryByText('0.8')).not.toBeInTheDocument();
  });

  it('searches by filename, pages 200 cards, and shows only recorded fields', async () => {
    const records = Array.from({ length: 200 }, (_, index) => card(index));
    renderHistory(async () => ({ state: 'ready', records, isolatedCount: 0 }));
    expect(await screen.findByRole('heading', { name: 'song-199.mp3' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'song-0.mp3' })).not.toBeInTheDocument();
    expect(screen.getByText('Page 1 of 17')).toBeInTheDocument();
    const openLinks = screen.getAllByRole('link', { name: 'Open saved analysis' });
    expect(openLinks).toHaveLength(12);
    expect(openLinks[0]).toHaveAttribute(
      'href',
      '/analyze/history/11111111-1111-4111-8111-000000000199',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText('Page 2 of 17')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'song-187.mp3' })).toBeInTheDocument();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search by filename' }), {
      target: { value: 'song-2.mp3' },
    });
    expect(screen.getByRole('heading', { name: 'song-2.mp3' })).toBeInTheDocument();
    expect(screen.getByText('96 BPM · D minor · 3/4')).toBeInTheDocument();
    expect(screen.getByText('Am · G')).toBeInTheDocument();
    expect(screen.getByText(/1:05/)).toBeInTheDocument();
    expect(screen.queryByText(/120 BPM/)).not.toBeInTheDocument();
    expect(screen.queryByText('4/4')).not.toBeInTheDocument();
  });

  it('keeps cards on screen when a later load cannot reach storage', async () => {
    const ready: HistoryLoadResult = { state: 'ready', records: [card(4, 'kept.mp3')], isolatedCount: 0 };
    const failed: HistoryLoadResult = { state: 'unavailable', records: [] };
    const { rerender } = renderHistory(async () => ready);
    expect(await screen.findByRole('heading', { name: 'kept.mp3' })).toBeInTheDocument();

    rerender(
      <I18nProvider initialLocale="en-US">
        <DesktopAnalysisHistory load={async () => failed} />
      </I18nProvider>,
    );
    expect(await screen.findByText('The history list could not be refreshed. Analyses already on screen were kept.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'kept.mp3' })).toBeInTheDocument();
    expect(screen.queryByText('No local analyses have been saved on this device yet.')).not.toBeInTheDocument();
  });

  it('shows storage unavailable without pretending the library is empty', async () => {
    renderHistory(async () => ({ state: 'unavailable', records: [] }));
    expect(await screen.findByText('Local history storage is unavailable. Saved analyses were not deleted.')).toBeInTheDocument();
    expect(screen.queryByText('No local analyses have been saved on this device yet.')).not.toBeInTheDocument();
  });

  it('deletes one record only after confirmation', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fetchImpl = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, body: String(init?.body ?? '') });
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
    });
    renderHistory(async () => ({
      state: 'ready',
      records: [card(1, 'keep.mp3'), card(2, 'remove.mp3')],
      isolatedCount: 0,
    }), fetchImpl as typeof fetch);

    expect(await screen.findByRole('heading', { name: 'remove.mp3' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete remove.mp3' }));
    expect(screen.getByText('Delete this saved analysis? The audio file is not deleted.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'remove.mp3' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete remove.mp3' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete saved analysis' }));
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'remove.mp3' })).not.toBeInTheDocument();
    });
    expect(screen.getByRole('heading', { name: 'keep.mp3' })).toBeInTheDocument();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/api/desktop/analysis-history/11111111-1111-4111-8111-000000000002');
    expect(JSON.parse(calls[0].body)).toEqual({
      recordId: '11111111-1111-4111-8111-000000000002',
      confirmDelete: true,
    });
    expect(calls[0].url).not.toMatch(/detect-beats|recognize-chords|detect-key/);
    expect(addToast).not.toHaveBeenCalled();
  });

  it('keeps both records when deletion fails', async () => {
    const fetchImpl = jest.fn(async () => ({ ok: false, status: 503, json: async () => ({ ok: false }) }) as Response);
    renderHistory(async () => ({
      state: 'ready',
      records: [card(3, 'still-here.mp3')],
      isolatedCount: 0,
    }), fetchImpl as typeof fetch);
    expect(await screen.findByRole('heading', { name: 'still-here.mp3' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete still-here.mp3' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete saved analysis' }));
    expect(await screen.findByText('Could not delete that saved analysis. Other records were kept.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'still-here.mp3' })).toBeInTheDocument();
  });
});
