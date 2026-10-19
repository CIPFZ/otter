// M2.5 visual system acceptance (UI-DESIGN §11): contrast of the chrome over any picture, motion
// timings and reduced motion, two-level settings menu by keyboard. The look itself is reviewed
// by eye from the screenshots in docs/reports/M2.5.md.

import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { OtterFixture } from './site/player.ts';

async function ready(page: Page, query = '?idle=0'): Promise<void> {
  await page.goto(`/player.html${query}`);
  await page.evaluate(async () => {
    const o = (await window.otter) as OtterFixture;
    o.dispatch('set-muted', { muted: true });
    o.load({ src: '/hls-fmp4/master.m3u8', textTracks: [{ src: '/subs/sidecar.vtt', language: 'en', label: 'English' }] });
  });
  await expect.poll(async () => page.evaluate(async () => ((await window.otter) as OtterFixture).state().status)).toBe('ready');
}

/** WCAG relative luminance of an sRGB colour (0..255 channels). */
const luminance = ([r, g, b]: number[]): number => {
  const c = [r, g, b].map((v) => {
    const x = (v ?? 0) / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0);
};
const ratio = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

for (const [name, background] of [
  ['white frame', '#ffffff'],
  ['black frame', '#000000'],
  ['colour bars', 'linear-gradient(90deg, #fff 0 14%, #ff0 14% 28%, #0ff 28% 42%, #0f0 42% 56%, #f0f 56% 70%, #f00 70% 84%, #00f 84%)'],
] as const) {
  test(`chrome text and icons keep 4.5:1 over a ${name}`, async ({ page }) => {
    await ready(page);
    // The picture becomes `background`; the chrome's own glyphs are hidden so the samples are
    // the scrim-over-picture colour right behind each control.
    const targets = await page.evaluate((bg) => {
      const player = document.getElementById('player') as HTMLElement;
      (player.querySelector('video') as HTMLElement).style.visibility = 'hidden';
      player.style.background = bg;
      const els = [
        ...player.querySelectorAll<HTMLElement>(
          '[data-otter-controls] [data-otter-group] > *:not([data-otter-unsupported]), [data-otter-volume] > otter-mute-button, [data-otter-title], [data-otter-center] > *',
        ),
      ].filter((el) => el.getBoundingClientRect().width > 0 && el.tagName !== 'DIV');
      const pr = player.getBoundingClientRect();
      const out = els.map((el) => {
        const r = el.getBoundingClientRect();
        return { name: el.tagName.toLowerCase() + (el.getAttribute('data-otter-title') !== null ? '[title]' : ''), x: r.left - pr.left + r.width / 2, y: r.top - pr.top + r.height / 2, w: r.width, h: r.height };
      });
      // Hide glyphs only (icons, text), not button backgrounds such as the centre discs.
      for (const el of els) {
        el.style.color = 'transparent';
        el.style.textShadow = 'none';
        for (const g of el.shadowRoot?.querySelectorAll<HTMLElement | SVGElement>('svg, span.n, [part="text"], b') ?? []) g.style.visibility = 'hidden';
        const btn = el.shadowRoot?.querySelector<HTMLElement>('button');
        if (btn !== null && btn !== undefined && btn.classList.contains('text')) btn.style.color = 'transparent';
      }
      return out;
    }, background);
    expect(targets.length).toBeGreaterThanOrEqual(6);
    const png = (await page.locator('#player').screenshot()).toString('base64');
    const samples = await page.evaluate(
      async ({ png, targets }) => {
        const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
        const c = new OffscreenCanvas(img.width, img.height);
        const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D;
        ctx.drawImage(img, 0, 0);
        const scale = img.width / (document.getElementById('player') as HTMLElement).getBoundingClientRect().width;
        // Brightest pixel in the central 60% of each control (where its glyph is drawn): the worst
        // case for white glyphs.
        return targets.map((t) => {
          const w = t.w * 0.6;
          const h = t.h * 0.6;
          const d = ctx.getImageData(Math.round((t.x - w / 2) * scale), Math.round((t.y - h / 2) * scale), Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))).data;
          let best = [0, 0, 0];
          let bestSum = -1;
          for (let i = 0; i < d.length; i += 4) {
            const sum = (d[i] ?? 0) + (d[i + 1] ?? 0) + (d[i + 2] ?? 0);
            if (sum > bestSum) {
              bestSum = sum;
              best = [d[i] ?? 0, d[i + 1] ?? 0, d[i + 2] ?? 0];
            }
          }
          return { name: t.name, rgb: best };
        });
      },
      { png, targets },
    );
    // Glyph colour: --otter-fg (white at 92%) over the sampled background.
    for (const s of samples) {
      const fg = s.rgb.map((v) => 255 * 0.92 + v * 0.08);
      const r = ratio(luminance(fg), luminance(s.rgb));
      expect(r, `${s.name} over rgb(${s.rgb.join(',')})`).toBeGreaterThanOrEqual(4.5);
    }
  });
}

test('motion: show 150 ms ease-out, hide 250 ms ease-in; reduced motion removes transitions', async ({ page }) => {
  await ready(page);
  const timing = () =>
    page.evaluate(() => {
      const bar = document.querySelector('[data-otter-controls]') as HTMLElement;
      const cs = getComputedStyle(bar);
      return { duration: cs.transitionDuration.split(',')[0]?.trim(), easing: cs.transitionTimingFunction.split(', cubic')[0] };
    });
  expect(await timing()).toEqual({ duration: '0.15s', easing: 'cubic-bezier(0.2, 0, 0, 1)' });
  await page.evaluate(async () => ((await window.otter) as OtterFixture).setControlsVisible(false));
  expect((await timing()).duration).toBe('0.25s');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(async () => ((await window.otter) as OtterFixture).setControlsVisible(true));
  const reduced = await page.evaluate(() => {
    const bar = document.querySelector('[data-otter-controls]') as HTMLElement;
    const svg = document.querySelector('otter-play-button')?.shadowRoot?.querySelector('svg') as SVGElement;
    return [getComputedStyle(bar).transitionDuration, getComputedStyle(svg).transitionDuration];
  });
  for (const d of reduced) expect(d.split(',').every((x) => parseFloat(x) === 0), d).toBe(true);
});

test('settings menu: level one -> level two -> back by keyboard, focus never lost', async ({ page }) => {
  await ready(page);
  const trigger = page.locator('otter-settings-menu').locator('button').first();
  await trigger.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Home');
  await expect(page.getByRole('menuitem', { name: /^Quality/ })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('menuitem', { name: 'Back: Quality' })).toBeVisible();
  await expect(page.getByRole('menuitemradio', { name: /Auto/ })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  // Chosen: back on level one, focus on the quality row.
  await expect(page.getByRole('menuitem', { name: /^Quality, 360P/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('menuitem', { name: /^Quality/ })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
});
