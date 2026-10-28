import fs from 'fs';
import path from 'path';
import { publishedDetectorBpm } from '@/services/audio/analysisHistoryFacts';

describe('measured BPM provenance', () => {
  it('does not publish the display fallback when the detector omitted BPM', () => {
    expect(publishedDetectorBpm(undefined, undefined)).toBeUndefined();
    expect(publishedDetectorBpm(0, null, '120')).toBeUndefined();
    expect(publishedDetectorBpm(undefined, 96)).toBe(96);
    expect(publishedDetectorBpm(128, undefined)).toBe(128);
  });

  it('does not assign 120 inside the beat detector normalizer', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/services/audio/beatDetectionService.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/\|\|\s*120\b/);
    expect(source).toContain('publishedDetectorBpm');
  });
});
