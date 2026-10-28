import React from 'react';
import { render, screen } from '@testing-library/react';
import { I18nProvider } from '@/i18n/I18nProvider';
import HomeHistorySection from '@/components/homepage/HomeHistorySection';

jest.mock('@/components/homepage/LazyRecentVideos', () => ({
  __esModule: true,
  default: function FirestoreRecentVideos() {
    return <p>Failed to load transcribed videos</p>;
  },
}));

jest.mock('@/services/audio/desktopHistoryLibrary', () => {
  const actual = jest.requireActual('@/services/audio/desktopHistoryLibrary');
  return {
    ...actual,
    loadDesktopHistory: jest.fn(async () => ({ state: 'ready', records: [], isolatedCount: 0 })),
  };
});

function setUserAgent(userAgent: string) {
  Object.defineProperty(window.navigator, 'userAgent', {
    value: userAgent,
    configurable: true,
  });
}

function setDisplayMode(mode: string | null) {
  window.matchMedia = jest.fn().mockImplementation((query: string) => ({
    matches: mode !== null && query === `(display-mode: ${mode})`,
    media: query,
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  }));
}

function renderSection() {
  return render(
    <I18nProvider initialLocale="en-US">
      <HomeHistorySection />
    </I18nProvider>,
  );
}

describe('home history source', () => {
  const originalRuntime = process.env.NEXT_PUBLIC_APP_RUNTIME;

  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_APP_RUNTIME;
    setUserAgent('Mozilla/5.0');
    setDisplayMode('browser');
  });

  afterEach(() => {
    if (originalRuntime === undefined) delete process.env.NEXT_PUBLIC_APP_RUNTIME;
    else process.env.NEXT_PUBLIC_APP_RUNTIME = originalRuntime;
  });

  it('keeps Firestore recent videos for the website', async () => {
    renderSection();
    expect(screen.getByRole('heading', { name: 'Recent Analyses' })).toBeInTheDocument();
    expect(await screen.findByText('Failed to load transcribed videos')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Analyses on this device' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Search by filename')).not.toBeInTheDocument();
  });

  it('keeps Firestore recent videos for an installed PWA', async () => {
    setDisplayMode('standalone');
    renderSection();
    expect(screen.getByRole('heading', { name: 'Recent Analyses' })).toBeInTheDocument();
    expect(await screen.findByText('Failed to load transcribed videos')).toBeInTheDocument();
    expect(screen.queryByLabelText('Search by filename')).not.toBeInTheDocument();
  });

  it('shows the local history library in Electron', async () => {
    process.env.NEXT_PUBLIC_APP_RUNTIME = 'electron';
    setUserAgent('Mozilla/5.0 Electron/30.0 ChordMini');
    renderSection();
    expect(await screen.findByRole('heading', { name: 'Analyses on this device' })).toBeInTheDocument();
    expect(await screen.findByText('No local analyses have been saved on this device yet.')).toBeInTheDocument();
    expect(screen.queryByText('Failed to load transcribed videos')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Recent Analyses' })).not.toBeInTheDocument();
  });
});
