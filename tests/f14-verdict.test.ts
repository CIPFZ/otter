// F14's rule for underruns on emulated-android (e2e/audio-stalls.ts): what it lets through.
import { describe, expect, it } from 'vitest';
import { f14Verdict, type SinkStat } from '../e2e/audio-stalls.ts';

const stat = (media: number, dq: number, under: number): SinkStat => ({ media, ahead: 0.1, under, gap: 0, late: 0, disc: 0, dq, wall: 0 });

// `0edda47`, emulated-android, the idle-suspend case: ran dry at the cap; the window's summary ends
// with a later chunk's (lower) queue depth.
const DRY_AT_CAP = 'audio ran dry at 2.944 s for 17 ms (decode queue 17); its chunk 2.944 s fed 7256 ms ago, out 6169 ms ago';

describe('f14Verdict', () => {
  it('lets through an underrun that ran dry with the decode queue at its cap, whatever the summary says (owner 2026-11-05)', () => {
    const v = f14Verdict('emulated-android', [DRY_AT_CAP], [stat(3.0, 4, 816)]);
    expect(v.kept).toEqual([]);
    expect(v.letThrough).toHaveLength(1);
    expect(v.letMs).toBe(17);
  });

  it('keeps one below the cap without a summary at it, and every one off emulated-android', () => {
    const low = 'audio ran dry at 1.000 s for 20 ms (decode queue 0)';
    expect(f14Verdict('emulated-android', [low], [stat(1.0, 0, 900)]).kept).toEqual([low]);
    expect(f14Verdict('desktop-chrome', [DRY_AT_CAP], [stat(2.9, 17, 816)]).kept).toEqual([DRY_AT_CAP]);
  });

  it('a summary with the signature within 0.4 s still lets one through', () => {
    const old = 'audio ran dry at 7.695 s for 1 ms';
    const v = f14Verdict('emulated-android', [old], [stat(7.8, 17, 3902)]);
    expect(v.letThrough[0]?.summary?.dq).toBe(17);
  });
});
