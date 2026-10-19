import { describe, expect, it } from 'vitest';
import { cueArea, DEFAULT_CUE_SETTINGS, horizontalLayout, layoutCues, type CueSettings, type RegionSettings } from '@otter-player/text';

const s = (over: Partial<CueSettings> = {}): CueSettings => ({ ...DEFAULT_CUE_SETTINGS, ...over });
const AREA = { width: 1000, height: 500 };
const LINE = 25;

describe('horizontalLayout (WebVTT §7.2)', () => {
  it('centres by default', () => {
    expect(horizontalLayout(s())).toEqual({ leftPct: 0, widthPct: 100, textAlign: 'center' });
  });

  it('derives position and position alignment from align', () => {
    expect(horizontalLayout(s({ align: 'left', size: 40 }))).toMatchObject({ leftPct: 0, widthPct: 40 });
    expect(horizontalLayout(s({ align: 'right', size: 40 }))).toMatchObject({ leftPct: 60, widthPct: 40 });
    expect(horizontalLayout(s({ align: 'end', size: 30 }))).toMatchObject({ leftPct: 70, widthPct: 30 });
  });

  it('limits size to the room left by position', () => {
    expect(horizontalLayout(s({ position: 80, positionAlign: 'line-left' }))).toMatchObject({ leftPct: 80, widthPct: 20 });
    expect(horizontalLayout(s({ position: 30, positionAlign: 'center' }))).toMatchObject({ leftPct: 0, widthPct: 60 });
    expect(horizontalLayout(s({ position: 70, positionAlign: 'center', size: 20 }))).toMatchObject({ leftPct: 60, widthPct: 20 });
    expect(horizontalLayout(s({ position: 25, positionAlign: 'line-right' }))).toMatchObject({ leftPct: 0, widthPct: 25 });
  });
});

describe('layoutCues', () => {
  it('puts line:auto cues on the bottom line and stacks the next one above', () => {
    const [a, b] = layoutCues([{ settings: s(), height: 50 }, { settings: s(), height: 25 }], AREA, LINE);
    expect(a).toMatchObject({ top: 450, height: 50, left: 0, width: 1000, hidden: false });
    expect(b?.top).toBeLessThanOrEqual(425 - 25 + 25);
    expect((b?.top ?? 0) + 25).toBeLessThanOrEqual(450);
  });

  it('counts non-negative lines from the top and negative lines from the bottom', () => {
    const [top, second, bottom] = layoutCues(
      [
        { settings: s({ line: 0 }), height: 25 },
        { settings: s({ line: 2 }), height: 25 },
        { settings: s({ line: -2 }), height: 25 },
      ],
      AREA,
      LINE,
    );
    expect(top?.top).toBe(0);
    expect(second?.top).toBe(50);
    expect(bottom?.top).toBe(450);
  });

  it('moves a colliding top cue down', () => {
    const [a, b] = layoutCues([{ settings: s({ line: 0 }), height: 50 }, { settings: s({ line: 1 }), height: 25 }], AREA, LINE);
    expect(a?.top).toBe(0);
    expect(b?.top).toBe(50);
  });

  it('cues side by side do not collide', () => {
    const [a, b] = layoutCues(
      [
        { settings: s({ align: 'left', size: 40 }), height: 25 },
        { settings: s({ align: 'right', size: 40 }), height: 25 },
      ],
      AREA,
      LINE,
    );
    expect(a?.top).toBe(475);
    expect(b?.top).toBe(475);
  });

  it('positions percentage lines with lineAlign and avoids overlaps', () => {
    const [a, b, c] = layoutCues(
      [
        { settings: s({ snapToLines: false, line: 10 }), height: 40 },
        { settings: s({ snapToLines: false, line: 50, lineAlign: 'center' }), height: 40 },
        { settings: s({ snapToLines: false, line: 10 }), height: 40 },
      ],
      AREA,
      LINE,
    );
    expect(a?.top).toBe(50);
    expect(b?.top).toBe(230);
    // Same spot as `a`: nearest free position next to it.
    expect([10, 90]).toContain(c?.top);
  });

  it('stacks region cues bottom-up inside the region and hides what scrolled out', () => {
    const region: RegionSettings = { id: 'r', width: 50, lines: 2, regionAnchorX: 0, regionAnchorY: 100, viewportAnchorX: 10, viewportAnchorY: 90, scroll: 'up' };
    const [old, mid, last] = layoutCues(
      [
        { settings: s({ region }), height: 25 },
        { settings: s({ region }), height: 25 },
        { settings: s({ region }), height: 25 },
      ],
      AREA,
      LINE,
    );
    // Region box: left 100, width 500, bottom at 450, two lines tall.
    expect(last).toMatchObject({ left: 100, width: 500, top: 425, hidden: false });
    expect(mid).toMatchObject({ top: 400, hidden: false });
    expect(old).toMatchObject({ top: 375, hidden: true });
  });

  it('keeps an unplaceable cue at its first position instead of dropping it', () => {
    const tiny = { width: 100, height: 30 };
    const out = layoutCues([{ settings: s(), height: 25 }, { settings: s(), height: 25 }], tiny, LINE);
    expect(out.map((o) => o.hidden)).toEqual([false, false]);
    expect(out[1]?.top).toBe(5);
  });
});

describe('cueArea', () => {
  const content = { left: 0, top: 60, width: 640, height: 360 };
  const container = { width: 640, height: 480 };

  it('letterbox: a control bar inside the black bar does not move cues', () => {
    expect(cueArea(content, container, 48)).toEqual(content);
  });

  it('a control bar overlapping the picture shortens the area by the overlap', () => {
    expect(cueArea(content, container, 100)).toEqual({ ...content, height: 320 });
    expect(cueArea({ left: 0, top: 0, width: 640, height: 480 }, container, 48)).toEqual({ left: 0, top: 0, width: 640, height: 432 });
  });
});
