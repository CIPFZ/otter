// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { createAbrDriver } from '@otter-player/pipeline';
import { allowedBy, createOtterShakaAbr, type ShakaVariant } from '@otter-player/engine-adapter-shaka';

const v = (id: number, bandwidth: number, height: number): ShakaVariant => ({ id, bandwidth, video: { width: Math.round((height * 16) / 9), height } });
const ladder = [v(10, 3_200_000, 1080), v(11, 300_000, 240), v(12, 1_600_000, 720), v(13, 800_000, 480)];

let clock = 0;
let buffer = 12;
function setup(bufferAhead = 12) {
  const driver = createAbrDriver();
  clock = 0;
  buffer = bufferAhead;
  const abr = createOtterShakaAbr(driver, { bufferAhead: () => buffer, now: () => clock });
  const switches: number[] = [];
  abr.init((variant) => switches.push(variant.id));
  abr.setMediaElement(document.createElement('video'));
  abr.setVariants(ladder, false);
  return { abr, driver, switches };
}

const segment = { segment: { startTime: 0, endTime: 4 } };

describe('Otter AbrManager for Shaka', () => {
  it('starts with the highest variant that fits the default estimate (500 kbps)', () => {
    const { abr } = setup();
    expect(abr.chooseVariant().id).toBe(11);
    expect(abr.lastChoice?.reason).toMatch(/^startup/);
  });

  it('switches up after fast downloads only when enabled, and explains why', () => {
    const { abr, switches } = setup();
    abr.chooseVariant();
    for (let i = 0; i < 5; i++) abr.segmentDownloaded(1000, 4_000_000, true, undefined, segment); // 32 Mbps
    expect(switches).toEqual([]); // not enabled yet
    abr.enable();
    abr.segmentDownloaded(1000, 4_000_000, true, undefined, segment);
    expect(switches).toEqual([]); // up-switch waits for switchInterval (8 s) after the initial choice
    clock = 8000;
    abr.segmentDownloaded(1000, 4_000_000, true, undefined, segment);
    expect(switches).toEqual([10]);
    // At 12 s of buffer the dynamic strategy lets BOLA vote (dash.js hybridSwitchBufferTime).
    expect(abr.lastChoice).toMatchObject({ id: 'variant-10', reason: expect.stringMatching(/^dynamic: bola: /) });
    expect(abr.getBandwidthEstimate()).toBeGreaterThan(10_000_000);
    // No duplicate switch to the same variant.
    abr.segmentDownloaded(1000, 4_000_000, true, undefined, segment);
    expect(switches).toEqual([10]);
  });

  it('down-switches apply immediately even inside switchInterval', () => {
    const { abr, switches } = setup(12);
    abr.configure({ switchInterval: 0 });
    abr.chooseVariant();
    abr.enable();
    for (let i = 0; i < 5; i++) abr.segmentDownloaded(1000, 4_000_000, true, undefined, segment);
    expect(switches.at(-1)).toBe(10); // up to the top variant
    abr.configure({ switchInterval: 8 });
    // Buffer almost gone and throughput collapsed: InsufficientBuffer caps hard, inside the interval.
    buffer = 1;
    for (let i = 0; i < 6; i++) abr.segmentDownloaded(4000, 40_000, true, undefined, segment);
    expect(switches.at(-1)).toBe(11);
  });


  it('never switches before the initial chooseVariant()', () => {
    const { abr, switches } = setup();
    abr.enable();
    for (let i = 0; i < 5; i++) abr.segmentDownloaded(1000, 4_000_000, true, undefined, segment);
    expect(switches).toEqual([]);
  });

  it('ignores small (init / index) downloads and respects allowSwitch', () => {
    const { abr, driver, switches } = setup();
    abr.chooseVariant();
    abr.enable();
    abr.segmentDownloaded(10, 2_000, true);
    expect(driver.canEstimate).toBe(false);
    abr.segmentDownloaded(1000, 4_000_000, false, undefined, segment);
    expect(switches).toEqual([]);
  });

  it('applies restrictions, falling back to all variants when none pass', () => {
    const { abr, switches } = setup();
    abr.configure({ restrictions: { maxHeight: 720 }, switchInterval: 0 });
    abr.chooseVariant();
    abr.enable();
    for (let i = 0; i < 5; i++) abr.segmentDownloaded(1000, 4_000_000, true, undefined, segment);
    expect(switches.at(-1)).toBe(12);
    expect(allowedBy(v(1, 1, 1080), { maxHeight: 720 })).toBe(false);
    abr.configure({ restrictions: { maxHeight: 100 } });
    expect(abr.chooseVariant().id).toBeDefined();
  });

  it('stop() stops switching; seeking resets the rules', () => {
    const { abr, driver, switches } = setup();
    const reset = vi.spyOn(driver, 'reset');
    const media = document.createElement('video');
    abr.setMediaElement(media);
    media.dispatchEvent(new Event('seeking'));
    expect(reset).toHaveBeenCalledOnce();
    abr.chooseVariant();
    abr.enable();
    abr.stop();
    abr.segmentDownloaded(1000, 4_000_000, true, undefined, segment);
    expect(switches).toEqual([]);
    expect(abr.isInitialized()).toBe(false);
  });
});
