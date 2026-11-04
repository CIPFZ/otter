// Plays the CDN builds (scripts/build-cdn.ts) in Chromium: a page imports `<name>.esm.js` by URL,
// as a page using jsDelivr would, makes the preset's player and plays the HLS fixture. Used by the
// release dry-run.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { chromium } from '@playwright/test';

const TYPES: Readonly<Record<string, string>> = { '.js': 'text/javascript', '.css': 'text/css', '.m3u8': 'application/vnd.apple.mpegurl', '.mp4': 'video/mp4', '.m4s': 'video/iso.segment' };

const page = (name: string): string => `<!doctype html><html><head><link rel="stylesheet" href="/cdn/${name}/${name}.css"></head><body><div id="p" style="width:640px;height:360px"></div><script type="module">
import * as m from '/cdn/${name}/${name}.esm.js';
const create = m.createVodPlayer ?? m.createBasicPlayer;
const p = create({ container: document.getElementById('p'), muted: true });
window.p = p;
p.load('/hls-fmp4/master.m3u8', { autoplay: true }).catch((e) => (window.err = String(e)));
</script></body></html>`;

/** Per build: the playhead after up to 10 s, page errors, chunks fetched. */
export async function cdnSmoke(cdnDir: string, mediaDir: string, names: readonly string[]): Promise<{ name: string; time: number; errors: string[]; chunks: number }[]> {
  const server = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0] as string;
    const html = /^\/([\w-]+)\.html$/.exec(url)?.[1];
    if (html !== undefined && names.includes(html)) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(page(html));
      return;
    }
    for (const [prefix, dir] of [['/cdn/', cdnDir], ['/', mediaDir]] as const) {
      if (!url.startsWith(prefix)) continue;
      const file = join(dir, url.slice(prefix.length));
      if (existsSync(file) && statSync(file).isFile()) {
        res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
        res.end(readFileSync(file));
        return;
      }
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  const browser = await chromium.launch();
  const results: { name: string; time: number; errors: string[]; chunks: number }[] = [];
  try {
    for (const name of names) {
      const pg = await browser.newPage();
      const errors: string[] = [];
      let chunks = 0;
      pg.on('pageerror', (e) => errors.push(String(e)));
      pg.on('request', (r) => void (r.url().includes('/chunks/') && chunks++));
      await pg.goto(`http://localhost:${port}/${name}.html`);
      let time = 0;
      for (let i = 0; i < 40 && time <= 1; i++) {
        await pg.waitForTimeout(250);
        time = await pg.evaluate(() => (window as unknown as { p?: { store: { getState(): { currentTime: number } } } }).p?.store.getState().currentTime ?? 0);
      }
      const err = await pg.evaluate(() => (window as unknown as { err?: string }).err);
      if (err !== undefined) errors.push(err);
      results.push({ name, time, errors, chunks });
      await pg.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  return results;
}
