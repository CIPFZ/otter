import { describe, expect, it } from 'vitest';
import { blockTest, mergeSettings, DEFAULT_DANMAKU, sampled } from '../src/settings.js';
import { parseComments } from '../src/parse.js';
import { allocate, binsearch, resetSpace, type Stage } from '../src/vendor/danmaku/allocate.js';
import { frame, rebuild, type FrameHooks, type FrameState, type Placed } from '../src/vendor/danmaku/frame.js';
import { parseXml } from '../src/vendor/CommentCoreLibrary/bilibili.js';

const stage: Stage = { width: 800, height: 300, duration: 8, fixedDuration: 4 };
type C = Placed & { text: string };
const c = (time: number, mode: C['mode'] = 'rtl', width = 100, height = 30): C => ({ time, mode, width, height, x: 0, y: 0, text: `${mode}@${time}` });
const hooks: FrameHooks<C> = { accept: () => true, setup: () => undefined, remove: () => undefined };
const state = (comments: C[]): FrameState<C> => ({ comments, position: 0, running: [], space: resetSpace() });

describe('track allocation (danmaku, L3)', () => {
  it('stacks comments that would collide, reuses a track once the earlier one has moved on', () => {
    const space = resetSpace();
    expect(allocate(space, c(0), 0, stage)).toBe(0);
    expect(allocate(space, c(0), 0, stage)).toBe(30);
    expect(allocate(space, c(0.1), 0.1, stage)).toBe(60);
    // 4 s later the first ones are far enough left: the top track again.
    expect(allocate(space, c(4), 4, stage)).toBe(0);
  });

  it('top from the top, bottom from the bottom; no room: dropped (-1), not overlapped', () => {
    const space = resetSpace();
    expect(allocate(space, c(0, 'top'), 0, stage)).toBe(0);
    expect(allocate(space, c(0, 'bottom'), 0, stage)).toBe(270);
    const full = resetSpace();
    for (let i = 0; i < 10; i++) expect(allocate(full, c(0, 'top'), 0, stage)).toBe(i * 30);
    expect(allocate(full, c(0, 'top'), 0, stage)).toBe(-1);
  });

  it('binsearch: first index after a time', () => {
    const list = [0, 1, 1, 2, 5].map((time) => ({ time }));
    expect([-1, 0, 1, 1.5, 2, 9].map((t) => binsearch(list, t))).toEqual([0, 1, 3, 3, 4, 5]);
  });
});

describe('frame (media time only)', () => {
  it('x is a function of media time: the same time gives the same picture; rate and pause need no state', () => {
    const s = state([c(1), c(2, 'top')]);
    frame(s, 3, stage, hooks);
    const first = s.running.map((x) => [x.text, x.x, x.y]);
    expect(first).toEqual([
      ['rtl@1', 800 - (900 * 2) / 8, 0],
      ['top@2', 350, 0],
    ]);
    frame(s, 3, stage, hooks);
    expect(s.running.map((x) => [x.text, x.x, x.y])).toEqual(first);
    frame(s, 5, stage, hooks);
    expect(s.running.map((x) => x.text)).toEqual(['rtl@1', 'top@2']);
    frame(s, 6.5, stage, hooks);
    // The top comment has had its 4 s.
    expect(s.running.map((x) => x.text)).toEqual(['rtl@1']);
    frame(s, 9.5, stage, hooks);
    expect(s.running).toEqual([]);
  });

  it('rebuild (seek): what is in flight at the new time enters again mid-flight; earlier ones do not', () => {
    const s = state([c(0), c(10), c(14), c(20)]);
    frame(s, 1, stage, hooks);
    rebuild(s, 15, stage, hooks);
    frame(s, 15, stage, hooks);
    expect(s.running.map((x) => x.text)).toEqual(['rtl@10', 'rtl@14']);
    expect(s.running[0]?.x).toBeCloseTo(800 - (900 * 5) / 8);
    rebuild(s, 0.5, stage, hooks);
    frame(s, 0.5, stage, hooks);
    expect(s.running.map((x) => x.text)).toEqual(['rtl@0']);
  });
});

describe('B站 XML (CommentCoreLibrary, L3) and JSON', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><i><chatid>207527</chatid>
<d p="15.104999542236,1,25,16777215,1388314569,0,1a87dd40,364586099">关了弹幕瞬间好多了</d>
<d p="0.55500000715256,5,25,6737151,1388553840,0,357931b1,366052476">提示：手机客户端/n请调至“无限制”</d>
<d p="2,4,36,16711680,1,0,a,1">底部 &amp; &lt;b&gt;</d>
<d p="3,6,18,255,1,0,a,2">逆向</d>
<d p="8.2,7,25,16751001,1408888765,0,c1cd5522,576934780">[0,0,"1-1",3.8,"高级",0,0,0,0,1000,0,true,"微软雅黑",1,"M67,264L66,264L230,263"]</d>
<d p="16.6,8,25,16777215,1353069133,2,241d61da,149343959">var exCanvas=$.createCanvas({});</d>
<d p="">这是一个测试</d></i>`;

  it('parses modes 1-6 without a DOM, decodes entities and B站 newlines; advanced, code and malformed are skipped', () => {
    const r = parseXml(xml);
    expect(r.skipped).toBe(3);
    expect(r.comments.map((x) => [x.time, x.mode, x.size, x.color, x.text, x.id])).toEqual([
      [15.104999542236, 1, 25, 0xffffff, '关了弹幕瞬间好多了', '364586099'],
      [0.55500000715256, 5, 25, 6737151, '提示：手机客户端\n请调至“无限制”', '366052476'],
      [2, 4, 36, 0xff0000, '底部 & <b>', '1'],
      [3, 6, 18, 255, '逆向', '2'],
    ]);
  });

  it('maps to engine comments: modes, and the three JSON shapes', () => {
    expect(parseComments(xml).comments.map((x) => x.mode)).toEqual(['rtl', 'top', 'bottom', 'ltr']);
    const ccl = parseComments(JSON.stringify([{ stime: 1500, mode: 5, size: 25, color: 255, text: 'ccl' }, { stime: 1, mode: 7, text: 'x' }]));
    expect(ccl).toEqual({ comments: [{ time: 1.5, text: 'ccl', mode: 'top', color: 255, size: 25 }], skipped: 1 });
    const bili = parseComments(JSON.stringify({ elems: [{ progress: 2500, mode: 4, fontsize: 36, color: 16711680, content: '底' }] }));
    expect(bili.comments).toEqual([{ time: 2.5, text: '底', mode: 'bottom', color: 0xff0000, size: 36 }]);
    const dplayer = parseComments(JSON.stringify({ code: 0, data: [[3.2, 1, 16777215, 'a', 'dp'], [1, 0, 255, 'b', 'r']] }));
    expect(dplayer.comments).toEqual([
      { time: 3.2, text: 'dp', mode: 'top', color: 0xffffff },
      { time: 1, text: 'r', mode: 'rtl', color: 255 },
    ]);
    expect(() => parseComments('{"x":1}')).toThrow(/no comment list/);
  });
});

describe('settings', () => {
  it('clamps a patch and keeps the rest', () => {
    const s = mergeSettings(DEFAULT_DANMAKU, { opacity: 5, speed: 0.1, area: 0.5, hideTop: true, blocked: ['a', '', 3 as unknown as string] });
    expect(s).toMatchObject({ opacity: 1, speed: 0.5, area: 0.5, hideTop: true, blocked: ['a'], enabled: true, fontScale: 1 });
  });

  it('blocked words: substrings and /regex/, an invalid pattern as text', () => {
    const t = blockTest(['剧透', '/^前方高能/', '/[/']);
    expect(['有剧透', '前方高能预警', '注意前方高能', 'a/[/b', 'ok'].map(t)).toEqual([true, true, false, true, false]);
  });

  it('density is a deterministic share', () => {
    const kept = Array.from({ length: 10000 }, (_, i) => sampled(i, 0.3)).filter(Boolean).length;
    expect(kept).toBeGreaterThan(2800);
    expect(kept).toBeLessThan(3200);
    expect(Array.from({ length: 50 }, (_, i) => sampled(i, 0.3))).toEqual(Array.from({ length: 50 }, (_, i) => sampled(i, 0.3)));
  });
});

describe('renderer policy (ADR-012 §5)', async () => {
  const { decide, POLICY } = await import('../src/policy.js');
  const all = new Set(['canvas2d', 'webgl', 'worker'] as const);
  const frames = (n: number, f: { onStage: number; drawMs: number; intervalMs: number }) => Array.from({ length: n }, () => f);

  it('stays on Canvas 2D while light; WebGL when dense or slow; never within the hold time', () => {
    expect(decide('canvas2d', frames(60, { onStage: 80, drawMs: 1, intervalMs: 16.7 }), 10_000, all)).toBeUndefined();
    expect(decide('canvas2d', frames(60, { onStage: 130, drawMs: 1, intervalMs: 16.7 }), 10_000, all)).toEqual({ to: 'webgl', reason: 'dense: 130 comments on stage (≥ 120)' });
    expect(decide('canvas2d', frames(60, { onStage: 60, drawMs: 5, intervalMs: 16.7 }), 10_000, all)?.reason).toBe('Canvas 2D frame cost p90 5.0 ms (≥ 4)');
    expect(decide('canvas2d', frames(60, { onStage: 130, drawMs: 1, intervalMs: 16.7 }), POLICY.holdMs - 1, all)).toBeUndefined();
    expect(decide('canvas2d', frames(30, { onStage: 130, drawMs: 1, intervalMs: 16.7 }), 10_000, all)).toBeUndefined();
  });

  it('the Worker when the page keeps frames late and our own cost is small; not where it cannot run', () => {
    const busy = frames(60, { onStage: 80, drawMs: 1, intervalMs: 33 });
    expect(decide('webgl', busy, 10_000, all)).toEqual({ to: 'worker', reason: 'main thread busy: frame interval p90 33.0 ms (≥ 25), own cost p90 1.0 ms' });
    // WebGL that costs the main thread as much: off the main thread, or back; not tried again.
    const costly = frames(60, { onStage: 130, drawMs: 6, intervalMs: 16.7 });
    expect(decide('webgl', costly, 10_000, all)).toEqual({ to: 'worker', reason: 'WebGL frame cost p90 6.0 ms (≥ 4): drawing off the main thread', reject: 'webgl' });
    expect(decide('webgl', costly, 10_000, new Set(['canvas2d', 'webgl'] as const))).toEqual({ to: 'canvas2d', reason: 'WebGL frame cost p90 6.0 ms (≥ 4): back to Canvas 2D', reject: 'webgl' });
    expect(decide('canvas2d', busy, 10_000, new Set(['canvas2d', 'webgl'] as const))).toBeUndefined();
    // Dense and late: WebGL first.
    expect(decide('canvas2d', frames(60, { onStage: 130, drawMs: 1, intervalMs: 33 }), 10_000, all)?.to).toBe('webgl');
    expect(decide('canvas2d', busy, 10_000, all)?.to).toBe('worker');
    // Late frames because our own drawing is slow: WebGL, not the Worker.
    expect(decide('canvas2d', frames(60, { onStage: 80, drawMs: 6, intervalMs: 33 }), 10_000, all)?.to).toBe('webgl');
  });

  it('back to Canvas 2D after 600 sparse, unhurried frames', () => {
    expect(decide('webgl', frames(599, { onStage: 10, drawMs: 0.5, intervalMs: 16.7 }), 20_000, all)).toBeUndefined();
    expect(decide('webgl', frames(600, { onStage: 10, drawMs: 0.5, intervalMs: 16.7 }), 20_000, all)).toEqual({ to: 'canvas2d', reason: 'sparse: 10 comments on stage over 600 frames (≤ 40)' });
  });
});

describe('renderer policy on a real GPU (F3)', async () => {
  const { decide } = await import('../src/policy.js');
  const all = new Set(['canvas2d', 'webgl', 'worker'] as const);
  const frames = (n: number, f: { onStage: number; drawMs: number; intervalMs: number }) => Array.from({ length: n }, () => f);
  it('a dense stage at the frame rate stays on main-thread WebGL; the Worker only for a busy main thread', () => {
    expect(decide('webgl', frames(600, { onStage: 150, drawMs: 1, intervalMs: 17 }), 60_000, all)).toBeUndefined();
    expect(decide('webgl', frames(60, { onStage: 150, drawMs: 1, intervalMs: 33 }), 60_000, all)?.to).toBe('worker');
  });
});
