// Captions on the picture (ADR-005 §6 acceptance): cue boxes stay inside the picture rectangle
// when the player letterboxes, move up when the control bar shows and back down when it hides,
// and simultaneous cues never overlap.

import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { OtterFixture } from './site/player.ts';

interface Rect {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

/** Cue boxes and the picture rectangle, in player-box coordinates. */
async function layout(page: Page): Promise<{ cues: (Rect & { text: string })[]; picture: Rect; controls: number }> {
  return page.evaluate(async () => {
    const o = (await window.otter) as OtterFixture;
    const player = (document.getElementById('player') as HTMLElement).getBoundingClientRect();
    const rel = (r: DOMRect) => ({ top: r.top - player.top, bottom: r.bottom - player.top, left: r.left - player.left, right: r.right - player.left });
    const p = o.contentRect();
    const controls = document.querySelector('[data-otter-controls]') as HTMLElement;
    return {
      cues: [...document.querySelectorAll<HTMLElement>('[data-cue-id]')].map((el) => ({
        ...rel(el.getBoundingClientRect()),
        text: el.textContent ?? '',
      })),
      picture: { top: p.y, bottom: p.y + p.height, left: p.x, right: p.x + p.width },
      controls: controls.hidden ? 0 : controls.offsetHeight,
    };
  });
}

async function open(page: Page, aspect: string): Promise<void> {
  await page.goto('/player.html');
  await page.evaluate(async (ratio) => {
    (document.getElementById('player') as HTMLElement).style.aspectRatio = ratio;
    const o = (await window.otter) as OtterFixture;
    o.dispatch('set-muted', { muted: true });
    o.load({ src: '/vod/progressive.mp4', textTracks: [{ src: '/subs/sidecar.vtt', language: 'en', label: 'English', default: true }] });
  }, aspect);
  await expect.poll(async () => page.evaluate(async () => ((await window.otter) as OtterFixture).state().status)).toBe('ready');
  await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('seek', { time: 2 }));
  // Wait until the surface has measured the picture and the cues are drawn on it.
  await expect
    .poll(async () => {
      const l = await layout(page);
      return l.cues.length === 3 && l.cues.every((c) => c.top >= l.picture.top - 1 && c.bottom <= l.picture.bottom + 1);
    }, { timeout: 10_000 })
    .toBe(true);
}

const overlap = (a: Rect, b: Rect): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

test('letterbox: cues stay on the picture, not the container', async ({ page }) => {
  await open(page, '4 / 3');
  // Without the control bar: on small screens it covers part of the picture (the safe-area test).
  await page.evaluate(async () => ((await window.otter) as OtterFixture).setControlsVisible(false));
  await expect.poll(async () => Math.max(...(await layout(page)).cues.map((c) => c.bottom))).toBeGreaterThan(0);
  const { cues, picture } = await layout(page);
  // 16:9 media in a 4:3 box: black bars above and below the picture.
  expect(picture.top).toBeGreaterThan(10);
  for (const c of cues) {
    expect(c.top, c.text).toBeGreaterThanOrEqual(picture.top - 1);
    expect(c.bottom, c.text).toBeLessThanOrEqual(picture.bottom + 1);
  }
  const top = cues.find((c) => c.text.includes('top')) as Rect;
  expect(top.top - picture.top).toBeLessThan(picture.bottom - picture.top / 4);
  // The bottom cue sits near the picture's bottom edge, not the container's.
  const lowest = Math.max(...cues.map((c) => c.bottom));
  expect(picture.bottom - lowest).toBeLessThan((picture.bottom - picture.top) * 0.15);
});

test('safe area: cues move up when the control bar shows and back down when it hides', async ({ page }) => {
  await open(page, '16 / 9');
  const lowest = async () => Math.max(...(await layout(page)).cues.map((c) => c.bottom));
  const shown = await layout(page);
  expect(shown.controls).toBeGreaterThan(20);
  const withBar = await lowest();
  const height = shown.picture.bottom;
  expect(withBar).toBeLessThanOrEqual(height - shown.controls + 1.5);

  await page.evaluate(async () => ((await window.otter) as OtterFixture).setControlsVisible(false));
  await expect.poll(lowest).toBeGreaterThan(withBar + shown.controls / 2);
  expect(await lowest()).toBeLessThanOrEqual(height + 1);

  await page.evaluate(async () => ((await window.otter) as OtterFixture).setControlsVisible(true));
  await expect.poll(lowest).toBeLessThanOrEqual(withBar + 1.5);
});

test('simultaneous cues do not overlap', async ({ page }) => {
  await open(page, '16 / 9');
  const { cues } = await layout(page);
  for (let i = 0; i < cues.length; i++) {
    for (let j = i + 1; j < cues.length; j++) expect(overlap(cues[i] as Rect, cues[j] as Rect), `${cues[i]?.text} / ${cues[j]?.text}`).toBe(false);
  }
});

for (const src of ['/hls-ts/master.m3u8', '/hls-fmp4/master.m3u8']) {
  test(`in-band HLS subtitles through hls.js render with the same renderer · ${src}`, async ({ page }) => {
    await page.goto('/player.html');
    await page.evaluate(async (s) => {
      const o = (await window.otter) as OtterFixture;
      o.dispatch('set-muted', { muted: true });
      o.load({ src: s }, { autoplay: true });
    }, src);
    await expect
      .poll(async () => page.evaluate(async () => ((await window.otter) as OtterFixture).state().textTracks.map((t) => `${t.id}:${t.language ?? ''}`)), { timeout: 20_000 })
      .toContain('inband:text-0:en');
    await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('select-text-track', { id: 'inband:text-0' }));
    await expect
      .poll(async () => page.evaluate(() => [...document.querySelectorAll('[data-cue-id]')].map((e) => e.textContent).join('|')), { timeout: 20_000 })
      .toMatch(/Otter test subtitle (one|two)/);
    const { cues, picture } = await layout(page);
    for (const c of cues) expect(c.bottom).toBeLessThanOrEqual(picture.bottom + 1);
    // Captions off: the engine stops delivering and the layer empties.
    await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('toggle-captions', {}));
    await expect.poll(async () => (await layout(page)).cues.length).toBe(0);
  });
}
