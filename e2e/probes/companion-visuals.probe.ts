// Companion mode visual review material (COMPANION.md §6 item 9): screenshots of the companion
// window's content, in English and Chinese: the three size steps (pointer in the window), the
// audio strip, dim 0 / 40 / 80 % (paused, controls hidden) and the settings page at the smallest
// step. Written to test-results/probes/<project>/visuals/. Window sizes are real only in a headed
// browser (RESEARCH §1): run it on real-windows-edge or desktop-chrome-headed.

import { mkdirSync } from 'node:fs';
import type { BrowserContext, BrowserContextOptions, Page } from '@playwright/test';
import { test } from '../fixtures';
import type { Player } from '@otter-player/presets';

const NO_EMULATION = { viewport: null, deviceScaleFactor: undefined, isMobile: undefined, hasTouch: undefined } as unknown as BrowserContextOptions;
const ROW: Record<string, RegExp> = { en: /^Floating player/, 'zh-CN': /^悬浮窗/ };

for (const lang of ['en', 'zh-CN'] as const) {
  test(`visuals ${lang}`, async ({ page }) => {
    test.setTimeout(240_000);
    const dir = `test-results/probes/${test.info().project.name}/visuals`;
    mkdirSync(dir, { recursive: true });
    const ctx: BrowserContext = await page.context().browser()!.newContext(NO_EMULATION);
    const opener = await ctx.newPage();
    await opener.goto(`/companion.html?src=/demo/master.m3u8&lang=${lang}&remember=0`);
    await opener.waitForFunction(() => window.player?.store.getState().status === 'ready', undefined, { timeout: 20_000 });
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
      await pip.mouse.move(40, 30);
      await pip.mouse.move(48, 34);
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

    await media('play');
    for (const size of ['s', 'm', 'l'] as const) {
      await set({ size, dim: 0.4, audioOnly: false });
      const pip = await open();
      await hover(pip);
      await shot(pip, `size-${size}`);
      await back(pip);
    }
    await set({ size: 'm', audioOnly: true });
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

    await set({ size: 's', dim: 0.4 });
    pip = await open();
    await hover(pip);
    await pip.locator('otter-settings-menu').getByRole('button').first().click();
    await pip.getByRole('menuitem', { name: ROW[lang] as RegExp }).click();
    await pip.waitForTimeout(600);
    await shot(pip, 'settings-s');
    await pip.keyboard.press('Escape');
    await back(pip);
    await ctx.close();
  });
}
