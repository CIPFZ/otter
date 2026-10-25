// Codec probing and viewer preferences (ADR-011 batch 3, SPEC §19 B 站式弹幕站).
// - Probing: every load runs MediaCapabilities.decodingInfo for AV1 / HEVC / VP9 / H.264; each
//   result is a router.explain() step, the same as the page measures itself, and the engine plays
//   the best-ranked family the stream offers (default: power efficient, smooth, then AV1 > HEVC >
//   VP9 > H.264), with the choice explained too. Own CMAF-HLS engine and the hls.js adapter.
// - Preferences: codec order, quality, audio and subtitle language, volume and speed are applied
//   again after a reload (localStorage, `otter:` prefix); the position is not stored.
// Fixture: e2e/media/codecs (generate-codecs.sh): H.264 360p / 180p, HEVC, VP9, AV1 360p; audio
// en / fr; WebVTT en / de.

import { appendFileSync, mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { OtterFixture } from './site/player.ts';

const SRC = '/codecs/master.m3u8';
const FAMILY_PROBES: Record<string, string> = {
  av1: 'video/mp4; codecs="av01.0.05M.08"',
  hevc: 'video/mp4; codecs="hvc1.1.6.L93.B0"',
  vp9: 'video/mp4; codecs="vp09.00.31.08"',
  h264: 'video/mp4; codecs="avc1.640028"',
};
const familyOf = (codec: string | undefined): string | undefined =>
  codec === undefined ? undefined : { av01: 'av1', hvc1: 'hevc', hev1: 'hevc', vp09: 'vp9', avc1: 'h264', avc3: 'h264' }[codec.slice(0, 4)];

const ciNotice = (text: string): void => {
  mkdirSync('test-results', { recursive: true });
  appendFileSync('test-results/ci-notices.txt', `${test.info().project.name}: ${text}\n`);
};

const otter = (page: Page) => page.evaluate(async () => ((await window.otter) as OtterFixture).state());

async function loadCodecs(page: Page): Promise<void> {
  await page.evaluate(async (src) => {
    const o = (await window.otter) as OtterFixture;
    o.dispatch('set-muted', { muted: true });
    o.load({ src }, { autoplay: true });
  }, SRC);
  await expect.poll(async () => (await otter(page)).status, { timeout: 20_000 }).toBe('ready');
}

for (const engine of ['otter', 'hlsjs'] as const) {
  test(`${engine === 'otter' ? 'own engine' : 'hls.js'}: decodingInfo per codec family in router.explain(), the best-ranked family offered plays`, async ({ page }) => {
    await page.goto(`/player.html?idle=0${engine === 'hlsjs' ? '&hls=hlsjs' : ''}`);
    await loadCodecs(page);
    try {
      await expect.poll(async () => (await otter(page)).currentTime, { timeout: 15_000 }).toBeGreaterThan(1);
    } catch (err) {
      // For engines we cannot run locally (WebKit): what was chosen and where playback stands.
      const d = await page.evaluate(async () => {
        const o = (await window.otter) as OtterFixture;
        const s = o.state();
        const v = document.querySelector('video') as HTMLVideoElement;
        return {
          codec: s.codec,
          steps: s.route?.steps.filter((x) => x.candidate.startsWith('codec ')).map((x) => `${x.candidate} ${x.outcome}: ${x.reason}`),
          tracks: s.tracks.video.map((t) => t.codec),
          error: s.error?.details ?? null,
          errors: o.events.filter((e) => e.type === 'error').map((e) => (e.payload as { error: { details: string; message?: string } }).error).map((e) => `${e.details}: ${e.message ?? ''}`),
          video: { readyState: v.readyState, paused: v.paused, t: v.currentTime, w: v.videoWidth, buffered: Array.from({ length: v.buffered.length }, (_, i) => `${v.buffered.start(i).toFixed(2)}-${v.buffered.end(i).toFixed(2)}`) },
        };
      });
      ciNotice(`codecs (${engine}) stalled: ${JSON.stringify(d)}`);
      throw err;
    }
    // What the page itself measures, the way the session probes (decodingInfo and isTypeSupported).
    const measured = await page.evaluate(async (probes) => {
      const out: Record<string, { supported: boolean; smooth: boolean; powerEfficient: boolean }> = {};
      const MS = (window as { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource ?? window.MediaSource;
      for (const [f, type] of Object.entries(probes)) {
        const typeSupported = MS?.isTypeSupported(type) === true;
        try {
          const i = await navigator.mediaCapabilities.decodingInfo({ type: 'media-source', video: { contentType: type, width: 1280, height: 720, bitrate: 2_000_000, framerate: 30 } });
          out[f] = { supported: i.supported && typeSupported, smooth: i.smooth, powerEfficient: i.powerEfficient };
        } catch {
          out[f] = { supported: typeSupported, smooth: typeSupported, powerEfficient: false };
        }
      }
      return out;
    }, FAMILY_PROBES);
    const s = await otter(page);
    const steps = s.route?.steps ?? [];
    for (const [f, m] of Object.entries(measured)) {
      const step = steps.find((x) => x.candidate === `codec ${f}` && x.reason.startsWith('decodingInfo'));
      expect(step, `explain step for ${f}`).toBeDefined();
      expect(step?.outcome).toBe(m.supported ? 'selected' : 'rejected');
      if (m.supported) expect(step?.reason).toContain(`${m.smooth ? 'smooth' : 'not smooth'}, ${m.powerEfficient ? 'power efficient' : 'not power efficient'}`);
    }
    // The ranking the steps state, and the family chosen from what the stream offers (all four).
    const rankOf = (f: string): number => Number(/rank (\d+)/.exec(steps.find((x) => x.candidate === `codec ${f}`)?.reason ?? '')?.[1] ?? 99);
    const supported = Object.keys(measured).filter((f) => measured[f]?.supported === true);
    const expected = [...supported].sort((a, b) => rankOf(a) - rankOf(b))[0];
    expect(s.codec).toBe(expected);
    const choice = steps.find((x) => x.candidate === `codec ${expected}` && x.reason.startsWith('stream offers'));
    expect(choice?.reason).toMatch(new RegExp(`^stream offers .*: ${expected} ranks first$`));
    // The engine keeps that family only, and plays it.
    expect(s.tracks.video.length).toBeGreaterThan(0);
    for (const t of s.tracks.video) expect(familyOf(t.codec)).toBe(expected);
    expect(s.error).toBeNull();
    ciNotice(`codecs (${engine}): ${Object.entries(measured).map(([f, m]) => `${f} ${m.supported ? `${m.smooth ? 'smooth' : '-'}/${m.powerEfficient ? 'efficient' : '-'}` : 'no'}`).join(', ')}; plays ${expected}`);
  });
}

test('preferences: codec order, quality, audio / subtitle language, volume and speed are back after a reload; the position is not stored', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/player.html?idle=0&prefs=1');
  await loadCodecs(page);
  await expect.poll(async () => (await otter(page)).textTracks.length, { timeout: 10_000 }).toBeGreaterThan(1);
  // The viewer's choices: H.264, its 180p rendition, French audio, German subtitles, 35 %, 1.5x.
  await page.evaluate(async () => {
    const o = (await window.otter) as OtterFixture;
    o.dispatch('set-codec-preference', { order: ['h264'] });
  });
  // The codec order applies from the next load: reload the source on this page first.
  await loadCodecs(page);
  await expect.poll(async () => (await otter(page)).codec).toBe('h264');
  await expect.poll(async () => (await otter(page)).textTracks.length, { timeout: 10_000 }).toBeGreaterThan(1);
  await page.evaluate(async () => {
    const o = (await window.otter) as OtterFixture;
    const s = o.state();
    const low = s.tracks.video.find((t) => t.height === 180);
    const fr = s.tracks.audio.find((t) => t.language === 'fr');
    const de = s.textTracks.find((t) => t.language === 'de');
    if (low === undefined || fr === undefined || de === undefined) throw new Error(`fixture tracks missing: ${JSON.stringify({ video: s.tracks.video, audio: s.tracks.audio, text: s.textTracks })}`);
    o.dispatch('select-quality', { id: low.id });
    o.dispatch('select-audio-track', { id: fr.id });
    o.dispatch('select-text-track', { id: de.id });
    o.dispatch('set-volume', { volume: 0.35 });
    o.dispatch('set-playback-rate', { rate: 1.5 });
  });
  await page.waitForTimeout(500);
  const stored = await page.evaluate(() => localStorage.getItem('otter:preferences'));
  expect(JSON.parse(stored ?? '{}')).toEqual({ codecs: ['h264'], quality: 180, audioLanguage: 'fr', textLanguage: 'de', volume: 0.35, playbackRate: 1.5 });

  await page.reload();
  await loadCodecs(page);
  const after = async () => {
    const s = await otter(page);
    return {
      codec: s.codec,
      height: s.tracks.video.find((t) => t.id === s.quality)?.height ?? null,
      audio: s.tracks.audio.find((t) => t.selected)?.language ?? null,
      text: s.textTracks.find((t) => t.id === s.textTrack)?.language ?? null,
      volume: s.volume,
      rate: s.playbackRate,
    };
  };
  await expect.poll(after, { timeout: 15_000 }).toEqual({ codec: 'h264', height: 180, audio: 'fr', text: 'de', volume: 0.35, rate: 1.5 });
  // The element follows (what the viewer hears and sees), and the picture is the 180p rendition.
  await expect.poll(async () => page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).videoHeight), { timeout: 15_000 }).toBe(180);
  expect(await page.evaluate(() => ({ v: (document.querySelector('video') as HTMLVideoElement).volume, r: (document.querySelector('video') as HTMLVideoElement).playbackRate }))).toEqual({ v: 0.35, r: 1.5 });
  // Still nothing about where playback was.
  expect(Object.keys(JSON.parse((await page.evaluate(() => localStorage.getItem('otter:preferences'))) ?? '{}')).sort()).toEqual(['audioLanguage', 'codecs', 'playbackRate', 'quality', 'textLanguage', 'volume']);
});
