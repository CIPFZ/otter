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
  // Playwright over WebDriver BiDi (stock Firefox) does not emulate prefers-reduced-motion.
  test.skip(test.info().project.name === 'real-windows-firefox', 'no reducedMotion emulation through WebDriver BiDi');
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

type Geometry = { thumbX: number; thumbY: number; railY: number; fillEnd: number };

/**
 * Where a slider's thumb, rail and fill are drawn, from its pixels (CSS px from the element's
 * left / top). The thumb is a pseudo-element, so it is painted magenta in one screenshot (fill
 * transparent, rail blue) and hidden in a second (fill green): thumb centroid, rail centre, fill end.
 */
async function sliderGeometry(page: Page, tag: 'otter-time-slider' | 'otter-volume-slider'): Promise<Geometry> {
  const host = page.locator(tag).first();
  const paint = (thumb: boolean) =>
    host.evaluate((el, show) => {
      const root = el.shadowRoot as ShadowRoot;
      root.querySelector('style[data-test]')?.remove();
      const st = document.createElement('style');
      st.setAttribute('data-test', '');
      // One rule per engine prefix: an unknown pseudo-element drops the whole rule.
      st.textContent = `
:host { --otter-thumb-scale: ${show ? 1 : 0} !important; }
input::-webkit-slider-thumb { background: #f0f !important; box-shadow: none !important; transition: none !important; }
input::-moz-range-thumb { background: #f0f !important; box-shadow: none !important; transition: none !important; }
.rail { background: #00f !important; transition: none !important; }
.buffered { background: transparent !important; }
.played { background: ${show ? 'transparent' : '#0f0'} !important; }`;
      root.append(st);
    }, thumb);
  const read = async (): Promise<{ w: number; h: number; dpr: number; px: number[] }> => {
    const png = (await host.screenshot({ animations: 'disabled' })).toString('base64');
    return page.evaluate(async (b64) => {
      const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const c = new OffscreenCanvas(img.width, img.height);
      const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D;
      ctx.drawImage(img, 0, 0);
      return { w: img.width, h: img.height, dpr: devicePixelRatio, px: [...ctx.getImageData(0, 0, img.width, img.height).data] };
    }, png);
  };
  const scan = (shot: { w: number; h: number; px: number[] }, hit: (r: number, g: number, b: number) => boolean) => {
    let n = 0;
    let sx = 0;
    let sy = 0;
    let maxX = -1;
    let minX = Infinity;
    for (let y = 0; y < shot.h; y++)
      for (let x = 0; x < shot.w; x++) {
        const i = (y * shot.w + x) * 4;
        if (!hit(shot.px[i] as number, shot.px[i + 1] as number, shot.px[i + 2] as number)) continue;
        n++;
        sx += x + 0.5;
        sy += y + 0.5;
        maxX = Math.max(maxX, x + 1);
        minX = Math.min(minX, x);
      }
    return { n, cx: sx / n, cy: sy / n, maxX, minX };
  };
  await paint(true);
  const a = await read();
  const thumb = scan(a, (r, g, b) => r > 200 && b > 200 && g < 90);
  const rail = scan(a, (r, g, b) => b > 200 && r < 90 && g < 90);
  await paint(false);
  const b = await read();
  const fill = scan(b, (r, g, bl) => g > 200 && r < 90 && bl < 90);
  const railB = scan(b, (r, g, bl) => bl > 200 && r < 90 && g < 90);
  expect(thumb.n, `${tag}: thumb pixels`).toBeGreaterThan(20);
  // No fill drawn: it ends where the rail starts.
  return { thumbX: thumb.cx / a.dpr, thumbY: thumb.cy / a.dpr, railY: rail.cy / a.dpr, fillEnd: (fill.n > 0 ? fill.maxX : Math.min(railB.minX, fill.minX)) / b.dpr };
}

test('slider thumbs sit on the rail and at the end of the fill: time and volume, at 0 %, 50 % and 100 %', async ({ page }, info) => {
  test.skip(info.project.name.startsWith('emulated'), 'phones hide the volume slider; desktop engines cover the three thumb implementations');
  await ready(page);
  await page.evaluate(() => {
    // The volume slider only opens on hover; open it for the measurement.
    const v = document.querySelector('otter-volume-slider') as HTMLElement;
    v.style.setProperty('--otter-volume-width', '72px');
    v.style.opacity = '1';
  });
  const state = () => page.evaluate(async () => ((await window.otter) as OtterFixture).state());
  const duration = (await state()).duration;
  const rows: string[] = [];
  for (const f of [0, 0.5, 1]) {
    await page.evaluate(async ([t, v]) => {
      const o = (await window.otter) as OtterFixture;
      o.dispatch('pause', undefined);
      o.dispatch('seek', { time: t });
      o.dispatch('set-volume', { volume: v });
    }, [f * duration, f] as const);
    await expect.poll(async () => (await state()).seeking).toBe(false);
    await page.waitForTimeout(200);
    for (const tag of ['otter-time-slider', 'otter-volume-slider'] as const) {
      const g = await sliderGeometry(page, tag);
      rows.push(`${tag} ${f * 100}%: thumb y - rail y ${(g.thumbY - g.railY).toFixed(2)}, thumb x - fill end ${(g.thumbX - g.fillEnd).toFixed(2)}`);
      expect(Math.abs(g.thumbY - g.railY), `${tag} at ${f * 100} %: thumb centre vs rail centre (y)`).toBeLessThanOrEqual(1);
      expect(Math.abs(g.thumbX - g.fillEnd), `${tag} at ${f * 100} %: thumb centre vs fill end (x)`).toBeLessThanOrEqual(1);
    }
  }
  info.annotations.push({ type: 'geometry', description: rows.join(' | ') });
  // For the report: the bar at 50 % with both thumbs shown, as a user sees it on hover.
  for (const tag of ['otter-time-slider', 'otter-volume-slider']) await page.locator(tag).first().evaluate((el) => el.shadowRoot?.querySelector('style[data-test]')?.remove());
  await page.evaluate(async (t) => ((await window.otter) as OtterFixture).dispatch('seek', { time: t }), duration / 2);
  await expect.poll(async () => (await state()).seeking).toBe(false);
  await page.locator('otter-volume-slider').first().evaluate((el) => (el as HTMLElement).style.setProperty('--otter-thumb-scale', '1'));
  await page.locator('otter-time-slider').first().hover();
  await page.waitForTimeout(300);
  const bar = page.locator('#player [data-otter-controls]');
  const shot = `test-results/slider-${info.project.name}.png`;
  await bar.screenshot({ path: shot });
  await info.attach(`slider-${info.project.name}.png`, { path: shot, contentType: 'image/png' });
});
