// Public browser demo. Uses the frozen browser build through its public preset API.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A standalone demo page whose links also work below a GitHub Pages project path. */
export function publicDemoHtml(version: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid browser build version');
  return HTML.replaceAll('__OTTER_VERSION__', version);
}

/** Write the demo after buildDocsSite; its sample is copied by the public-site builder. */
export function writePublicDemo(siteDir: string, version: string): void {
  const dir = join(siteDir, 'demo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), publicDemoHtml(version));
}

const HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Try Otter in your browser with a sample, a local video, or your own media URL.">
<title>Try Otter · Browser demo</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="../browser/__OTTER_VERSION__/otter-vod/otter-vod.css">
<style>
:root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; background: #101c2b; color: #f4f8fc; }
* { box-sizing: border-box; }
body { margin: 0; background: radial-gradient(ellipse at 70% 0, #213b4a 0, transparent 55%); min-height: 100vh; }
a { color: #72eeec; text-underline-offset: 4px; }
a:hover { color: #fff; }
a:focus-visible, button:focus-visible, input:focus-visible { outline: 3px solid #72eeec; outline-offset: 4px; }
.skip { position: absolute; top: -80px; left: 20px; padding: 12px; background: #101c2b; z-index: 10; }
.skip:focus { top: 10px; }
header { max-width: 1120px; margin: auto; padding: 24px; display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.brand { color: #fff; text-decoration: none; font-size: 23px; font-weight: 750; letter-spacing: -.7px; }
.brand span { color: #72eeec; margin-right: 8px; }
nav { display: flex; flex-wrap: wrap; gap: 22px; font-size: 14px; }
nav a { color: #d2deea; text-decoration: none; }
nav a[aria-current] { color: #72eeec; }
main { max-width: 1120px; margin: auto; padding: 28px 24px 64px; }
.eyebrow { color: #72eeec; text-transform: uppercase; font-size: 12px; font-weight: 700; letter-spacing: .13em; }
h1 { font-size: clamp(32px, 5vw, 52px); line-height: 1.12; letter-spacing: -.045em; margin: 12px 0 16px; }
.lead { color: #c1cddd; max-width: 650px; line-height: 1.7; margin: 0 0 28px; }
.player-frame { border: 1px solid #40566c; border-radius: 16px; overflow: hidden; background: #000; box-shadow: 0 24px 64px #0004; }
#player { width: 100%; aspect-ratio: 16 / 9; }
.status-row { display: flex; justify-content: space-between; gap: 16px; align-items: baseline; margin: 14px 0 24px; font-size: 14px; }
#source-status { margin: 0; color: #c1cddd; overflow-wrap: anywhere; }
.version { color: #a9bbcd; white-space: nowrap; font-size: 12px; }
#source-error { background: #412a31; border: 1px solid #ac6b78; border-radius: 10px; padding: 14px 16px; color: #ffe0e5; line-height: 1.6; }
.source-controls { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.card { border: 1px solid #35495e; background: #19293b; border-radius: 14px; padding: 22px; min-width: 0; }
.card h2 { margin: 0 0 10px; font-size: 17px; letter-spacing: -.02em; }
.card p { margin: 0 0 18px; color: #becbd9; font-size: 14px; line-height: 1.6; }
.source-controls button, .file-label { background: #73eeeb; color: #10282d; border: 1px solid transparent; border-radius: 8px; font: inherit; font-size: 14px; font-weight: 650; padding: 11px 16px; cursor: pointer; }
.source-controls button:hover { background: #a4fbf7; }
.source-controls button:disabled, .source-controls input:disabled { cursor: wait; opacity: .65; }
.source-controls input[type="file"] { display: block; max-width: 100%; font: inherit; font-size: 13px; color: #c1cddd; }
.source-controls input::file-selector-button { background: #263e54; color: #f4f8fc; border: 1px solid #58738d; padding: 10px 12px; border-radius: 8px; margin-right: 12px; cursor: pointer; font: inherit; }
.url-card { grid-column: 1 / -1; }
label { display: block; margin: 0 0 10px; font-weight: 600; font-size: 14px; }
.url-row { display: flex; gap: 10px; }
input[type="url"] { flex: 1; min-width: 0; background: #101c2b; color: #f4f8fc; border: 1px solid #58738d; border-radius: 8px; padding: 12px; font: inherit; font-size: 14px; }
input::placeholder { color: #a4b6c9; }
.card .hint { color: #a9bbcd; font-size: 12px; margin: 12px 0 0; }
.release-note { border-top: 1px solid #35495e; margin-top: 30px; padding-top: 20px; color: #a9bbcd; font-size: 13px; line-height: 1.7; }
footer { max-width: 1120px; padding: 0 24px 30px; margin: auto; color: #a9bbcd; font-size: 13px; }
@media (max-width: 620px) { header { align-items: flex-start; } nav { gap: 14px; } main { padding-top: 12px; } .source-controls { grid-template-columns: 1fr; } .url-row { flex-direction: column; } .status-row { flex-direction: column; gap: 6px; } .card { padding: 18px; } }
</style>
</head>
<body>
<a class="skip" href="#main">Skip to demo</a>
<header>
<a class="brand" href="../index.html"><span aria-hidden="true">◉</span>Otter</a>
<nav aria-label="Main navigation"><a href="../index.html">Docs</a><a href="./index.html" aria-current="page">Demo</a><a href="../downloads/index.html">Downloads</a><a href="https://github.com/CIPFZ/otter">GitHub</a></nav>
</header>
<main id="main">
<div class="eyebrow">Made for the web</div>
<h1>Your video. Your player.</h1>
<p class="lead">Try Otter with a short sample, open a video from your device, or load your own stream. Playback starts when you press Play.</p>
<div class="player-frame"><div id="player" data-testid="demo-player" aria-label="Otter video player"></div></div>
<div class="status-row"><p id="source-status" role="status" aria-live="polite">Preparing the sample…</p><span class="version">Browser beta · __OTTER_VERSION__</span></div>
<p id="source-error" role="alert" hidden></p>
<noscript><p>Enable JavaScript to use the player. You can still read the <a href="../index.html">documentation</a> or <a href="../downloads/index.html">download the browser build</a>.</p></noscript>
<section class="source-controls" aria-label="Choose a video">
<div class="card"><h2>Start with the sample</h2><p>A short test clip made for Otter. No account or setup needed.</p><button id="load-sample" data-testid="load-sample" type="button" disabled>Load sample</button></div>
<div class="card"><h2>Open a local video</h2><p>Choose an MP4, WebM or MOV supported by your browser. Your file stays on your device.</p><label for="local-file">Video file</label><input id="local-file" data-testid="local-file" type="file" accept="video/mp4,video/webm,video/quicktime,.mp4,.m4v,.webm,.mov" disabled></div>
<form id="url-form" class="card url-card"><h2>Bring your own stream</h2><p>Open an HTTPS link to an MP4, WebM, HLS or DASH source.</p><label for="media-url">Media URL</label><div class="url-row"><input id="media-url" name="url" type="url" required placeholder="https://example.com/video.mp4" autocomplete="off" spellcheck="false" aria-describedby="url-hint" disabled><button id="load-url" type="submit" disabled>Load URL</button></div><p id="url-hint" class="hint">The server must allow cross-origin playback (CORS). Protected streams that require a sign-in or license are not supported by this demo.</p></form>
</section>
<p class="release-note">The browser demo and downloads are available now. The complete npm release is still in progress; some package installation examples in the docs are not ready to use yet.</p>
</main>
<footer>Open source, built in TypeScript. <a href="../downloads/index.html">Use Otter on your own page →</a></footer>
<script type="module">
const status = document.getElementById('source-status');
const errorBox = document.getElementById('source-error');
const showError = (message, error) => {
  errorBox.textContent = message;
  errorBox.hidden = false;
  if (error !== undefined) console.error(error);
};
async function init() {
  const { createVodPlayer } = await import('../browser/__OTTER_VERSION__/otter-vod/otter-vod.esm.js');
  const player = createVodPlayer({ container: document.getElementById('player'), title: 'Otter demo', lang: 'en' });
  const sample = document.getElementById('load-sample');
  const fileInput = document.getElementById('local-file');
  const urlInput = document.getElementById('media-url');
  const urlButton = document.getElementById('load-url');
  const objectUrls = new Set();
  let currentObjectUrl;
  let generation = 0;
  let closed = false;
  const release = (url) => {
    if (url !== undefined && objectUrls.delete(url)) URL.revokeObjectURL(url);
  };
  const cancelled = (error) => error !== null && typeof error === 'object' && error.name === 'AbortError';
  async function load(source, label, objectUrl) {
    if (closed) { release(objectUrl); return; }
    const request = ++generation;
    const previousUrl = currentObjectUrl;
    currentObjectUrl = objectUrl;
    errorBox.hidden = true;
    errorBox.textContent = '';
    status.textContent = 'Loading ' + label + '…';
    player.store.dispatch('pause', undefined);
    try {
      await player.load(source);
      if (request === generation && !closed) status.textContent = label + ' ready. Press Play in the player.';
    } catch (error) {
      if (request === generation && !closed && !cancelled(error)) {
        status.textContent = 'The video could not be loaded.';
        showError('Try the sample or another video. For a URL, check that the link is public and the server allows cross-origin playback.', error);
      }
    } finally {
      release(previousUrl);
    }
  }
  const off = player.store.subscribe((state) => {
    if (closed || state.error === null || state.error === undefined || !state.error.fatal) return;
    showError('Playback stopped. Try loading the sample or another video.', state.error);
  });
  sample.addEventListener('click', () => { void load({ src: './media/sample.mp4', type: 'video/mp4' }, 'Sample'); });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file === undefined) return;
    const extension = file.name.split('.').pop()?.toLowerCase();
    const types = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };
    const type = /^(video\/(mp4|webm|quicktime))$/i.test(file.type) ? file.type : types[extension];
    if (type === undefined) { showError('Choose an MP4, WebM or MOV file supported by your browser.'); return; }
    const url = URL.createObjectURL(file);
    objectUrls.add(url);
    void load({ src: url, type }, file.name, url);
    fileInput.value = '';
  });
  document.getElementById('url-form').addEventListener('submit', (event) => {
    event.preventDefault();
    let url;
    try { url = new URL(urlInput.value.trim()); } catch { showError('Enter a complete HTTPS media URL.'); return; }
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') { showError('Use an HTTPS media URL without a username or password.'); return; }
    void load(url.href, 'Your video');
  });
  const cleanup = () => {
    if (closed) return;
    closed = true;
    generation++;
    off();
    void player.destroy().catch((error) => { if (!cancelled(error)) console.error(error); });
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls.clear();
  };
  window.addEventListener('pagehide', (event) => { if (!event.persisted) cleanup(); });
  window.addEventListener('pageshow', (event) => { if (event.persisted) player.store.dispatch('pause', undefined); });
  await player.ready;
  if (closed) return;
  for (const control of [sample, fileInput, urlInput, urlButton]) control.disabled = false;
  await load({ src: './media/sample.mp4', type: 'video/mp4' }, 'Sample');
}
void init().catch((error) => {
  status.textContent = 'The player could not start.';
  showError('Reload this page to try again, or download the browser build.', error);
});
</script>
</body>
</html>
`;
