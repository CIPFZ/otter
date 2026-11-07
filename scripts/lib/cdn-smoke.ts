// Plays the CDN builds from a loopback-only fixture server, as URL imports from jsDelivr.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { chromium, type Browser } from '@playwright/test';

const TYPES: Readonly<Record<string, string>> = { '.js': 'text/javascript', '.css': 'text/css', '.m3u8': 'application/vnd.apple.mpegurl', '.mp4': 'video/mp4', '.m4s': 'video/iso.segment' };

const page = (name: string): string => `<!doctype html><html><head><link rel="stylesheet" href="/cdn/${name}/${name}.css"></head><body><div id="p" style="width:640px;height:360px"></div><script type="module">
import * as m from '/cdn/${name}/${name}.esm.js';
const create = m.createVodPlayer ?? m.createBasicPlayer;
const p = create({ container: document.getElementById('p'), muted: true });
window.p = p;
p.load('/hls-fmp4/master.m3u8', { autoplay: true }).catch((e) => (window.err = String(e)));
</script></body></html>`;

const within = (root: string, file: string): boolean => {
  const rel = relative(root, file);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** Serve only the selected CDN and fixture roots, including after resolving symbolic links. */
export function createCdnSmokeServer(cdnDir: string, mediaDir: string, names: readonly string[]): Server {
  const roots = [['/cdn/', realpathSync(cdnDir)], ['/', realpathSync(mediaDir)]] as const;
  return createServer((req, res) => {
    let url: string;
    try {
      url = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
      if (url.includes('\0')) throw new Error('Invalid path');
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const html = /^\/([\w-]+)\.html$/.exec(url)?.[1];
    if (html !== undefined && names.includes(html)) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(page(html));
      return;
    }
    for (const [prefix, dir] of roots) {
      if (!url.startsWith(prefix)) continue;
      const candidate = resolve(dir, url.slice(prefix.length));
      if (!within(dir, candidate)) continue;
      try {
        if (!existsSync(candidate)) continue;
        const file = realpathSync(candidate);
        if (!within(dir, file) || !statSync(file).isFile()) continue;
        const content = readFileSync(file);
        res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
        res.end(content);
        return;
      } catch {
        // A disappearing fixture is a failed request, not an uncaught server error.
      }
    }
    res.writeHead(404);
    res.end();
  });
}

/** Per build: the playhead after up to 10 s, page errors, chunks fetched. */
export async function cdnSmoke(cdnDir: string, mediaDir: string, names: readonly string[]): Promise<{ name: string; time: number; errors: string[]; chunks: number }[]> {
  const server = createCdnSmokeServer(cdnDir, mediaDir, names);
  let browser: Browser | undefined;
  const results: { name: string; time: number; errors: string[]; chunks: number }[] = [];
  try {
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        done();
      });
    });
    const port = (server.address() as { port: number }).port;
    browser = await chromium.launch();
    for (const name of names) {
      const pg = await browser.newPage();
      const errors: string[] = [];
      let chunks = 0;
      pg.on('pageerror', (e) => errors.push(String(e)));
      pg.on('request', (r) => void (r.url().includes('/chunks/') && chunks++));
      await pg.goto(`http://127.0.0.1:${port}/${name}.html`);
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
    try {
      await browser?.close();
    } finally {
      if (server.listening) await new Promise<void>((done, reject) => server.close((error) => error === undefined ? done() : reject(error)));
    }
  }
  return results;
}
