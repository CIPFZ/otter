// DASH with separate audio and video on Shaka (ADR-011 batch 3 item 2, SPEC §19 B 站式弹幕站).
// Fixture e2e/media/dash-av (generate-dash-av.sh): video AdaptationSet H.264 360p / 270p / 180p,
// audio AdaptationSets English and French; codecs.mpd adds an HEVC and an AV1 AdaptationSet.
// - Audio is not part of ABR, and switching video (ABR or manual) never fetches audio again: every
//   audio segment is requested once, and only the playing language's.
// - The audio language switches; video goes on.
// - Video AdaptationSets are filtered by the codec ranking (ADR-011 §5): one family is loaded.

import { appendFileSync, mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { OtterFixture } from './site/player.ts';

const ciNotice = (text: string): void => {
  mkdirSync('test-results', { recursive: true });
  appendFileSync('test-results/ci-notices.txt', `${test.info().project.name}: ${text}\n`);
};

/** Representation ids of the fixture. */
const AUDIO = { en: '5', fr: '6' } as const;
const FAMILY_OF_REP: Record<string, string> = { '0': 'h264', '1': 'h264', '2': 'h264', '3': 'hevc', '4': 'av1' };

interface Fetched {
  rep: string;
  /** Segment number, 0 for the init segment. */
  n: number;
}

function logSegments(page: Page): Fetched[] {
  const log: Fetched[] = [];
  page.on('request', (r) => {
    const m = /\/dash-av\/(?:chunk-(\d)-(\d+)|init-(\d))\.m4s/.exec(r.url());
    if (m !== null) log.push(m[3] !== undefined ? { rep: m[3], n: 0 } : { rep: m[1] as string, n: Number(m[2]) });
  });
  return log;
}

const state = (page: Page) => page.evaluate(async () => ((await window.otter) as OtterFixture).state());

async function load(page: Page, mpd: string): Promise<void> {
  await page.goto('/player.html?idle=0');
  await page.evaluate(async (src) => {
    const o = (await window.otter) as OtterFixture;
    o.dispatch('set-muted', { muted: true });
    o.load({ src }, { autoplay: true });
  }, mpd);
  await expect.poll(async () => (await state(page)).currentTime, { timeout: 20_000 }).toBeGreaterThan(0.5);
}

const audioOf = (log: readonly Fetched[], rep: string): number[] => log.filter((f) => f.rep === rep && f.n > 0).map((f) => f.n);

test('Shaka, separate audio and video: video switches (ABR and manual) never fetch audio again', async ({ page }) => {
  test.setTimeout(60_000);
  const log = logSegments(page);
  await load(page, '/dash-av/manifest.mpd');
  let s = await state(page);
  expect(s).toMatchObject({ format: 'dash', backend: 'mse' });
  expect(s.tracks.video.map((v) => v.height).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([180, 270, 360]);
  expect(s.tracks.audio.map((a) => a.language).sort()).toEqual(['en', 'fr']);
  // Manual switches both ways (Shaka clears the video buffer ahead: video is fetched again, audio not).
  const pick = async (height: number): Promise<void> => {
    await page.evaluate(async (h) => {
      const o = (await window.otter) as OtterFixture;
      const v = o.state().tracks.video.find((t) => t.height === h);
      if (v === undefined) throw new Error(`no ${h}p`);
      o.dispatch('select-quality', { id: v.id });
    }, height);
    await expect.poll(async () => page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).videoHeight), { timeout: 10_000 }).toBe(height);
  };
  await pick(180);
  await pick(360);
  await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('select-quality', { id: 'auto' }));
  await expect.poll(async () => (await state(page)).ended, { timeout: 30_000 }).toBe(true);
  s = await state(page);
  const videoReps = new Set(log.filter((f) => FAMILY_OF_REP[f.rep] !== undefined && f.n > 0).map((f) => f.rep));
  expect(videoReps.size).toBeGreaterThan(1);
  // Audio: English only, every segment once, all six of the clip.
  const en = audioOf(log, AUDIO.en);
  expect(en.length, `audio requests ${JSON.stringify(en)}`).toBe(new Set(en).size);
  expect([...en].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(audioOf(log, AUDIO.fr)).toEqual([]);
  expect(s.error).toBeNull();
  ciNotice(`dash-av: video representations ${[...videoReps].sort().join(', ')}; ${log.filter((f) => FAMILY_OF_REP[f.rep] !== undefined && f.n > 0).length} video and ${en.length} audio segment requests (each audio segment once)`);
});

test('Shaka, separate audio and video: the audio language switches, video goes on', async ({ page }) => {
  test.setTimeout(60_000);
  const log = logSegments(page);
  await load(page, '/dash-av/manifest.mpd');
  expect((await state(page)).tracks.audio.find((a) => a.selected)?.language).toBe('en');
  const t0 = (await state(page)).currentTime;
  await page.evaluate(async () => {
    const o = (await window.otter) as OtterFixture;
    const fr = o.state().tracks.audio.find((a) => a.language === 'fr');
    if (fr === undefined) throw new Error('no French');
    o.dispatch('select-audio-track', { id: fr.id });
  });
  await expect.poll(async () => (await state(page)).tracks.audio.find((a) => a.selected)?.language, { timeout: 10_000 }).toBe('fr');
  await expect.poll(() => audioOf(log, AUDIO.fr).length, { timeout: 10_000 }).toBeGreaterThan(0);
  await expect.poll(async () => (await state(page)).currentTime, { timeout: 10_000 }).toBeGreaterThan(t0 + 1);
  const s = await state(page);
  expect(s.paused).toBe(false);
  expect(s.error).toBeNull();
  // English: every segment at most once. French: likewise, except that Shaka on Firefox restarts the
  // new stream once right after the switch (a deferred buffer clear: the first French segment
  // twice, M5 batch 3 report); nothing else twice.
  const en = audioOf(log, AUDIO.en);
  expect(en.length, `English ${JSON.stringify(en)}`).toBe(new Set(en).size);
  const fr = audioOf(log, AUDIO.fr);
  const twice = fr.filter((n, i) => fr.indexOf(n) !== i);
  expect(twice.length, `French ${JSON.stringify(fr)}`).toBeLessThanOrEqual(1);
  if (twice.length > 0) expect(twice[0], `French ${JSON.stringify(fr)}`).toBe(fr[0]);
  ciNotice(`dash-av language switch: French ${JSON.stringify(fr)}${twice.length > 0 ? ' (first segment restarted by Shaka)' : ''}`);
});

test('Shaka: video AdaptationSets filtered by the codec ranking; one family loads, explained', async ({ page }) => {
  test.setTimeout(60_000);
  const log = logSegments(page);
  await load(page, '/dash-av/codecs.mpd');
  await expect.poll(async () => (await state(page)).currentTime, { timeout: 25_000 }).toBeGreaterThan(1);
  const s = await state(page);
  const steps = s.route?.steps ?? [];
  const failed = steps.filter((x) => x.candidate.startsWith('codec ') && x.outcome === 'failed').map((x) => x.candidate.slice(6));
  expect(s.codec).not.toBeNull();
  const choice = [...steps].reverse().find((x) => x.candidate === `codec ${s.codec}` && x.reason.startsWith("stream offers"));
  expect(choice?.reason).toMatch(new RegExp(`^stream offers .*: ${s.codec} ranks first$`));
  // The tracks Shaka offers are the chosen family only; the media it fetched (after any dropped
  // family's attempt) too.
  for (const t of s.tracks.video) expect(t.codec?.slice(0, 4)).toBe({ h264: 'avc1', hevc: 'hvc1', av1: 'av01', vp9: 'vp09' }[s.codec as string]);
  const media = log.filter((f) => FAMILY_OF_REP[f.rep] !== undefined && f.n > 0).map((f) => FAMILY_OF_REP[f.rep]);
  const afterDrops = media.filter((f) => !failed.includes(f as string));
  expect(new Set(afterDrops)).toEqual(new Set([s.codec]));
  expect(s.error).toBeNull();
  ciNotice(`dash-av codecs: plays ${s.codec}${failed.length > 0 ? ` (no picture from ${failed.join(', ')})` : ''}; video segments from ${[...new Set(media)].join(', ')}`);
});
