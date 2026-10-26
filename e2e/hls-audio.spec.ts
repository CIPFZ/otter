// Separate audio renditions on the own CMAF-HLS engine (ADR-010 §3, M5 batch 3): an H.264 ladder
// with English and French audio as their own renditions (EXT-X-MEDIA TYPE=AUDIO URI=...). The own
// engine plays it itself (no hand-off to hls.js): every SourceBuffer is created before the first
// media append, which Chromium requires. Switching the audio track loads the other language's
// segments, playback goes on. Fixture: e2e/media/codecs/h264-audio.m3u8 (generate-codecs.sh).

import { appendFileSync, mkdirSync } from 'node:fs';
import { expect, test } from './fixtures';
import type { OtterFixture } from './site/player.ts';

const ciNotice = (text: string): void => {
  mkdirSync('test-results', { recursive: true });
  appendFileSync('test-results/ci-notices.txt', `${test.info().project.name}: ${text}\n`);
};

test('own engine: separate audio renditions in two languages play directly, the audio track switches', async ({ page }) => {
  test.setTimeout(60_000);
  const requests: string[] = [];
  page.on('request', (r) => {
    const m = /\/codecs\/(audio_(?:en|fr)_(?:\d+\.m4s|init\.mp4))/.exec(r.url());
    if (m !== null) requests.push(m[1] as string);
  });
  await page.goto('/player.html?idle=0');
  await page.evaluate(async () => {
    const o = (await window.otter) as OtterFixture;
    o.dispatch('set-muted', { muted: true });
    o.load({ src: '/codecs/h264-audio.m3u8' }, { autoplay: true });
  });
  const state = () => page.evaluate(async () => ((await window.otter) as OtterFixture).state());
  await expect.poll(async () => (await state()).currentTime, { timeout: 20_000 }).toBeGreaterThan(1);
  let s = await state();
  expect(s.tracks.audio.map((a) => a.language)).toEqual(['en', 'fr']);
  expect(s.tracks.audio.find((a) => a.selected)?.language).toBe('en');
  expect(requests).toContain('audio_en_init.mp4');
  expect(requests.some((r) => r.startsWith('audio_fr'))).toBe(false);
  // Audio is buffered in its own SourceBuffer next to the video's.
  const buffers = await page.evaluate(() => {
    const v = document.querySelector('video') as HTMLVideoElement;
    return { buffered: v.buffered.length > 0 ? v.buffered.end(0) : 0 };
  });
  expect(buffers.buffered).toBeGreaterThan(1);

  const t0 = s.currentTime;
  await page.evaluate(async () => {
    const o = (await window.otter) as OtterFixture;
    const fr = o.state().tracks.audio.find((a) => a.language === 'fr');
    if (fr === undefined) throw new Error('no French rendition');
    o.dispatch('select-audio-track', { id: fr.id });
  });
  await expect.poll(async () => (await state()).tracks.audio.find((a) => a.selected)?.language, { timeout: 10_000 }).toBe('fr');
  await expect.poll(() => requests.some((r) => /^audio_fr_\d+\.m4s$/.test(r)), { timeout: 10_000 }).toBe(true);
  // Playback goes on through the switch.
  await expect.poll(async () => (await state()).currentTime, { timeout: 10_000 }).toBeGreaterThan(t0 + 1);
  s = await state();
  expect(s.paused).toBe(false);
  expect(s.error).toBeNull();
  // The own engine played it: no hand-off, no fatal error on the way.
  const errors = await page.evaluate(async () =>
    ((await window.otter) as OtterFixture).events.filter((e) => e.type === 'error').map((e) => (e.payload as { error: { details: string; fatal: boolean } }).error),
  );
  expect(errors.filter((e) => e.details === 'pipelineFallback' || e.fatal)).toEqual([]);
  expect(s.route?.steps.some((x) => /adapter|hls\.js/.test(x.reason))).toBe(false);
  ciNotice(`separate audio (own engine): en -> fr at ${t0.toFixed(1)} s, ${requests.filter((r) => r.startsWith('audio_fr')).length} French requests, no hand-off`);
});
