import { describe, expect, it } from 'vitest';
import type { CmcdState } from '@otter-player/media';
// On-demand module, imported by path (not re-exported from the package index).
import { cmcdKeys, createCmcdDecorator } from '../src/cmcd.js';

const state = (over: Partial<CmcdState> = {}): CmcdState => ({
  format: 'hls',
  live: false,
  lowLatency: false,
  bufferS: 21.3,
  throughputBps: 25_432_000,
  topBitrateBps: 6_000_000,
  playbackRate: 1,
  startup: false,
  starved: false,
  ...over,
});

describe('cmcdKeys (CTA-5004)', () => {
  it('derives media request keys', () => {
    expect(cmcdKeys({ contentId: 'movie-1' }, 'sid-1', state(), { url: 'u', kind: 'video', durationS: 4.004, bitrateBps: 3_200_000 })).toEqual({
      sid: 'sid-1',
      cid: 'movie-1',
      ot: 'v',
      sf: 'h',
      st: 'v',
      br: 3200,
      tb: 6000,
      d: 4004,
      bl: 21300,
      mtp: 25432,
    });
  });

  it('keeps manifest requests to session keys and flags startup / starvation / rate / live', () => {
    const keys = cmcdKeys({}, 's', state({ format: 'dash', live: true, lowLatency: true, startup: true, starved: true, playbackRate: 1.5 }), { url: 'u', kind: 'manifest' });
    expect(keys).toEqual({ sid: 's', ot: 'm', sf: 'd', st: 'll', pr: 1.5, su: true, bs: true });
  });

  it('omits unknown numbers instead of sending NaN', () => {
    const keys = cmcdKeys({}, 's', state({ format: 'flv', throughputBps: Number.NaN, topBitrateBps: Number.NaN }), { url: 'u', kind: 'muxed' });
    expect(keys).toEqual({ sid: 's', ot: 'av', st: 'v', bl: 21300 });
  });
});

describe('createCmcdDecorator', () => {
  it('query mode appends one CMCD parameter (v1 by default)', async () => {
    const d = await createCmcdDecorator({ enabled: true, sessionId: 'abc' }, () => state());
    const out = d.decorate({ url: 'https://cdn.test/seg.m4s?x=1', kind: 'video', bitrateBps: 800_000, durationS: 2 });
    expect(out.headers).toEqual({});
    const cmcd = new URL(out.url).searchParams.get('CMCD');
    expect(new URL(out.url).searchParams.get('x')).toBe('1');
    expect(cmcd).toBe('bl=21300,br=800,d=2000,mtp=25400,ot=v,sf=h,sid="abc",st=v,tb=6000');
  });

  it('headers mode shards keys across the four CMCD headers', async () => {
    const d = await createCmcdDecorator({ enabled: true, mode: 'headers', sessionId: 'abc' }, () => state({ starved: true }));
    const out = d.decorate({ url: 'https://cdn.test/seg.m4s', kind: 'video', bitrateBps: 800_000 });
    expect(out.url).toBe('https://cdn.test/seg.m4s');
    expect(out.headers).toEqual({
      'CMCD-Request': 'bl=21300,mtp=25400',
      'CMCD-Object': 'br=800,ot=v,tb=6000',
      'CMCD-Status': 'bs',
      'CMCD-Session': 'sf=h,sid="abc",st=v',
    });
  });

  it('v2 encodes inner lists and the version key; a random session id is generated', async () => {
    const d = await createCmcdDecorator({ enabled: true, version: 2 }, () => state());
    expect(d.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const cmcd = new URL(d.decorate({ url: 'https://cdn.test/a', kind: 'video', bitrateBps: 800_000 }).url).searchParams.get('CMCD');
    expect(cmcd).toContain('br=(800)');
    expect(cmcd).toContain('v=2');
  });
});
