import { describe, expect, it } from 'vitest';
import type { Capabilities } from '@otter-player/media';
import { createMp4RangeFormat, probeProgressive } from '@otter-player/format-mp4-range';

const caps = (mse: boolean) => ({ mediaSource: mse, managedMediaSource: false }) as unknown as Capabilities;
const LADDER = [{ src: 'https://e.test/360.mp4' }, { src: 'https://e.test/180.mp4' }];

describe('format-mp4-range', () => {
  it('probes progressive files by type or extension', () => {
    expect(probeProgressive({ src: 'https://e.test/a.mp4' })).toBeGreaterThan(0);
    expect(probeProgressive({ src: 'https://e.test/a.m3u8' })).toBe(0);
    expect(probeProgressive({ src: 'https://e.test/a', type: 'video/mp4' })).toBeGreaterThan(0);
  });

  it('single files stay native; renditions go through MSE Range loading with a native fallback', () => {
    const f = createMp4RangeFormat();
    expect(f.backends({ src: 'https://e.test/a.mp4' }, caps(true))).toEqual(['native']);
    expect(f.backends({ src: 'https://e.test/360.mp4', renditions: LADDER }, caps(true))).toEqual(['mse', 'native']);
    expect(f.backends({ src: 'https://e.test/360.mp4', renditions: LADDER }, caps(false))).toEqual(['native']);
    // Blobs have no Range requests.
    expect(f.backends({ src: new Blob([]), renditions: LADDER }, caps(true))).toEqual(['native']);
    expect(createMp4RangeFormat({ mse: 'always' }).backends({ src: 'https://e.test/a.mp4' }, caps(true))).toEqual(['mse', 'native']);
  });
});
