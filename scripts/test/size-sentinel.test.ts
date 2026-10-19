import { describe, expect, it } from 'vitest';
import { checkGrowth } from '../lib/size-sentinel.ts';

const HERO = '§19 own code (report, ≤ 5 KB gated from M6): 背景视频 / Hero';

describe('size sentinel', () => {
  it('flags growth above the threshold only, for watched entries only', () => {
    const current = [
      { name: HERO, size: 10_700 },
      { name: 'budget: core', size: 9_999 },
    ];
    expect(checkGrowth(current, { [HERO]: 10_100 }, /Hero/, 500)).toEqual([{ name: HERO, previous: 10_100, current: 10_700, grew: true }]);
    expect(checkGrowth(current, { [HERO]: 10_200 }, /Hero/, 500)[0]?.grew).toBe(false);
    expect(checkGrowth(current, {}, /Hero/, 500)[0]).toMatchObject({ previous: undefined, grew: false });
  });
});
