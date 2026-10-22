// Abandoning a segment download that would not finish in time (own CMAF-HLS engine, ADR-010 §3):
// an on-demand chunk, loaded only for multivariant playlists with more than one variant. Reads the
// response body chunk by chunk and every 100 ms asks hls.js' abandon rules (vendor/hls.js/
// abandon.ts) whether the segment will arrive before the buffer runs out. When not, it cancels the
// download, samples what did arrive into the ABR driver, and throws an AbandonError naming the
// variant to load instead: the highest one whose segment fits in the remaining buffer.

import type { OtterError } from '@otter-player/core';
import { abandonCheck } from '../vendor/hls.js/abandon.js';
import type { EngineInner } from './engine.js';

/** A non-fatal `segmentAbandoned` OtterError naming the variant to load instead. */
export type AbandonError = OtterError & { readonly variant: number };

export interface Abandon {
  /**
   * The body of a segment response of `variant`, or an AbandonError. `began`: performance.now() at
   * the request, `ttfbMs`: when the headers arrived.
   */
  read(res: Response, variant: number, durationS: number, began: number, ttfbMs: number): Promise<ArrayBuffer>;
}

export function createAbandon(e: EngineInner): Abandon {
  const bitrates = e.variants.map((v) => v.bandwidth);
  // Ascending order for the rules: index i -> engine variant order[i].
  const order = bitrates.map((_, i) => i).sort((a, b) => (bitrates[a] as number) - (bitrates[b] as number));
  const ascending = order.map((i) => bitrates[i] as number);
  return {
    async read(res, variant, durationS, began, ttfbMs) {
      const reader = res.body?.getReader();
      if (reader === undefined) return res.arrayBuffer();
      const expected = Number(res.headers.get('content-length')) || (durationS * (bitrates[variant] ?? 0)) / 8;
      const chunks: Uint8Array[] = [];
      let loaded = 0;
      let abandoned: AbandonError | undefined;
      const check = (): void => {
        const media = e.media;
        const driver = e.driver;
        // Upstream's gate: only while playing (a paused player is not starving).
        if (abandoned !== undefined || driver === undefined || media.paused || media.playbackRate === 0 || media.readyState === 0) return;
        const timeLoadingMs = performance.now() - began;
        const d = abandonCheck({
          timeLoadingMs,
          ttfbMs,
          loadedBytes: loaded,
          expectedBytes: Math.max(expected, loaded),
          durationS,
          bufferS: e.aheadS(),
          playbackRate: media.playbackRate,
          bandwidthBps: driver.bandwidth.estimate,
          ttfbEstimateMs: ttfbMs,
          bitrates: ascending,
          level: order.indexOf(variant),
          requiresLevelLoad: (i) => e.isLive() || !e.loaded((e.variants[order[i] as number] as { id: string }).id),
          levelLoadS: ttfbMs / 1000,
        });
        if (d === undefined) return;
        // The partial download is a bandwidth sample (upstream samples it too).
        if (loaded > 0) driver.sampleDownload(timeLoadingMs - ttfbMs, loaded, ttfbMs);
        const target = order[d.level] as number;
        abandoned = Object.assign(
          e.core.createError({
            type: 'network',
            details: 'segmentAbandoned',
            fatal: false,
            recoverable: true,
            message: `abandon: video-${variant} segment needs ${d.fragLoadedDelay.toFixed(1)} s, ${d.bufferS.toFixed(1)} s buffered -> video-${target} (${d.nextLoadDelay.toFixed(1)} s)`,
          }),
          { variant: target },
        );
        void reader.cancel();
      };
      const timer = setInterval(check, 100);
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (abandoned !== undefined) throw abandoned;
          if (done) break;
          chunks.push(value);
          loaded += value.byteLength;
        }
      } finally {
        clearInterval(timer);
      }
      if (abandoned !== undefined) throw abandoned;
      const out = new Uint8Array(loaded);
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.byteLength;
      }
      return out.buffer;
    },
  };
}
