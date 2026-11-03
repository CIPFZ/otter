// The generated docs site (ADR-013 batch 4), as the e2e site serves it under /docs/: every page and
// every link resolves, each preset and binding page links to its example page, and those example
// pages (the e2e site's, with its fixtures) start their players.
import { expect, test } from './fixtures';

test.beforeEach(({}, info) => {
  test.skip(info.project.name !== 'desktop-chrome', 'one browser is enough for the docs pages');
});

test('docs site: every internal link resolves; preset and binding pages carry an example and a live link', async ({ page }) => {
  test.setTimeout(120_000);
  const seen = new Set<string>();
  const queue = ['/docs/index.html'];
  const live: string[] = [];
  while (queue.length > 0) {
    const url = queue.shift() as string;
    if (seen.has(url)) continue;
    seen.add(url);
    const res = await page.goto(url);
    expect(res?.status(), url).toBe(200);
    if (!url.startsWith('/docs/')) continue;
    const links = await page.locator('a[href]').evaluateAll((as) => as.map((a) => ({ href: (a as HTMLAnchorElement).href, live: a.classList.contains('live') })));
    for (const l of links) {
      const u = new URL(l.href);
      if (u.origin !== new URL(page.url()).origin) continue;
      if (l.live) live.push(u.pathname + u.search);
      else if (u.pathname.startsWith('/docs/')) queue.push(u.pathname);
    }
    if (/\/docs\/(presets|bindings)\//.test(url)) {
      expect(await page.locator('pre code').count(), `${url}: example code`).toBeGreaterThanOrEqual(1);
      expect(await page.locator('a.live').count(), `${url}: live example link`).toBeGreaterThanOrEqual(1);
    }
  }
  expect([...seen].filter((u) => u.startsWith('/docs/presets/'))).toHaveLength(10);
  expect([...seen].filter((u) => u.startsWith('/docs/bindings/'))).toHaveLength(3);
  expect([...seen].filter((u) => u.startsWith('/docs/api/')).length).toBeGreaterThan(40);
  test.info().annotations.push({ type: 'pages', description: `${seen.size} pages, ${live.length} live example links` });
});

for (const [name, url] of [
  ['basic', '/presets.html?preset=basic&src=/hls-fmp4/master.m3u8'],
  ['vod', '/presets.html?preset=vod&src=/hls-fmp4/master.m3u8'],
  ['react vod', '/react-vod.html'],
] as const) {
  test(`docs site: the ${name} example its page links to plays`, async ({ page }) => {
    await page.goto('/docs/index.html');
    // The link is on the docs page (not just a URL this test knows).
    const from = name.startsWith('react') ? '/docs/bindings/react.html' : `/docs/presets/${name}.html`;
    await page.goto(from);
    const href = await page.locator(`a.live[href$="${url.split('/').pop() as string}"]`).first().getAttribute('href');
    expect(href).not.toBeNull();
    await page.goto(new URL(href as string, page.url()).href);
    await expect
      .poll(() => page.evaluate(() => { const w = window as unknown as { preset?: { store: { getState(): { currentTime: number } } }; examplePlayer?: { store: { getState(): { currentTime: number } } } }; return (w.preset ?? w.examplePlayer)?.store.getState().currentTime ?? 0; }), { timeout: 20_000 })
      .toBeGreaterThan(0.5);
  });
}
