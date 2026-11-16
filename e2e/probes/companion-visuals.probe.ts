// Companion mode visual review material (COMPANION.md §6 item 9, owner 2026-11-16): screenshots of
// the companion window's content, in English and Chinese: the host's three first-open sizes
// (pointer in the window), the audio strip, dim 0 / 40 / 80 % (paused, controls hidden) and the
// window's own controls at the smallest size: the two buttons, and the dimming slider opened. Written to test-results/probes/<project>/visuals/. Window sizes are real only in a headed
// browser (RESEARCH §1): run it on real-windows-edge or desktop-chrome-headed.

import { mkdirSync } from 'node:fs';
import type { BrowserContext, BrowserContextOptions, Page } from '@playwright/test';
import { test } from '../fixtures';
import type { Player } from '@otter-player/presets';

const NO_EMULATION = { viewport: null, deviceScaleFactor: undefined, isMobile: undefined, hasTouch: undefined } as unknown as BrowserContextOptions;

for (const lang of ['en', 'zh-CN'] as const) {
  test(`visuals ${lang}`, async ({ page }) => {
    test.setTimeout(240_000);
    const dir = `test-results/probes/${test.info().project.name}/visuals`;
    mkdirSync(dir, { recursive: true });
    const ctx: BrowserContext = await page.context().browser()!.newContext(NO_EMULATION);
    const opener = await ctx.newPage();
    const load = async (size: string): Promise<void> => {
      await opener.goto(`/companion.html?src=/demo/master.m3u8&lang=${lang}&remember=0&size=${size}`);
      await opener.waitForFunction(() => window.player?.store.getState().status === 'ready', undefined, { timeout: 20_000 });
    };
    const set = (p: object) => opener.evaluate((x) => (window.player as Player).store.dispatch('companion-set', x as never), p);
    const media = (type: 'play' | 'pause') => opener.evaluate((t) => (window.player as Player).store.dispatch(t, undefined), type);
    const open = async (): Promise<Page> => {
      const opened = ctx.waitForEvent('page');
      await opener.locator('otter-pip-button').getByRole('button').click();
      const pip = await opened;
      await opener.waitForFunction(() => (window.player as Player).store.getState().presentation.companion.active);
      await pip.waitForTimeout(800);
      return pip;
    };
    const hover = async (pip: Page): Promise<void> => {
      // Top left, over the picture (not the progress bar, whose preview would show).
      await pip.mouse.move(16, 14);
      await pip.mouse.move(20, 18);
      await pip.waitForTimeout(500);
    };
    const back = async (pip: Page): Promise<void> => {
      await hover(pip);
      await pip
        .locator('otter-pip-button')
        .getByRole('button')
        .click()
        .catch((e: unknown) => {
          if (!/closed/.test(String(e))) throw e;
        });
      await opener.waitForFunction(() => !(window.player as Player).store.getState().presentation.companion.active);
    };
    const shot = async (pip: Page, name: string): Promise<void> => {
      const size = await pip.evaluate(() => [innerWidth, innerHeight]);
      console.log(`[${test.info().project.name}] ${lang} ${name}: content ${size.join('x')}`);
      await pip.screenshot({ path: `${dir}/${lang}-${name}.png` });
    };

    // The host's three first-open sizes (the viewer then drags the window's edge), controls shown.
    for (const size of ['s', 'm', 'l'] as const) {
      await load(size);
      await media('play');
      const pip = await open();
      await hover(pip);
      await shot(pip, `size-${size}`);
      await back(pip);
    }
    await load('m');
    await media('play');
    await set({ audioOnly: true, dim: 0.4 });
    let pip = await open();
    await shot(pip, 'audio-strip');
    await back(pip);
    await set({ audioOnly: false });

    // The same still frame for the three dims, controls hidden (pointer elsewhere).
    await opener.evaluate(() => (window.player as Player).store.dispatch('seek', { time: 4 }));
    await media('pause');
    for (const dim of [0, 0.4, 0.8]) {
      await set({ dim });
      pip = await open();
      await pip.waitForTimeout(600);
      await shot(pip, `dim-${Math.round(dim * 100)}`);
      await back(pip);
    }

    // The window's own controls at the smallest size: the dimming slider (keyboard focus on it).
    await load('s');
    await set({ dim: 0.4 });
    pip = await open();
    await hover(pip);
    await shot(pip, 'controls-s');
    // The dimming button pressed: the slider beside it.
    await pip.locator('.ot-dim-toggle').click();
    await pip.waitForTimeout(400);
    await shot(pip, 'dim-slider-s');
    await pip.keyboard.press('Escape');
    await back(pip);
    await ctx.close();
  });
}
