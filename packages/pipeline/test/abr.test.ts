import { describe, expect, it } from 'vitest';
import {
  createAbrController,
  createBolaRule,
  createDefaultAbrController,
  createInsufficientBufferRule,
  createThroughputRule,
  Ewma,
  EwmaBandwidthEstimator,
  levelForBitrate,
  PRIORITY,
  type AbrContext,
  type AbrLevel,
  type AbrRule,
} from '@otter-player/pipeline';
import * as drivers from '@otter-player/pipeline';

const levels: AbrLevel[] = [
  { id: 'l0', bitrate: 300_000 },
  { id: 'l1', bitrate: 800_000 },
  { id: 'l2', bitrate: 1_600_000 },
  { id: 'l3', bitrate: 3_200_000 },
];

const ctx = (over: Partial<AbrContext> = {}): AbrContext => ({
  levels,
  current: 0,
  bufferLevel: 10,
  bufferState: 'loaded',
  throughput: 2_000_000,
  latencyMs: 50,
  segmentDuration: 4,
  live: false,
  lowLatency: false,
  segmentsAppended: 5,
  bufferTarget: 18,
  now: 0,
  ...over,
});

describe('EWMA (hls.js port)', () => {
  it('is unbiased at start and moves toward samples', () => {
    const e = new Ewma(2);
    e.sample(1, 100);
    expect(e.estimate).toBeCloseTo(100);
    e.sample(2, 200);
    expect(e.estimate).toBeGreaterThan(100);
    expect(e.estimate).toBeLessThan(200);
  });

  it('estimator takes min(fast, slow) and falls back to the default', () => {
    const b = new EwmaBandwidthEstimator(15, 4, 500_000);
    expect(b.canEstimate).toBe(false);
    expect(b.bandwidth.estimate).toBe(500_000);
    b.sample(1000, 1_000_000 / 8); // 1 Mbps for 1 s
    b.sample(1000, 4_000_000 / 8); // then 4 Mbps
    const { estimate, fast, slow } = b.bandwidth;
    expect(fast).toBeGreaterThan(slow);
    expect(estimate).toBe(slow);
    b.sample(1000, 250_000 / 8); // sudden drop: fast reacts first
    expect(b.bandwidth.estimate).toBe(b.bandwidth.fast);
    expect(b.bandwidth.fast).toBeLessThan(b.bandwidth.slow);
  });
});

describe('levelForBitrate', () => {
  it('picks the highest level that fits, 0 otherwise', () => {
    expect(levelForBitrate(levels, 1_700_000)).toBe(2);
    expect(levelForBitrate(levels, 100)).toBe(0);
    expect(levelForBitrate(levels, Number.NaN)).toBe(0);
  });
});

describe('ThroughputRule', () => {
  const rule = createThroughputRule();
  it('votes the level that fits 0.9 × throughput once the buffer is loaded', () => {
    // 0.9 × 2 Mbps = 1.8 Mbps -> l2 (1.6 Mbps)
    expect(rule.decide(ctx())).toMatchObject({ level: 2, priority: PRIORITY.default });
    // 0.9 × 1.7 Mbps = 1.53 Mbps -> l1
    expect(rule.decide(ctx({ throughput: 1_700_000 }))?.level).toBe(1);
  });
  it('abstains without an estimate or while loading VOD, but acts while loading live', () => {
    expect(rule.decide(ctx({ throughput: Number.NaN }))).toBeNull();
    expect(rule.decide(ctx({ bufferState: 'loading' }))).toBeNull();
    expect(rule.decide(ctx({ bufferState: 'loading', live: true }))?.level).toBe(2);
  });
});

describe('InsufficientBufferRule', () => {
  const rule = createInsufficientBufferRule();
  it('caps at 0.7 × throughput × buffer / segment duration', () => {
    // 0.7 × 2 Mbps × 2 s / 4 s = 0.7 Mbps -> cap l0
    expect(rule.decide(ctx({ bufferLevel: 2 }))).toMatchObject({ maxLevel: 0 });
    // 0.7 × 2 Mbps × 10 / 4 = 3.5 Mbps -> cap l3
    expect(rule.decide(ctx())).toMatchObject({ maxLevel: 3 });
  });
  it('caps at 0 when the buffer is empty, ignores the first segments and low latency', () => {
    expect(rule.decide(ctx({ bufferState: 'empty' }))).toMatchObject({ maxLevel: 0 });
    expect(rule.decide(ctx({ segmentsAppended: 1 }))).toBeNull();
    expect(rule.decide(ctx({ lowLatency: true }))).toBeNull();
  });
});

describe('BolaRule', () => {
  it('starts from throughput, then goes steady once a segment is buffered', () => {
    const bola = createBolaRule();
    const first = bola.decide(ctx({ bufferLevel: 1 }));
    expect(first?.reason).toMatch(/^startup/);
    expect(first?.level).toBe(2);
    // As upstream: the startup call that sees ≥ 1 segment buffered flips the state; the next call is steady.
    expect(bola.decide(ctx({ bufferLevel: 30, now: 1000 }))?.reason).toMatch(/^startup/);
    const steady = bola.decide(ctx({ bufferLevel: 30, now: 2000 }));
    expect(steady?.reason).toMatch(/^steady/);
  });

  it('prefers higher levels as the buffer grows (steady state)', () => {
    const bola = createBolaRule();
    bola.decide(ctx({ bufferLevel: 5, throughput: 10_000_000 })); // startup -> steady
    const low = bola.decide(ctx({ bufferLevel: 5, current: 0, throughput: 10_000_000, now: 0 }))?.level ?? -1;
    bola.reset?.();
    bola.decide(ctx({ bufferLevel: 5, throughput: 10_000_000 }));
    const high = bola.decide(ctx({ bufferLevel: 40, current: 0, throughput: 10_000_000, now: 0 }))?.level ?? -1;
    expect(high).toBeGreaterThanOrEqual(low);
    expect(high).toBe(3);
  });

  it('BOLA-O: never increases above what the throughput sustains', () => {
    const bola = createBolaRule();
    bola.decide(ctx({ bufferLevel: 5, throughput: 1_000_000 }));
    // Huge buffer would pick l3, but 0.9 Mbps only sustains l1 (and current is l1).
    const v = bola.decide(ctx({ bufferLevel: 60, current: 1, throughput: 1_000_000, now: 0 }));
    expect(v?.level).toBeLessThanOrEqual(1);
  });

  it('abstains for a single-bitrate ladder', () => {
    expect(createBolaRule().decide(ctx({ levels: [{ id: 'x', bitrate: 1 }] }))).toBeNull();
  });
});

describe('DynamicRule (dash.js hybrid strategy)', () => {
  const tagged = (id: string): AbrRule => ({ id, weight: 1, decide: () => ({ level: id === 'bola' ? 3 : 1, priority: PRIORITY.default, reason: id }) });
  it('uses throughput below 12 s, BOLA from 12 s, and back below 6 s only', () => {
    const rule = drivers.createDynamicRule(tagged('throughput'), tagged('bola'));
    const at = (bufferLevel: number): string => rule.decide(ctx({ bufferLevel }))?.reason ?? '';
    expect(at(5)).toBe('throughput: throughput');
    expect(at(11.9)).toBe('throughput: throughput');
    expect(at(12)).toBe('bola: bola');
    expect(at(7)).toBe('bola: bola'); // hysteresis
    expect(at(5.9)).toBe('throughput: throughput');
    expect(at(7)).toBe('throughput: throughput');
  });
});

describe('AbrController', () => {
  const fixed = (id: string, vote: ReturnType<AbrRule['decide']>, weight = 1): AbrRule => ({ id, weight, decide: () => vote });

  it('applies caps before voting and explains the winner', () => {
    const c = createAbrController([
      fixed('up', { level: 3, priority: PRIORITY.default, reason: 'fast net' }),
      fixed('cap', { maxLevel: 1, priority: PRIORITY.default, reason: 'low buffer' }),
    ]);
    const d = c.decide(ctx());
    expect(d.level).toBe(1);
    expect(d.reason).toBe('up: fast net');
    expect(d.votes).toHaveLength(2);
  });

  it('weights × priority decide; ties go to the lower level', () => {
    const tie = createAbrController([
      fixed('a', { level: 3, priority: PRIORITY.default, reason: 'a' }),
      fixed('b', { level: 1, priority: PRIORITY.default, reason: 'b' }),
    ]);
    expect(tie.decide(ctx()).level).toBe(1);
    const strong = createAbrController([
      fixed('a', { level: 3, priority: PRIORITY.strong, reason: 'a' }),
      fixed('b', { level: 1, priority: PRIORITY.default, reason: 'b' }),
    ]);
    expect(strong.decide(ctx()).level).toBe(3);
    const weighted = createAbrController([
      fixed('a', { level: 3, priority: PRIORITY.default, reason: 'a' }, 0.4),
      fixed('b', { level: 1, priority: PRIORITY.default, reason: 'b' }),
    ]);
    expect(weighted.decide(ctx()).level).toBe(1);
  });

  it('keeps the current level when nobody votes, but still honours caps', () => {
    const c = createAbrController([fixed('cap', { maxLevel: 1, priority: PRIORITY.default, reason: 'low' })]);
    expect(c.decide(ctx({ current: 3 }))).toMatchObject({ level: 1, reason: 'capped by cap: low' });
    expect(createAbrController([]).decide(ctx({ current: 2 })).level).toBe(2);
  });

  it('default stack: holds a sustainable level, then steps down on a collapse without rebuffering', () => {
    const c = createDefaultAbrController();
    const est = new EwmaBandwidthEstimator(15, 4, 1_000_000);
    let current = -1;
    let buffer = 0;
    let minBufferAfterStart = Number.POSITIVE_INFINITY;
    const picks: number[] = [];
    // 20 segments at 1.2 Mbps (between l1 0.8 and l2 1.6), then 10 at 0.4 Mbps.
    for (let i = 0; i < 30; i++) {
      const net = i < 20 ? 1_200_000 : 400_000;
      const d = c.decide(ctx({ current, bufferLevel: buffer, bufferState: buffer > 0 ? 'loaded' : 'empty', throughput: est.bandwidth.estimate, segmentsAppended: i, now: i * 4000 }));
      current = d.level;
      c.levelApplied(current);
      picks.push(current);
      const bits = (levels[current] as AbrLevel).bitrate * 4;
      const downloadMs = (bits / net) * 1000;
      est.sample(downloadMs, bits / 8);
      buffer = Math.max(0, buffer + 4 - downloadMs / 1000);
      if (i > 0) minBufferAfterStart = Math.min(minBufferAfterStart, buffer);
    }
    // Between l1 and l2 it holds the sustainable l1 (BOLA-O), no flapping.
    expect(picks.slice(1, 20).every((l) => l === 1)).toBe(true);
    // dash.js hybrid behaviour: a deep buffer is spent at the current level before stepping down,
    // but the buffer never runs dry and the stack ends on the lowest level.
    expect(minBufferAfterStart).toBeGreaterThan(4);
    expect(picks.slice(20)).toContain(0);
    expect(picks.at(-1)).toBe(0);
  });

});

describe('AbrDriver', () => {
  it('maps engine order to bitrate order and back, and reports the bandwidth', () => {
    // Engine lists the ladder top-down; the driver must not care.
    const engineLevels = [levels[3], levels[1], levels[0], levels[2]] as AbrLevel[];
    let t = 0;
    const { createAbrDriver } = drivers;
    const d = createAbrDriver({ now: () => (t += 4000) });
    for (let i = 0; i < 6; i++) {
      d.sampleDownload(1000, 2_000_000 / 8); // 2 Mbps
      d.segmentAppended();
    }
    const decision = d.decide({ levels: engineLevels, current: 2, bufferLevel: 12, segmentDuration: 4, live: false, lowLatency: false, bufferTarget: 18 });
    // 0.9 × 2 Mbps fits 1.6 Mbps (l2), which is engine index 3.
    expect(decision.level).toBe(2);
    expect(decision.engineLevel).toBe(3);
    expect(decision.bandwidth.estimate).toBeCloseTo(2_000_000, -4);
    expect(d.lastDecision).toBe(decision);
  });

  it('uses no throughput before the first sample', () => {
    const d = drivers.createAbrDriver();
    expect(d.canEstimate).toBe(false);
    const decision = d.decide({ levels, current: -1, bufferLevel: 0, segmentDuration: 4, live: false, lowLatency: false, bufferTarget: 18 });
    expect(decision.level).toBe(0);
  });
});
