import { describe, expect, it } from 'vitest';
import { chooseCodec, codecFamily, keepFamily, rankCodecs } from '../src/codecs.js';

const yes = (smooth = true, powerEfficient = true) => ({ supported: true, smooth, powerEfficient });
const no = { supported: false, smooth: false, powerEfficient: false };

describe('video codec ranking (ADR-011 batch 3)', () => {
  it('power efficient first by default, then smooth, then AV1 > HEVC > VP9 > H.264', () => {
    const r = rankCodecs({ av1: yes(true, false), hevc: no, vp9: yes(true, true), h264: yes(true, true) });
    expect(r.order).toEqual(['vp9', 'h264', 'av1']);
    expect(r.entries).toEqual(['vp09', 'avc1', 'avc3', 'av01']);
    expect(r.steps).toEqual([
      { candidate: 'codec av1', outcome: 'selected', reason: 'decodingInfo: supported, smooth, not power efficient; rank 3 (powerEfficient > smooth > order)' },
      { candidate: 'codec hevc', outcome: 'rejected', reason: 'decodingInfo: not supported' },
      { candidate: 'codec vp9', outcome: 'selected', reason: 'decodingInfo: supported, smooth, power efficient; rank 1 (powerEfficient > smooth > order)' },
      { candidate: 'codec h264', outcome: 'selected', reason: 'decodingInfo: supported, smooth, power efficient; rank 2 (powerEfficient > smooth > order)' },
    ]);
  });

  it('the host sets the order and the criteria', () => {
    const probes = { av1: yes(true, false), hevc: yes(), vp9: yes(), h264: yes() };
    expect(rankCodecs(probes, { order: ['h264'] }).order).toEqual(['h264', 'hevc', 'vp9', 'av1']);
    expect(rankCodecs(probes, { rank: ['order'] }).order).toEqual(['av1', 'hevc', 'vp9', 'h264']);
    expect(rankCodecs(probes, { rank: ['order'], order: ['vp9', 'h264'] }).order).toEqual(['vp9', 'h264', 'av1', 'hevc']);
  });

  it('a user preference comes before the host criteria, among supported families only', () => {
    const probes = { av1: no, hevc: yes(), vp9: yes(true, false), h264: yes() };
    const r = rankCodecs(probes, {}, ['av1', 'vp9']);
    expect(r.order).toEqual(['vp9', 'hevc', 'h264']);
    expect(r.steps[2]?.reason).toContain('user preference av1 > vp9, then powerEfficient > smooth > order');
  });

  it('families from codec strings', () => {
    expect(['avc1.64001f', 'avc3.4d401e', 'hvc1.1.6.L93.B0', 'hev1.2.4.L120.B0', 'vp09.00.31.08', 'av01.0.05M.08', 'mp4a.40.2', 'opus'].map(codecFamily)).toEqual([
      'h264', 'h264', 'hevc', 'hevc', 'vp9', 'av1', undefined, undefined,
    ]);
  });

  it('keeps the best-ranked family a stream offers; tracks without a video codec stay', () => {
    const tracks = [
      { id: 'a', codecs: ['avc1.4d401e', 'mp4a.40.2'] },
      { id: 'b', codecs: 'hvc1.1.6.L63.90,mp4a.40.2' },
      { id: 'c', videoCodec: 'av01.0.01M.08' },
      { id: 'd', codecs: ['mp4a.40.2'] },
    ];
    const choice = chooseCodec(['vp9', 'hevc', 'h264'], tracks);
    expect(choice).toEqual({ family: 'hevc', offered: ['h264', 'hevc', 'av1'], reason: 'stream offers h264, hevc, av1: hevc ranks first' });
    expect(keepFamily(tracks, choice.family).map((t) => t.id)).toEqual(['b', 'd']);
    // Nothing ranked is offered: left to the engine, every track stays.
    const none = chooseCodec(['vp9'], tracks);
    expect(none.family).toBeUndefined();
    expect(keepFamily(tracks, none.family)).toHaveLength(4);
    expect(chooseCodec(['h264'], [{ codecs: ['avc1.42c01e'] }]).reason).toBe('stream offers h264 only');
  });
});

describe('excluded families', () => {
  it('are out of the ranking, with the reason in their step', () => {
    const r = rankCodecs({ av1: yes(), hevc: yes(), vp9: no, h264: yes() }, {}, null, { av1: 'no picture on this device' });
    expect(r.order).toEqual(['hevc', 'h264']);
    expect(r.steps[0]).toEqual({ candidate: 'codec av1', outcome: 'rejected', reason: 'decodingInfo: supported, excluded: no picture on this device' });
  });
});
