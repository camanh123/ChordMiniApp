import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider } from '@/i18n/I18nProvider';
import YouTubeAuthorizedSourcePanel from '@/components/analysis/YouTubeAuthorizedSourcePanel';
import type { AuthorizedRunRequest, AuthorizedRunResult } from '@/hooks/youtube/useAuthorizedYouTubeFile';

const VIDEO_A = 'abcdefghijk';
const VIDEO_B = 'zyxwvutsrqp';

function facts(): AuthorizedRunResult {
  return {
    appliedToVideo: true,
    stale: false,
    videoId: VIDEO_A,
    facts: {
      provenance: 'authorized-file',
      chordCount: 2,
      bpm: { value: 96, provenance: 'model' },
      key: { value: 'A minor', provenance: 'key-service' },
      meter: { value: '3/4', provenance: 'model' },
      capo: { value: 2, provenance: 'guitar-accompaniment-suggestion', detectedInRecording: false },
    },
  };
}

function renderPanel(overrides: Partial<React.ComponentProps<typeof YouTubeAuthorizedSourcePanel>> = {}) {
  const run = jest.fn(async (_request: AuthorizedRunRequest): Promise<AuthorizedRunResult> => facts());
  const publish = jest.fn();
  const view = render(
    <I18nProvider initialLocale="en-US">
      <YouTubeAuthorizedSourcePanel
        videoId={VIDEO_A}
        videoTitle="Known title"
        videoDurationSeconds={180}
        currentTimeSeconds={12.4}
        run={run}
        publish={publish}
        readDuration={async () => 180}
        {...overrides}
      />
    </I18nProvider>,
  );
  return { ...view, run, publish };
}

describe('YouTubeAuthorizedSourcePanel', () => {
  it('keeps Analyze disabled until an authorized file is selected', async () => {
    renderPanel();
    const button = screen.getByRole('button', { name: 'Analyze this file' });
    expect(button).toBeDisabled();
    const input = screen.getByLabelText('Audio file you are allowed to analyze');
    fireEvent.change(input, { target: { files: [new File(['x'], 'song.mp3', { type: 'audio/mpeg' })] } });
    expect(button).toBeEnabled();
    await waitFor(() => expect(screen.getByText(/within 5 seconds/)).toBeInTheDocument());
  });

  it('warns on a duration mismatch and withholds sync until confirmation', async () => {
    const { run } = renderPanel({ videoDurationSeconds: 180, readDuration: async () => 210 });
    fireEvent.change(screen.getByLabelText('Audio file you are allowed to analyze'), {
      target: { files: [new File(['x'], 'other.wav', { type: 'audio/wav' })] },
    });
    await waitFor(() => expect(screen.getByText(/more than 5 seconds/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Analyze this file' }));
    await waitFor(() => expect(run).toHaveBeenCalled());
    expect(run.mock.calls[0][0].syncAllowed).toBe(false);
    expect(screen.getByText(/Chord highlighting stays off/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Analyze this file' }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run.mock.calls[1][0].syncAllowed).toBe(true);
  });

  it('drops the previous video result when the video changes', async () => {
    const first = renderPanel();
    fireEvent.change(screen.getByLabelText('Audio file you are allowed to analyze'), {
      target: { files: [new File(['x'], 'song.mp3', { type: 'audio/mpeg' })] },
    });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Analyze this file' }));
    await waitFor(() => expect(screen.getByText('Detected chords: 2')).toBeInTheDocument());
    first.rerender(
      <I18nProvider initialLocale="en-US">
        <YouTubeAuthorizedSourcePanel
          videoId={VIDEO_B}
          videoTitle="Other title"
          videoDurationSeconds={90}
          currentTimeSeconds={1}
          run={first.run}
          publish={first.publish}
          readDuration={async () => 90}
        />
      </I18nProvider>,
    );
    expect(screen.queryByText('Detected chords: 2')).not.toBeInTheDocument();
    expect(screen.getByText('Video: Other title')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Analyze this file' })).toBeDisabled();
  });
});
