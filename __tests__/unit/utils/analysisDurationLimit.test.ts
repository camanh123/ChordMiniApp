import {
  durationEligibility,
  durationGateDecision,
  localFileSourceId,
  youtubeVideoSourceId,
} from '@/utils/analysisDurationLimit';

describe('analysis duration eligibility', () => {
  const shortFile = { name: 'take.wav', size: 1200, lastModified: 10 };
  const longFile = { name: 'concert.wav', size: 9000, lastModified: 20 };

  it('does not treat missing, zero, or failed metadata as an eligible duration', () => {
    expect(durationEligibility(undefined).eligible).toBe(false);
    expect(durationEligibility(null)).toEqual({ eligible: false, reason: 'missing', seconds: null });
    expect(durationEligibility(0)).toEqual({ eligible: false, reason: 'invalid', seconds: null });
    expect(durationEligibility(Number.NaN)).toEqual({ eligible: false, reason: 'invalid', seconds: null });
    expect(durationEligibility(undefined, true)).toEqual({ eligible: false, reason: 'failed', seconds: null });
  });

  it('keeps the 12 minute cap and still allows a file at the cap', () => {
    expect(durationEligibility(720)).toEqual({ eligible: true, seconds: 720 });
    expect(durationEligibility(721)).toMatchObject({ eligible: false, reason: 'exceeded', seconds: 721 });
  });

  it('does not reject a short file because an unrelated long duration exists', () => {
    const staleVideo = {
      sourceId: youtubeVideoSourceId('abcdefghijk'),
      seconds: 20 * 60,
      failed: false,
    };
    const decision = durationGateDecision(staleVideo, localFileSourceId(shortFile));
    expect(decision).toEqual({ eligible: false, reason: 'missing', seconds: null });

    const own = durationGateDecision({
      sourceId: localFileSourceId(shortFile),
      seconds: 95,
      failed: false,
    }, localFileSourceId(shortFile));
    expect(own).toEqual({ eligible: true, seconds: 95 });
  });

  it('does not accept a long file because an unrelated short duration exists', () => {
    const staleShort = {
      sourceId: localFileSourceId(shortFile),
      seconds: 30,
      failed: false,
    };
    const decision = durationGateDecision(staleShort, localFileSourceId(longFile));
    expect(decision).toEqual({ eligible: false, reason: 'missing', seconds: null });

    const own = durationGateDecision({
      sourceId: localFileSourceId(longFile),
      seconds: 800,
      failed: false,
    }, localFileSourceId(longFile));
    expect(own).toMatchObject({ eligible: false, reason: 'exceeded', seconds: 800 });
  });
});
