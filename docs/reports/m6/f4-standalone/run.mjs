// usage: node run.mjs <playwright module dir> <video.mp4> [firefox executable]   (serves this directory on :8765)
// Opens index.html in each mode for 10 s in the installed release Firefox (WebDriver BiDi) and
// prints the page's rAF interval stats.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const { firefox } = await import(pathToFileURL(join(process.argv[2], 'index.mjs')).href);
const server = createServer((req, res) => {
  const name = new URL(req.url, 'http://x').pathname.slice(1) || 'index.html';
  if (name === 'video.mp4') { res.writeHead(200, { 'content-type': 'video/mp4' }).end(readFileSync(process.argv[3])); return; }
  if (!['index.html', 'worker.js'].includes(name)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': name.endsWith('.js') ? 'text/javascript' : 'text/html' }).end(readFileSync(join(here, name)));
}).listen(8765);
const browser = await firefox.launch({ channel: 'moz-firefox', headless: false, ...(process.argv[4] ? { executablePath: process.argv[4] } : {}) });
console.log('browser', browser.version());
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
for (const run of (process.env.F4_MODES || 'none,webgl-clear,webgl-text,2d-text,none+video,webgl-clear+video,webgl-text+video,2d-text+video').split(',')) {
  const [mode, video] = run.split('+');
  const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
  await page.goto(`http://localhost:8765/?mode=${mode}${video ? '&video=1' : ''}`);
  await new Promise((r) => setTimeout(r, 10_000));
  const r = await Promise.race([page.evaluate(() => window.results), new Promise((r) => setTimeout(() => r(null), 15_000))]);
  if (r === null) console.log(run, 'page.evaluate did not answer within 15 s');
  else {
    const iv = r.intervals;
    console.log(JSON.stringify({ run, error: r.error, frames: iv.length, workerFrames: r.workerFrames, p50: +q(iv, 0.5).toFixed(1), p95: +q(iv, 0.95).toFixed(1), max: +Math.max(...iv).toFixed(1), over50: iv.filter((x) => x > 50).length }));
  }
  await page.close().catch(() => undefined);
}
await browser.close();
server.close();
