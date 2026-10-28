import React, { useEffect } from 'react';
import { act, render } from '@testing-library/react';
import { ProcessingProvider, useProcessing, type ProcessingStage } from '@/contexts/ProcessingContext';
import { I18nProvider } from '@/i18n/I18nProvider';

const mockAddToast = jest.fn();
const mockCloseToast = jest.fn();

jest.mock('@heroui/react', () => ({
  addToast: (...args: unknown[]) => mockAddToast(...args),
  closeToast: (...args: unknown[]) => mockCloseToast(...args),
}));

import ProcessingStatusBanner from '@/components/analysis/ProcessingStatusBanner';

function Driver({
  stage,
  audioUrl,
  analysisSessionId,
}: {
  stage: ProcessingStage;
  audioUrl?: string;
  analysisSessionId?: number;
}) {
  const { setStage } = useProcessing();
  useEffect(() => {
    setStage(stage);
  }, [setStage, stage]);
  return (
    <ProcessingStatusBanner
      audioUrl={audioUrl}
      beatDetector="madmom"
      analysisSessionId={analysisSessionId}
    />
  );
}

function renderBanner(stage: ProcessingStage, audioUrl?: string, analysisSessionId?: number) {
  return render(
    <I18nProvider initialLocale="vi-VN">
      <ProcessingProvider>
        <Driver stage={stage} audioUrl={audioUrl} analysisSessionId={analysisSessionId} />
      </ProcessingProvider>
    </I18nProvider>,
  );
}

function rerenderBanner(
  view: ReturnType<typeof renderBanner>,
  stage: ProcessingStage,
  audioUrl?: string,
  analysisSessionId?: number,
) {
  view.rerender(
    <I18nProvider initialLocale="vi-VN">
      <ProcessingProvider>
        <Driver stage={stage} audioUrl={audioUrl} analysisSessionId={analysisSessionId} />
      </ProcessingProvider>
    </I18nProvider>,
  );
}

function progressBarSpec(callIndex = 0) {
  const endContent = (mockAddToast.mock.calls[callIndex][0] as {
    endContent?: React.ReactElement<{ children?: React.ReactNode }>;
  }).endContent;
  if (!endContent) {
    throw new Error('progress bar missing');
  }
  const children = React.Children.toArray(endContent.props.children);
  const styleNode = children[0] as React.ReactElement<{ dangerouslySetInnerHTML?: { __html: string } }>;
  const barNode = children[1] as React.ReactElement<{ style?: { width?: string; animation?: string } }>;
  return {
    css: styleNode.props.dangerouslySetInnerHTML?.__html ?? '',
    width: barNode.props.style?.width,
    animation: barNode.props.style?.animation ?? '',
  };
}

function titles(): string[] {
  return mockAddToast.mock.calls.map((call) => (call[0] as { title: string }).title);
}

describe('ProcessingStatusBanner lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    let nextKey = 0;
    mockAddToast.mockImplementation(() => `toast-${nextKey += 1}`);
  });

  it('shows the Vietnamese beat and chord progress copy without estimated dismiss timers', () => {
    const view = renderBanner('chord-recognition', 'blob:chord');
    expect(titles()).toEqual(['Đã gửi yêu cầu phân tích']);
    expect(mockAddToast.mock.calls[0][0]).toEqual(expect.objectContaining({
      description: 'Đã gửi phân tích hợp âm và nhịp. Thời gian đã trôi không phải phần trăm hoàn thành.',
      timeout: 0,
      hideCloseButton: true,
    }));

    view.rerender(
      <I18nProvider initialLocale="vi-VN">
        <ProcessingProvider>
          <Driver stage="beat-detection" audioUrl="blob:chord" />
        </ProcessingProvider>
      </I18nProvider>,
    );

    expect(titles()).toEqual(['Đã gửi yêu cầu phân tích', 'Đang nhận nhịp']);
    expect(mockAddToast.mock.calls[1][0]).toEqual(expect.objectContaining({
      description: 'Đang phân tích nhịp và thời gian...',
      timeout: 0,
    }));
    expect(mockCloseToast).not.toHaveBeenCalled();

    const chordBar = progressBarSpec(0);
    const beatBar = progressBarSpec(1);
    expect(chordBar.width).toBe('35%');
    expect(beatBar.width).toBe('35%');
    expect(chordBar.animation).toContain('infinite');
    expect(beatBar.animation).toContain('infinite');
    expect(chordBar.animation).not.toContain('forwards');
    expect(chordBar.css).not.toMatch(/width\s*:/);
    expect(beatBar.css).not.toMatch(/width\s*:/);
  });

  it('does not create another progress toast when the same stage renders again', () => {
    const view = renderBanner('beat-detection', 'blob:one');
    view.rerender(
      <I18nProvider initialLocale="vi-VN">
        <ProcessingProvider>
          <Driver stage="beat-detection" audioUrl="blob:one" />
        </ProcessingProvider>
      </I18nProvider>,
    );
    expect(titles().filter((title) => title === 'Đang nhận nhịp')).toHaveLength(1);
  });

  it('closes both progress toasts and shows the completion message', () => {
    const view = renderBanner('chord-recognition', 'blob:song');
    view.rerender(
      <I18nProvider initialLocale="vi-VN">
        <ProcessingProvider>
          <Driver stage="beat-detection" audioUrl="blob:song" />
        </ProcessingProvider>
      </I18nProvider>,
    );
    mockCloseToast.mockClear();
    view.rerender(
      <I18nProvider initialLocale="vi-VN">
        <ProcessingProvider>
          <Driver stage="complete" audioUrl="blob:song" />
        </ProcessingProvider>
      </I18nProvider>,
    );

    expect(mockCloseToast).toHaveBeenCalledWith('toast-1');
    expect(mockCloseToast).toHaveBeenCalledWith('toast-2');
    const success = mockAddToast.mock.calls.at(-1)?.[0] as { title: string; description: string; timeout: number };
    expect(success.title).toBe('Đã phân tích xong');
    expect(success.description).toContain('Đã phân tích nhịp và hợp âm trong');
    expect(success.timeout).toBe(5000);
  });

  it('clears progress toasts when analysis fails and does not add another progress toast', () => {
    const view = renderBanner('beat-detection', 'blob:song');
    const progressCount = mockAddToast.mock.calls.length;
    view.rerender(
      <I18nProvider initialLocale="vi-VN">
        <ProcessingProvider>
          <Driver stage="error" audioUrl="blob:song" />
        </ProcessingProvider>
      </I18nProvider>,
    );
    expect(mockCloseToast).toHaveBeenCalledWith('toast-1');
    expect(mockAddToast).toHaveBeenCalledTimes(progressCount);
  });

  it('creates one fresh pair when analysis is repeated', () => {
    const view = renderBanner('chord-recognition', 'blob:first');
    view.rerender(
      <I18nProvider initialLocale="vi-VN">
        <ProcessingProvider>
          <Driver stage="beat-detection" audioUrl="blob:first" />
        </ProcessingProvider>
      </I18nProvider>,
    );
    view.rerender(
      <I18nProvider initialLocale="vi-VN">
        <ProcessingProvider>
          <Driver stage="complete" audioUrl="blob:first" />
        </ProcessingProvider>
      </I18nProvider>,
    );
    mockAddToast.mockClear();
    view.rerender(
      <I18nProvider initialLocale="vi-VN">
        <ProcessingProvider>
          <Driver stage="chord-recognition" audioUrl="blob:first" />
        </ProcessingProvider>
      </I18nProvider>,
    );
    view.rerender(
      <I18nProvider initialLocale="vi-VN">
        <ProcessingProvider>
          <Driver stage="beat-detection" audioUrl="blob:first" />
        </ProcessingProvider>
      </I18nProvider>,
    );
    expect(titles()).toEqual(['Đã gửi yêu cầu phân tích', 'Đang nhận nhịp']);
  });

  it('drops progress toasts when the selected file is cleared and does not recreate them', () => {
    const view = renderBanner('beat-detection', 'blob:song');
    mockAddToast.mockClear();
    mockCloseToast.mockClear();
    view.rerender(
      <I18nProvider initialLocale="vi-VN">
        <ProcessingProvider>
          <Driver stage="beat-detection" audioUrl={undefined} />
        </ProcessingProvider>
      </I18nProvider>,
    );
    expect(mockCloseToast).toHaveBeenCalledWith('toast-1');
    expect(mockAddToast).not.toHaveBeenCalled();
  });

  it('closes progress toasts on unmount', () => {
    const view = renderBanner('chord-recognition', 'blob:song');
    mockCloseToast.mockClear();
    act(() => {
      view.unmount();
    });
    expect(mockCloseToast).toHaveBeenCalledWith('toast-1');
  });

  it('keeps a success toast when the same session reaches completion', () => {
    const view = renderBanner('beat-detection', 'blob:song', 4);
    mockAddToast.mockClear();
    rerenderBanner(view, 'complete', 'blob:song', 4);
    expect(titles()).toEqual(['Đã phân tích xong']);
  });

  it('does not show a stale success toast after the file is cleared', () => {
    const view = renderBanner('beat-detection', 'blob:a', 1);
    rerenderBanner(view, 'beat-detection', undefined, 2);
    mockAddToast.mockClear();
    rerenderBanner(view, 'complete', undefined, 2);
    expect(mockAddToast).not.toHaveBeenCalled();
  });

  it('does not show audio A success after the selection changes to audio B', () => {
    const view = renderBanner('chord-recognition', 'blob:a', 1);
    rerenderBanner(view, 'beat-detection', 'blob:a', 1);
    rerenderBanner(view, 'beat-detection', 'blob:b', 2);
    mockAddToast.mockClear();
    rerenderBanner(view, 'complete', 'blob:b', 2);
    expect(titles()).not.toContain('Đã phân tích xong');
    expect(mockAddToast).not.toHaveBeenCalled();
  });

  it('uses saved-result wording for a cache load and does not claim inference', () => {
    const view = renderBanner('cache-loading', 'blob:cache');
    expect(titles()).toEqual(['Đang tải kết quả đã lưu']);
    expect(mockAddToast.mock.calls[0][0]).toEqual(expect.objectContaining({
      description: 'Đang đọc bản ghi đã lưu. Chưa yêu cầu suy luận nhịp hay hợp âm.',
    }));
    expect(titles().join(' ')).not.toContain('Đang nhận nhịp');
    expect(titles().join(' ')).not.toContain('Đã phân tích nhịp và hợp âm');

    rerenderBanner(view, 'cache-loaded', 'blob:cache');
    expect(titles()).toContain('Đã tải kết quả đã lưu');
    const loaded = mockAddToast.mock.calls.map((call) => call[0] as { title: string; description: string });
    expect(loaded.some((toast) => toast.description.includes('Không chạy suy luận nhịp hay hợp âm mới.'))).toBe(true);
    expect(loaded.some((toast) => toast.description.includes('Đã phân tích nhịp và hợp âm'))).toBe(false);
    expect(loaded.some((toast) => toast.title === 'Đang nhận nhịp')).toBe(false);
  });

  it('does not show a success toast when a newer session owns the stage transition', () => {
    const view = renderBanner('beat-detection', 'blob:same', 1);
    mockAddToast.mockClear();
    rerenderBanner(view, 'complete', 'blob:same', 2);
    expect(mockAddToast).not.toHaveBeenCalled();
  });
});
