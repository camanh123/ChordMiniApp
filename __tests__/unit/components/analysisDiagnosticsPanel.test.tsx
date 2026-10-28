import { render, screen } from '@testing-library/react';
import AnalysisDiagnosticsPanel from '@/components/analysis/AnalysisDiagnosticsPanel';
import {
  abandonDiagnosticSession,
  bindDiagnosticSession,
  noteBeatRequestSent,
  resetAnalysisDiagnostics,
} from '@/services/audio/analysisDiagnostics';

describe('AnalysisDiagnosticsPanel', () => {
  beforeEach(() => {
    resetAnalysisDiagnostics();
  });

  it('shows real events, the model-start limitation, and unconfirmed cancellation', () => {
    const sessionId = bindDiagnosticSession('panel');
    noteBeatRequestSent(sessionId, 'madmom');
    abandonDiagnosticSession();

    render(<AnalysisDiagnosticsPanel />);

    expect(screen.getByTestId('analysis-diagnostics')).toHaveTextContent('BEAT_REQUEST_SENT');
    expect(screen.getByTestId('diagnostics-model-limitation')).toHaveTextContent(
      /not proof that inference started/i,
    );
    expect(screen.getByTestId('diagnostics-cancellation-unconfirmed')).toHaveTextContent(
      /Server-side cancellation is unconfirmed/i,
    );
    expect(screen.getByTestId('analysis-diagnostics')).toHaveTextContent('Abandoned');
    expect(screen.getByTestId('analysis-diagnostics').textContent).not.toContain('%');
  });
});
