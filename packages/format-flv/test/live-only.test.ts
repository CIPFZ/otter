// The WebCodecs FLV demuxer is live-only (ADR-013 §7, owner 2026-10-30): with WebCodecs preferred,
// the same .flv URL routes to WebCodecs when the source is live and to MSE when it is not (VOD
// FLV on WebCodecs is not in 1.0).
import { describe, expect, it } from 'vitest';
import { createRouter, NO_CAPABILITIES, type Capabilities } from '@otter-player/media';
import { createFlvFormat } from '../src/index.js';

const caps: Capabilities = { ...NO_CAPABILITIES, mediaSource: true, webCodecs: true };

describe('FLV on WebCodecs: live only', () => {
  it('routes a live .flv to WebCodecs and the same URL as VOD to MSE, under a policy preferring WebCodecs', () => {
    const format = createFlvFormat();
    const router = createRouter({ formats: [format], backends: ['mse', 'webcodecs'] });
    const policy = { preferBackend: 'webcodecs' } as const;
    expect(router.select({ src: '/cam/a.flv', live: true }, caps, policy).step).toEqual({ backend: 'webcodecs', decoder: 'webcodecs' });
    const vod = router.select({ src: '/cam/a.flv' }, caps, policy);
    expect(vod.step).toEqual({ backend: 'mse' });
    // The format does not offer WebCodecs for it, so the policy's full chain does not apply.
    expect(vod.explanation.steps).toContainEqual({ candidate: 'platform', outcome: 'selected', reason: 'default: MSE first' });
  });

  it('refuses a VOD source in createDemuxer (a host that calls it directly)', async () => {
    const format = createFlvFormat();
    await expect(format.createDemuxer?.({ source: { src: '/cam/a.flv' } } as never)).rejects.toMatchObject({ details: 'liveOnly' });
  });
});
