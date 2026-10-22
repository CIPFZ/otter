// Own CMAF-HLS engine (ADR-010) in the player shell: it plays fMP4 HLS itself (no hls.js),
// switches quality at segment boundaries without waiting, seeks, delivers WebVTT subtitle cues,
// and plays a local live stream near HOLD-BACK with a moving DVR window. Streams it leaves out go
// to hls.js and say why (the five classes: e2e/hls-unsupported.spec.ts).

import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { OtterFixture } from './site/player.ts';

const state = (page: Page) =>
  page.evaluate(async () => {
    const o = (await window.otter) as OtterFixture;
    const s = o.state();
    return {
      status: s.status,
      t: s.currentTime,
      paused: s.paused,
      waiting: s.waiting,
      height: s.videoHeight,
      active: s.activeQuality,
      live: s.live,
      latency: s.latency,
      seekable: [s.seekableStart, s.seekableEnd] as [number | null, number | null],
      textTracks: s.textTracks.map((t) => t.id),
      cues: [...document.querySelectorAll<HTMLElement>('[data-cue-id]')].map((el) => el.textContent ?? ''),
      rebuffers: o.events.filter((e) => e.type === 'rebuffer').length,
      tracks: s.tracks,
      errors: o.events.filter((e) => e.type === 'error').map((e) => (e.payload as { error: { details: string } }).error.details),
      steps: s.route?.steps.map((r) => `${r.candidate} ${r.outcome} ${r.reason}`) ?? [],
    };
  });

/** Script URLs the page loaded: hls.js must not be among them on the own engine. */
const scripts = (page: Page): string[] => {
  const seen: string[] = [];
  page.on('request', (r) => {
    if (r.resourceType() === 'script') seen.push(r.url());
  });
  return seen;
};

async function load(page: Page, src: string, autoplay = true): Promise<void> {
  await page.goto('/player.html?idle=0');
  await page.evaluate(
    async ([s, a]) => {
      const o = (await window.otter) as OtterFixture;
      o.dispatch('set-muted', { muted: true });
      o.load({ src: s as string }, { autoplay: a as boolean });
    },
    [src, autoplay] as const,
  );
  await expect.poll(async () => (await state(page)).status, { timeout: 20_000 }).toBe('ready');
}

test('VOD: plays on the own engine, manual switch at a segment boundary, seek, subtitles', async ({ page }) => {
  test.setTimeout(60_000);
  const loaded = scripts(page);
  await load(page, '/hls-fmp4/master.m3u8');
  await expect.poll(async () => (await state(page)).t, { timeout: 15_000 }).toBeGreaterThan(0.5);
  let s = await state(page);
  // Own engine: no fallback step, no hls.js module.
  expect(s.steps.join('\n')).not.toContain('own engine');
  expect(s.errors).toEqual([]);
  expect(loaded.some((u) => /hls(\.light)?(\.min)?\.m?js|hls-[\w-]+\.js/.test(u))).toBe(false);
  expect(s.tracks.video.map((v) => v.height)).toEqual([360, 180]);
  expect(s.seekable).toEqual([0, expect.closeTo(8.02, 1)]);
  // Subtitles: the WebVTT rendition's cues reach the text package, on the media timeline
  // (X-TIMESTAMP-MAP MPEGTS 126000 = +1.4 s: cue one 1.9..4.9 s, cue two 5.4..8.9 s).
  expect(s.tracks.text).toHaveLength(1);
  await page.evaluate(async (id) => ((await window.otter) as OtterFixture).dispatch('select-text-track', { id }), s.textTracks[0] ?? '');
  await page.evaluate(async () => {
    const o = (await window.otter) as OtterFixture;
    o.dispatch('pause', undefined);
    o.dispatch('seek', { time: 2.5 });
  });
  await expect.poll(async () => (await state(page)).cues, { timeout: 10_000 }).toEqual(['Otter test subtitle one']);
  await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('seek', { time: 6 }));
  await expect.poll(async () => (await state(page)).cues, { timeout: 10_000 }).toEqual(['Otter test subtitle two']);
  // Plays on after the seeks.
  await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('play', undefined));
  await expect.poll(async () => (await state(page)).t, { timeout: 10_000 }).toBeGreaterThan(6.3);
  expect((await state(page)).errors).toEqual([]);
});

test('VOD ladder: manual switch down lands without rebuffer; a seek past the buffer loads from there', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/player.html?idle=0&ahead=4');
  await page.evaluate(async () => {
    const o = (await window.otter) as OtterFixture;
    o.dispatch('set-muted', { muted: true });
    o.load({ src: '/frames/hls-ladder/master.m3u8' }, { autoplay: true });
  });
  await expect.poll(async () => (await state(page)).t, { timeout: 20_000 }).toBeGreaterThan(1);
  const low = (await state(page)).tracks.video.find((v) => v.height === 180)?.id as string;
  await page.evaluate(async (id) => ((await window.otter) as OtterFixture).dispatch('select-quality', { id }), low);
  // At most the forward buffer (4 s) plus a segment later.
  await expect.poll(async () => (await state(page)).height, { timeout: 15_000 }).toBe(180);
  let s = await state(page);
  expect(s.rebuffers).toBe(0);
  expect(s.active).toBe(low);
  // Seek far ahead (not buffered): loads from there and plays on.
  await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('seek', { time: 21 }));
  await expect.poll(async () => (await state(page)).t, { timeout: 15_000 }).toBeGreaterThan(21.5);
  s = await state(page);
  expect(s.errors).toEqual([]);
});

test('live: starts about HOLD-BACK behind the edge, the window moves, back to live', async ({ page }) => {
  test.setTimeout(90_000);
  await load(page, '/live-hls/master.m3u8');
  await expect.poll(async () => (await state(page)).t, { timeout: 20_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(3000);
  let s = await state(page);
  expect(s.live).toBe(true);
  expect(s.steps.join('\n')).not.toContain('own engine');
  // HOLD-BACK 6 s; the latency is measured to the playlist edge.
  expect(s.latency).not.toBeNull();
  expect(s.latency as number).toBeGreaterThan(3);
  expect(s.latency as number).toBeLessThan(10);
  const w0 = s.seekable;
  expect(w0[0]).not.toBeNull();
  expect((w0[1] as number) - (w0[0] as number)).toBeGreaterThan(9);
  // The window slides with the stream (a 2 s segment every 2 s).
  await page.waitForTimeout(4500);
  s = await state(page);
  expect(s.seekable[1] as number).toBeGreaterThan((w0[1] as number) + 2);
  // Paused for a while, then back to live: near the target again, playing.
  await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('pause', undefined));
  await page.waitForTimeout(6000);
  expect((await state(page)).latency as number).toBeGreaterThan(10);
  await page.evaluate(async () => {
    const o = (await window.otter) as OtterFixture;
    o.dispatch('seek-to-live', {});
    o.dispatch('play', undefined);
  });
  await expect.poll(async () => (await state(page)).latency as number, { timeout: 10_000 }).toBeLessThan(9);
  s = await state(page);
  expect(s.paused).toBe(false);
  expect(s.errors).toEqual([]);
});

test('TS segments: handed to hls.js, and the route says why', async ({ page }) => {
  await load(page, '/hls-ts/master.m3u8');
  await expect.poll(async () => (await state(page)).t, { timeout: 15_000 }).toBeGreaterThan(0.5);
  const s = await state(page);
  expect(s.steps.some((r) => r.includes('own engine does not support this stream: TS segments'))).toBe(true);
  // hls.js may add its own non-fatal notes (bufferSeekOverHole on TS in Firefox).
  expect(s.errors.filter((d) => d === 'pipelineFallback')).toHaveLength(1);
});
