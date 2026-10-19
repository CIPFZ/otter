// SPEC §19 scenario matrix in a real browser (M1 acceptance: "全场景矩阵能播", stats panel has data,
// router.explain() exports the decision). Each run attaches state, explain() and a screenshot.

import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { SCENARIOS, type Requirement, type Scenario } from './scenarios.ts';
import type { OtterFixture } from './site/player.ts';

test.describe.configure({ timeout: 60_000 });

async function supports(page: Page, req: Requirement): Promise<boolean> {
  return page.evaluate(async (r) => {
    if (r === 'mms') return 'ManagedMediaSource' in window && !('MediaSource' in window);
    if (r === 'hevc') {
      const ms = (window as { MediaSource?: { isTypeSupported(t: string): boolean } }).MediaSource;
      return ms?.isTypeSupported('video/mp4; codecs="hvc1.1.6.L93.90"') === true;
    }
    try {
      await navigator.requestMediaKeySystemAccess('org.w3.clearkey', [
        { initDataTypes: ['cenc', 'keyids'], videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42c01e"' }] },
      ]);
      return true;
    } catch {
      return false;
    }
  }, req);
}

const snapshot = (page: Page) =>
  page.evaluate(async () => {
    const o = (await window.otter) as OtterFixture;
    const s = o.state();
    return {
      status: s.status,
      format: s.format,
      backend: s.backend,
      mms: s.mms,
      remotePlayback: s.remotePlayback,
      paused: s.paused,
      currentTime: s.currentTime,
      videoWidth: s.videoWidth,
      videoHeight: s.videoHeight,
      latency: s.latency,
      live: s.live,
      quality: s.quality,
      activeQuality: s.activeQuality,
      videoTracks: s.tracks.video.map((v) => ({ id: v.id, height: v.height, bitrate: v.bitrate })),
      textTracks: s.tracks.text.length,
      error: s.error === null ? null : { type: s.error.type, details: s.error.details, fatal: s.error.fatal },
      qoe: s.qoe,
      explain: o.explain(),
    };
  });

type Snapshot = Awaited<ReturnType<typeof snapshot>>;

/** Raw <video> state and the last QoE events, for failure messages. */
const elementDiagnostics = (page: Page) =>
  page.evaluate(async () => {
    const v = document.querySelector('video') as HTMLVideoElement;
    const ranges = (r: TimeRanges): string[] => Array.from({ length: r.length }, (_, i) => `${r.start(i).toFixed(2)}-${r.end(i).toFixed(2)}`);
    const o = (await window.otter) as OtterFixture;
    return {
      t: v.currentTime,
      paused: v.paused,
      readyState: v.readyState,
      networkState: v.networkState,
      seeking: v.seeking,
      muted: v.muted,
      rate: v.playbackRate,
      buffered: ranges(v.buffered),
      error: v.error?.code ?? null,
      dropped: v.getVideoPlaybackQuality?.().droppedVideoFrames ?? null,
      decoded: v.getVideoPlaybackQuality?.().totalVideoFrames ?? null,
      events: o.events.slice(-8).map((e) => (e.type === 'error' ? `error:${(e.payload as { error: { details: string } }).error.details}` : e.type)),
    };
  });

/** OTTER_E2E_ABR=engine runs the matrix with the engines' own ABR, for A/B comparison. */
const PLAYER_URL = process.env['OTTER_E2E_ABR'] === 'engine' ? '/player.html?abr=engine' : '/player.html';

async function load(page: Page, scenario: Scenario): Promise<void> {
  await page.goto(PLAYER_URL);
  await page.evaluate(
    async ({ source, asBlob }) => {
      const o = (await window.otter) as OtterFixture;
      // Muted first: unmuted autoplay needs a user gesture (SPEC §3 rule 3).
      o.dispatch('set-muted', { muted: true });
      const src = asBlob ? await o.fetchBlob(source.src) : source.src;
      o.load({ ...source, src } as Parameters<OtterFixture['load']>[0], { autoplay: true });
    },
    { source: scenario.source, asBlob: scenario.asBlob === true },
  );
}

async function settle(page: Page): Promise<Snapshot> {
  await expect.poll(async () => (await snapshot(page)).status, { timeout: 30_000 }).toMatch(/ready|error/);
  return snapshot(page);
}

for (const scenario of SCENARIOS) {
  const title = `${scenario.row} · ${scenario.id}${scenario.network === true ? ' @network' : ''}`;
  test(title, async ({ page }, testInfo) => {
    testInfo.annotations.push({ type: 'spec19', description: scenario.row });
    if (scenario.later !== undefined) testInfo.annotations.push({ type: 'not-in-M1', description: scenario.later });

    const missing: Requirement[] = [];
    for (const r of scenario.requires ?? []) {
      // Navigate first so capability checks run in a real document.
      if (page.url() === 'about:blank') await page.goto('/player.html');
      if (!(await supports(page, r))) missing.push(r);
    }

    await load(page, scenario);
    let state = await settle(page);

    try {
      if (missing.length > 0) {
        testInfo.annotations.push({ type: 'capability-missing', description: missing.join(', ') });
        // Graceful failure: fatal error in the store, and an explanation of every step tried.
        expect(state.status, `expected a graceful failure without ${missing.join(', ')}`).toBe('error');
        expect(state.error?.fatal).toBe(true);
        expect(state.explain?.steps.some((s) => s.outcome === 'failed')).toBe(true);
        expect(state.qoe.errors).toBeGreaterThan(0);
        return;
      }

      expect(state.error?.fatal ?? false, JSON.stringify(state.error)).toBe(false);
      expect(state.status).toBe('ready');
      expect(state.format).toBe(scenario.format);
      expect(state.backend).not.toBeNull();
      expect(state.explain).toMatchObject({ format: scenario.format, backend: state.backend });

      // Playback actually advances and frames are decoded. Measure from the first frame: live
      // streams jump the playhead to the live position on loadedmetadata, before any frame.
      await expect.poll(async () => (await snapshot(page)).qoe.ttff, { timeout: 30_000 }).not.toBeNull();
      const start = (await snapshot(page)).currentTime;
      try {
        await expect.poll(async () => (await snapshot(page)).currentTime - start, { timeout: 20_000 }).toBeGreaterThan(1.5);
      } catch (err) {
        // Say what the element was doing at the moment of failure (WebKit stalls in CI, M2).
        throw new Error(`playhead did not advance from ${start}: ${JSON.stringify(await elementDiagnostics(page))}`, { cause: err });
      }
      state = await snapshot(page);
      expect(state.paused).toBe(false);
      expect(state.videoWidth).toBeGreaterThan(0);
      expect(state.qoe.route?.backend).toBe(state.backend);
      // Native playback exposes no renditions in most browsers (videoTracks is flagged off).
      if (state.videoTracks.length > 0) expect(state.activeQuality, 'the playing rendition is known').not.toBeNull();

      for (const check of scenario.checks ?? []) {
        if (check === 'subtitles') expect(state.textTracks).toBeGreaterThan(0);
        if (check === 'live-latency') {
          // Public live streams over slow links can take a while to report their first sample.
          await expect.poll(async () => (await snapshot(page)).latency, { timeout: 30_000 }).not.toBeNull();
          const latency = (await snapshot(page)).latency ?? Number.NaN;
          expect(latency, 'latency must be a plausible distance to the live edge').toBeLessThan(60);
        }
        if (check === 'quality-switch' && state.videoTracks.length > 1) {
          const target = state.videoTracks.find((v) => v.id !== state.activeQuality) ?? state.videoTracks[0];
          await page.evaluate(async (id) => ((await window.otter) as OtterFixture).dispatch('select-quality', { id }), target?.id ?? 'auto');
          await expect.poll(async () => (await snapshot(page)).activeQuality, { timeout: 15_000 }).toBe(target?.id);
          state = await snapshot(page);
          expect(state.qoe.qualitySwitches).toBeGreaterThan(0);
        }
      }

      // Stats panel renders the same data from the store, and honours [hidden] until toggled.
      const stats = page.locator('otter-stats');
      await expect(stats).toBeHidden();
      await page.locator('#toggle-stats').check();
      await expect(stats).toBeVisible();
      await expect(stats.locator('[data-stat="Format / backend"]')).toContainText(`${scenario.format} / ${state.backend}`);
      await expect(stats.locator('[data-stat="TTFF"]')).not.toHaveText('–');
    } finally {
      await testInfo.attach('state.json', { body: JSON.stringify(await snapshot(page), null, 2), contentType: 'application/json' });
      await testInfo.attach('player.png', { body: await page.locator('#player').screenshot(), contentType: 'image/png' });
    }
  });
}

test('MMS-only environment (iPhone-like): HLS goes native, quality switching needs MMS', async ({ page, browserName }) => {
  test.skip(browserName !== 'webkit', 'ManagedMediaSource exists only in WebKit; real iPhone runs are separate (SPEC §21)');
  // Simulate iPhone: remove MediaSource before any script runs, keep ManagedMediaSource.
  await page.addInitScript(() => {
    delete (window as { MediaSource?: unknown }).MediaSource;
  });
  await page.goto('/player.html');
  test.skip(!(await supports(page, 'mms')), 'this WebKit build has no ManagedMediaSource');

  await page.evaluate(async () => {
    const o = (await window.otter) as OtterFixture;
    o.dispatch('set-muted', { muted: true });
    o.load({ src: '/hls-fmp4/master.m3u8' }, { autoplay: true });
  });
  let state = await settle(page);
  expect(state.explain?.steps).toContainEqual(expect.objectContaining({ candidate: 'platform', reason: expect.stringContaining('native first') }));
  expect(state.backend).toBe('native');

  await page.evaluate(async () => {
    const o = (await window.otter) as OtterFixture;
    await o.setPolicy({ needsQualitySwitch: true });
    o.dispatch('set-muted', { muted: true });
    o.load({ src: '/dash/manifest.mpd' }, { autoplay: true });
  });
  state = await settle(page);
  expect(state).toMatchObject({ status: 'ready', backend: 'mse', mms: true, remotePlayback: 'disabled' });
  expect(state.explain?.steps).toContainEqual(expect.objectContaining({ reason: 'mms: no AirPlay alternate, disableRemotePlayback' }));
});
