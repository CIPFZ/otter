// The docs' examples run (e2e/site/examples/, the @example code of createPlayer, the ten presets and
// the three bindings; `pnpm check:docs-site` keeps the TSDoc equal to them): each one, as written,
// on the example page with a fixture source, gets its picture moving without an error.
import { expect, test } from './fixtures';
import keys from './media/keys.json' with { type: 'json' };
import { EXAMPLE_SOURCES } from './site/examples/sources.ts';

test.beforeEach(({}, info) => {
  test.skip(info.project.name !== 'desktop-chrome', 'one browser is enough for the docs examples');
});

type Handle = {
  store?: { getState(): { currentTime: number; error?: unknown }; dispatch(type: string, payload: unknown): boolean };
  tiles?: readonly { store: { getState(): { currentTime: number; error?: unknown } } }[];
};

for (const [name, src] of Object.entries(EXAMPLE_SOURCES)) {
  test(`docs example ${name}: runs as written`, async ({ page }) => {
    if (name === 'ott-drm') {
      await page.addInitScript((k) => {
        (window as { OTTER_DRM?: unknown }).OTTER_DRM = { servers: {}, clearKeys: { [k.kid]: k.key } };
      }, keys['dash-clearkey']);
    }
    await page.goto(`/examples.html?example=${name}&src=${src}`);
    if (name === 'ott-drm') {
      const clearKey = await page.evaluate(async () => {
        try {
          await navigator.requestMediaKeySystemAccess('org.w3.clearkey', [{ initDataTypes: ['cenc', 'keyids'], videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42c01e"' }] }]);
          return true;
        } catch {
          return false;
        }
      });
      test.skip(!clearKey, 'no ClearKey here');
    }
    // The examples load without autoplay (except the wall, the feed and the background video): the
    // viewer's play, through evaluate (a click's worth of user activation), until the load has
    // settled and the picture moves.
    await expect.poll(() => page.evaluate(() => window.docExample !== undefined || document.querySelector('video') !== null || window.docExampleError !== undefined), { timeout: 10_000 }).toBe(true);
    const progress = () =>
      page.evaluate(async () => {
        const h = window.docExample as Handle | undefined;
        const times = [...document.querySelectorAll('video')].map((v) => v.currentTime);
        if (h?.store !== undefined) times.push(h.store.getState().currentTime);
        for (const t of h?.tiles ?? []) times.push(t.store.getState().currentTime);
        const at = Math.max(0, ...times);
        if (at <= 0.5 && h?.tiles === undefined) {
          if (h?.store !== undefined) h.store.dispatch('play', undefined);
          else for (const v of document.querySelectorAll('video')) if (v.paused) await v.play().catch(() => undefined);
        }
        return at;
      });
    await expect.poll(progress, { timeout: 20_000 }).toBeGreaterThan(0.5);
    const errors = await page.evaluate(() => {
      const h = window.docExample as Handle | undefined;
      return [window.docExampleError, h?.store?.getState().error, ...(h?.tiles ?? []).map((t) => t.store.getState().error)].filter((e) => e !== undefined && e !== null).map((e) => JSON.stringify(e));
    });
    expect(errors).toEqual([]);
  });
}
