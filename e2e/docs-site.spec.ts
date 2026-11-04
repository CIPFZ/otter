// The generated docs site (ADR-013 batch 4), as the e2e site serves it under /docs/: every page and
// every link resolves, each preset and binding page links to its example on the example page with
// its fixture (e2e/examples.spec.ts runs every example), and a binding's server-rendered example
// page it links to starts its player.
import { expect, test } from './fixtures';
import { EXAMPLE_SOURCES } from './site/examples/sources.ts';

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
    const example = /\/docs\/(?:presets|bindings)\/([a-z-]+)\.html$/.exec(url)?.[1];
    if (example !== undefined) {
      expect(await page.locator('pre code').count(), `${url}: example code`).toBeGreaterThanOrEqual(1);
      const run = new URL(`/examples.html?example=${example}&src=${EXAMPLE_SOURCES[example] ?? ''}`, page.url());
      expect(links.some((l) => l.live && l.href === run.href), `${url}: runs its example (${run.pathname}${run.search})`).toBe(true);
    }
  }
  expect([...seen].filter((u) => u.startsWith('/docs/presets/'))).toHaveLength(10);
  expect([...seen].filter((u) => u.startsWith('/docs/bindings/'))).toHaveLength(3);
  expect([...seen].filter((u) => u.startsWith('/docs/api/')).length).toBeGreaterThan(40);
  test.info().annotations.push({ type: 'pages', description: `${seen.size} pages, ${live.length} live example links` });
});

for (const [name, url] of [['react vod', '/react-vod.html']] as const) {
  test(`docs site: the ${name} example its page links to plays`, async ({ page }) => {
    // The link is on the docs page (not just a URL this test knows).
    await page.goto('/docs/bindings/react.html');
    const href = await page.locator(`a.live[href$="${url.split('/').pop() as string}"]`).first().getAttribute('href');
    expect(href).not.toBeNull();
    await page.goto(new URL(href as string, page.url()).href);
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { examplePlayer?: { store: { getState(): { currentTime: number } } } }).examplePlayer?.store.getState().currentTime ?? 0), { timeout: 20_000 })
      .toBeGreaterThan(0.5);
  });
}
