import React from 'react';
import fs from 'fs';
import path from 'path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import LocalPracticeEntry from '@/components/analysis/LocalPracticeEntry';
import { I18nProvider } from '@/i18n/I18nProvider';

function wav(name: string, bytes = 2048): File {
  return new File([new Uint8Array(bytes)], name, { type: 'audio/wav' });
}

describe('local practice entry', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ notice: 'requirement' }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('shows one Open audio action and no playback dock before a file is chosen', () => {
    render(
      <LocalPracticeEntry
        file={null}
        onFileSelected={jest.fn()}
        serviceState="requirement"
      >
        <div>dock should stay hidden</div>
      </LocalPracticeEntry>,
    );

    expect(screen.getByRole('button', { name: 'Open audio' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Replace audio' })).not.toBeInTheDocument();
    expect(screen.getByText(/play it offline/i)).toBeInTheDocument();
    expect(screen.getByText(/no chords or beats are created/i)).toBeInTheDocument();
    expect(screen.queryByText('dock should stay hidden')).not.toBeInTheDocument();
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(1);
    expect(screen.getByTestId('open-audio-input')).toHaveAttribute('tabindex', '-1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('opens the single file input from the keyboard-focusable action', () => {
    render(
      <LocalPracticeEntry file={null} onFileSelected={jest.fn()} serviceState="requirement" />,
    );
    const input = screen.getByTestId('open-audio-input');
    const click = jest.spyOn(input, 'click');
    fireEvent.click(screen.getByRole('button', { name: 'Open audio' }));
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('reports the selected file and a later replacement without creating chords', () => {
    const onFileSelected = jest.fn();
    const { rerender } = render(
      <LocalPracticeEntry file={null} onFileSelected={onFileSelected} serviceState="requirement" />,
    );
    const input = screen.getByTestId('open-audio-input');
    fireEvent.change(input, { target: { files: [wav('first.wav')] } });
    fireEvent.change(input, { target: { files: [wav('second.wav', 4096)] } });

    expect(onFileSelected).toHaveBeenNthCalledWith(1, expect.objectContaining({ name: 'first.wav' }));
    expect(onFileSelected).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'second.wav' }));
    expect(screen.queryByText(/Cmaj|Am7|beat grid/i)).not.toBeInTheDocument();

    rerender(
      <LocalPracticeEntry
        file={wav('second.wav', 4096)}
        onFileSelected={onFileSelected}
        serviceState="requirement"
      >
        <div data-testid="playback-dock">Play</div>
      </LocalPracticeEntry>,
    );

    expect(screen.getByText('second.wav')).toBeInTheDocument();
    expect(screen.getByText(/4\.0 KB/)).toBeInTheDocument();
    expect(screen.getByTestId('playback-dock')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Replace audio' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open audio' })).not.toBeInTheDocument();
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(1);
    expect(screen.queryByText(/Cmaj|Am7/)).not.toBeInTheDocument();
  });

  it('keeps the existing playback speed steps and seek assignment', () => {
    const dock = fs.readFileSync(
      path.join(process.cwd(), 'src/components/analysis/AudioPlaybackDock.tsx'),
      'utf8',
    );
    const page = fs.readFileSync(
      path.join(process.cwd(), 'src/app/analyze/page.tsx'),
      'utf8',
    );
    expect(dock).toContain('const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;');
    expect(page).toContain('audioRef.current.currentTime = t');
    expect(page).toContain('onChangePlaybackRate={changePlaybackRate}');
    const entry = fs.readFileSync(
      path.join(process.cwd(), 'src/components/analysis/LocalPracticeEntry.tsx'),
      'utf8',
    );
    expect(entry).not.toMatch(/recognize-chords|detect-beats|PYTHON_API_URL/);
  });

  it('explains a missing configuration in Vietnamese before analysis is requested', () => {
    render(
      <I18nProvider initialLocale="vi-VN">
        <LocalPracticeEntry file={null} onFileSelected={jest.fn()} serviceState="not_configured" />
      </I18nProvider>,
    );

    expect(screen.getByRole('button', { name: 'Mở âm thanh' })).toBeInTheDocument();
    expect(screen.getByText('Thiếu cấu hình dịch vụ bắt buộc')).toBeInTheDocument();
    expect(screen.getByText(/không tạo hợp âm hay nhịp/)).toBeInTheDocument();
    expect(screen.queryByText('Analysis service unavailable')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('explains an unavailable service without inventing chords or calling inference', () => {
    render(
      <LocalPracticeEntry file={wav('song.wav')} onFileSelected={jest.fn()} serviceState="unavailable" />,
    );

    expect(screen.getByText('Analysis service unavailable')).toBeInTheDocument();
    expect(screen.getByText(/No chords or beats were generated/)).toBeInTheDocument();
    expect(screen.queryByText(/Cmaj|Am7|120 BPM/)).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks only the same-origin notice route and ignores a remote address in the payload', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        notice: 'requirement',
        url: 'https://inference.example/secret',
        token: 'secret-token',
      }),
    });

    render(<LocalPracticeEntry file={null} onFileSelected={jest.fn()} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe('/api/practice-inference-notice');
    expect(JSON.stringify(fetchMock.mock.calls)).not.toMatch(/recognize-chords|detect-beats/);
    expect(screen.queryByText(/inference\.example|secret-token/)).not.toBeInTheDocument();
    expect(screen.queryByText('Analysis service unavailable')).not.toBeInTheDocument();
    expect(screen.getByText(/need an available inference service/i)).toBeInTheDocument();
  });
});
