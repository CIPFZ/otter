// The own CMAF-HLS engine hands a playing stream to hls.js (withAdapterFallback's runtime switch):
// a live playlist whose reloads gain EXT-X-DISCONTINUITY (what the own engine leaves to hls.js,
// ADR-010 §2) mid-stream. format-hls prefetches hls.js once the own engine plays (2026-11-04), so
// the switch does not wait for its download: hls.js is in before the hand-over, and the hand-over
// (the pipelineFallback notice to the playhead advancing in real time again) stays within HANDOVER_MAX_MS.
import { appendFileSync, mkdirSync } from 'node:fs';
import { expect, test } from './fixtures';
import type { OtterFixture } from './site/player.ts';

/**
 * hls.js's script answers this late (a slow network): a hand-over that had to download it would
 * take at least this much longer than one that had it prefetched.
 */
const SCRIPT_DELAY_MS = 3000;
/**
 * Most a hand-over may take, ms: from the own engine's failure to the playhead advancing again.
 * Locally ~2.1 s with the prefetch (hls.js reaching its live start), ≥ 5.1 s without.
 */
const HANDOVER_MAX_MS = 4000;
const HLS_SCRIPT = /\/(hls(\.light)?(\.min)?\.m?js|hls-[\w-]+\.js)(\?|$)/;

const ciNotice = (text: string): void => {
  mkdirSync('test-results', { recursive: true });
  appendFileSync('test-results/ci-notices.txt', `${test.info().project.name}: ${text}\n`);
};

test('live: EXT-X-DISCONTINUITY appears mid-stream, the own engine hands over to hls.js (prefetched), playback goes on', async ({ page }) => {
  test.setTimeout(90_000);
  await page.route(HLS_SCRIPT, async (route) => {
    await new Promise((res) => setTimeout(res, SCRIPT_DELAY_MS));
    await route.continue();
  });
  await page.goto('/player.html?idle=0');
  // The discontinuity marks the first segment published 4 s from now.
  const src = `/live-hls/disc-${Date.now() + 4000}/master.m3u8`;
  await page.evaluate(async (s) => {
    const o = (await window.otter) as OtterFixture;
    o.dispatch('set-muted', { muted: true });
    o.load({ src: s, live: true }, { autoplay: true });
  }, src);
  // In the page: when the own engine played, when it handed over, and when the playhead moved past
  // the hand-over position again; the hls.js script's fetch start, from the resource timing.
  const r = await page.evaluate(async () => {
    const o = (await window.otter) as OtterFixture;
    const video = document.querySelector('video') as HTMLVideoElement;
    const until = async (f: () => boolean, ms: number): Promise<boolean> => {
      const end = performance.now() + ms;
      while (!f()) {
        if (performance.now() > end) return false;
        await new Promise((res) => setTimeout(res, 20));
      }
      return true;
    };
    const handedOver = (): boolean => o.events.some((e) => e.type === 'error' && (e.payload as { error: { details: string; message?: string } }).error.details === 'pipelineFallback');
    const played = await until(() => video.currentTime > 0.5 && !handedOver(), 20_000);
    const playedAt = performance.now();
    // The own engine's MediaSource: hls.js attaches its own (a new blob URL on the element).
    const ownSrc = video.src;
    if (!(await until(handedOver, 40_000))) return { played, handover: false as const };
    const at = performance.now();
    const position = video.currentTime;
    const message = (o.events.find((e) => e.type === 'error' && (e.payload as { error: { details: string } }).error.details === 'pipelineFallback')?.payload as { error: { message?: string } }).error.message ?? '';
    // Playing again: on hls.js's MediaSource (the element keeps playing the own engine's buffer for
    // a while), the first moment from which the playhead advances in real time (≥ 0.15 s of media
    // in the next 250 ms, not paused). A jump (hls.js starting nearer the live edge) is not.
    let movedAt = Number.NaN;
    const deadline = at + 20_000;
    while (performance.now() < deadline) {
      const a = performance.now();
      const from = video.currentTime;
      await new Promise((res) => setTimeout(res, 250));
      const d = video.currentTime - from;
      if (video.src !== ownSrc && video.src !== '' && !video.paused && d >= 0.15 && d <= 0.5) {
        movedAt = a;
        break;
      }
      await new Promise((res) => setTimeout(res, 10));
    }
    const moved = !Number.isNaN(movedAt);
    void position;
    const hls = performance.getEntriesByType('resource').filter((e) => /hls(\.light)?(\.min)?\.m?js|hls-[\w-]+\.js/.test(e.name.split('/').pop() ?? ''));
    return {
      played,
      handover: true as const,
      message,
      moved,
      ms: movedAt - at,
      prefetchedMsBefore: hls.length === 0 ? null : at - Math.min(...hls.map((e) => e.startTime)),
      hlsAfterPlay: hls.every((e) => e.startTime >= playedAt - 1000),
      backend: o.state().backend,
      errors: o.events.filter((e) => e.type === 'error').map((e) => (e.payload as { error: { details: string; fatal: boolean } }).error).filter((e) => e.fatal).map((e) => e.details),
    };
  });
  expect(r.played, 'the own engine played').toBe(true);
  expect(r.handover, 'the own engine handed over').toBe(true);
  if (!r.handover) return;
  ciNotice(`HLS hand-over (live EXT-X-DISCONTINUITY): ${Math.round(r.ms)} ms to playing again; hls.js prefetched ${r.prefetchedMsBefore === null ? 'never' : `${Math.round(r.prefetchedMsBefore)} ms before`}`);
  expect(r.message).toContain('own engine failed during playback: ownEngineUnsupported');
  expect(r.moved, 'playback goes on on hls.js').toBe(true);
  expect(r.backend).toBe('mse');
  expect(r.errors).toEqual([]);
  // Prefetched: hls.js came after the own engine started (not with the page), before the hand-over.
  expect(r.prefetchedMsBefore, 'hls.js fetched before the hand-over').toBeGreaterThan(0);
  expect(r.hlsAfterPlay, 'hls.js not part of the first load').toBe(true);
  expect(r.ms).toBeLessThan(HANDOVER_MAX_MS);
});
