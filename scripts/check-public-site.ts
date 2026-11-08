// Verify the complete Pages artifact, then optionally play its demo under the /otter/ project path.
// node scripts/check-public-site.ts [docs-site/dist] [--browser] [--url https://cipfz.github.io/otter/]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { crc32 } from 'node:zlib';
import { Window } from 'happy-dom';
import ts from 'ts5';
import { chromium, type Browser, type Page } from '@playwright/test';

const root = resolve(import.meta.dirname, '..');
let directory: string | undefined;
let browserCheck = false;
let remoteBase: string | undefined;
let screenshotDir: string | undefined;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i] as string;
  if (arg === '--browser') browserCheck = true;
  else if (arg === '--url') {
    remoteBase = args[++i];
    assert(remoteBase !== undefined && /^https?:\/\//.test(remoteBase), '--url needs an HTTP(S) base URL');
    browserCheck = true;
  } else if (arg === '--screenshot-dir') {
    screenshotDir = args[++i];
    assert(screenshotDir !== undefined && isAbsolute(screenshotDir), '--screenshot-dir needs an absolute directory outside the repository');
    browserCheck = true;
  } else {
    assert(!arg.startsWith('-') && directory === undefined, 'Unknown argument: ' + arg);
    directory = arg;
  }
}
const site = realpathSync(resolve(root, directory ?? 'docs-site/dist'));
const manifest = JSON.parse(readFileSync(join(root, 'packages/cdn/package.json'), 'utf8')) as { version: string };
const version = manifest.version;
assert(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version), 'Invalid browser version');
const browserDir = 'browser/' + version;
const archiveName = 'otter-browser-' + version;
const archivePath = 'downloads/' + archiveName + '.zip';
const projectBase = new URL('https://otter.invalid/otter/');
const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');
const within = (base: string, file: string): boolean => {
  const rel = relative(base, file);
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
};
const bytes = (file: string): Buffer => readFileSync(join(site, file));
if (screenshotDir !== undefined) {
  screenshotDir = resolve(screenshotDir);
  assert(!within(root, screenshotDir) && !within(site, screenshotDir), 'Screenshots must be outside the repository and site artifact');
}

function filesAt(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    assert(!entry.isSymbolicLink(), 'Site artifacts must not contain symbolic links: ' + entry.name);
    const file = join(dir, entry.name);
    return entry.isDirectory() ? filesAt(file) : [relative(site, file).split(sep).join('/')];
  }).sort();
}

let references = 0;
/** Resolve as a browser would at a project-site URL, then enforce the artifact boundary. */
function localReference(value: string, from: string, module = false): void {
  const text = value.trim();
  if (text === '' || text.startsWith('#') || /^(?:data|blob|mailto|tel):/i.test(text)) return;
  assert(!text.includes('\\'), 'Backslash URL in ' + from + ': ' + text);
  if (module) assert(text.startsWith('.') || text.startsWith('/'), 'External or bare module in ' + from + ': ' + text);
  const url = new URL(text, new URL(from, projectBase));
  if (url.origin !== projectBase.origin) {
    assert(!module && /^https?:$/.test(url.protocol), 'Unsupported URL in ' + from + ': ' + text);
    return;
  }
  assert(url.pathname.startsWith(projectBase.pathname), 'URL escapes /otter/ in ' + from + ': ' + text);
  let target = resolve(site, decodeURIComponent(url.pathname.slice(projectBase.pathname.length)));
  assert(within(site, target) && existsSync(target), 'Missing local target in ' + from + ': ' + text);
  if (statSync(target).isDirectory()) target = join(target, 'index.html');
  assert(existsSync(target) && statSync(target).isFile() && within(site, realpathSync(target)), 'Invalid local target: ' + text);
  references++;
}

function checkModule(text: string, file: string): void {
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
      assert(ts.isStringLiteralLike(node.moduleSpecifier), 'Nonliteral module in ' + file);
      localReference(node.moduleSpecifier.text, file, true);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = node.arguments[0];
      assert(specifier !== undefined && ts.isStringLiteralLike(specifier), 'Computed import in ' + file);
      localReference(specifier.text, file, true);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
}

function checkCss(text: string, file: string): void {
  for (const match of text.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)) localReference(match[2] ?? '', file);
  for (const match of text.matchAll(/@import\s+(['"])(.*?)\1/g)) localReference(match[2] ?? '', file);
}

async function checkHtml(file: string): Promise<void> {
  const window = new Window({ settings: { enableJavaScriptEvaluation: false, disableJavaScriptFileLoading: true, enableCSSFileLoading: false, enableImageFileLoading: false, enableIframePageLoading: false } });
  try {
    const document = new window.DOMParser().parseFromString(bytes(file).toString('utf8'), 'text/html');
    assert(document.querySelector('base') === null, 'Unexpected base element in ' + file);
    for (const element of document.querySelectorAll('[href], [src], [poster]')) {
      for (const attribute of ['href', 'src', 'poster']) {
        const value = element.getAttribute(attribute);
        if (value !== null) localReference(value, file);
      }
    }
    for (const element of document.querySelectorAll('[srcset]')) {
      const srcset = element.getAttribute('srcset') ?? '';
      if (!srcset.trim().startsWith('data:')) for (const item of srcset.split(',')) localReference(item.trim().split(/\s+/)[0] ?? '', file);
    }
    for (const script of document.querySelectorAll('script[type="module"]:not([src])')) checkModule(script.textContent, file);
    for (const style of document.querySelectorAll('style')) checkCss(style.textContent, file);
  } finally {
    await window.happyDOM.close();
  }
}

/** Read the builder's UTF-8, stored ZIP without extracting anything onto the filesystem. */
function readArchive(data: Buffer): Map<string, Buffer> {
  let end = -1;
  for (let at = data.length - 22; at >= Math.max(0, data.length - 65557); at--) {
    if (data.readUInt32LE(at) === 0x06054b50 && at + 22 + data.readUInt16LE(at + 20) === data.length) { end = at; break; }
  }
  assert(end >= 0, 'ZIP end record missing');
  assert(data.readUInt16LE(end + 4) === 0 && data.readUInt16LE(end + 6) === 0, 'Multi-disk ZIP is unsupported');
  const count = data.readUInt16LE(end + 10);
  assert(count > 0 && count !== 0xffff && data.readUInt16LE(end + 8) === count, 'Invalid ZIP entry count');
  let offset = data.readUInt32LE(end + 16);
  const centralEnd = offset + data.readUInt32LE(end + 12);
  assert(centralEnd === end, 'Invalid ZIP central directory bounds');
  const result = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    assert(offset + 46 <= centralEnd && data.readUInt32LE(offset) === 0x02014b50, 'Invalid ZIP directory entry');
    const flags = data.readUInt16LE(offset + 8);
    const method = data.readUInt16LE(offset + 10);
    const checksum = data.readUInt32LE(offset + 16);
    const size = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const local = data.readUInt32LE(offset + 42);
    assert(method === 0 && (flags & 1) === 0 && data.readUInt32LE(offset + 20) === size, 'ZIP entry must be stored and unencrypted');
    assert(offset + 46 + nameLength + extraLength + commentLength <= centralEnd, 'Truncated ZIP directory');
    const name = data.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    assert(name.startsWith(archiveName + '/') && !name.includes('\\') && !name.split('/').includes('..'), 'Unsafe ZIP entry: ' + name);
    assert(!result.has(name), 'Duplicate ZIP entry: ' + name);
    assert(local + 30 <= data.length && data.readUInt32LE(local) === 0x04034b50, 'Missing ZIP local header');
    const localNameLength = data.readUInt16LE(local + 26);
    const localExtraLength = data.readUInt16LE(local + 28);
    const start = local + 30 + localNameLength + localExtraLength;
    assert(start + size <= data.readUInt32LE(end + 16), 'ZIP payload overlaps directory');
    assert(data.subarray(local + 30, local + 30 + localNameLength).toString('utf8') === name, 'ZIP header name mismatch');
    assert(data.readUInt16LE(local + 8) === method && data.readUInt32LE(local + 14) === checksum && data.readUInt32LE(local + 22) === size, 'ZIP local metadata mismatch');
    const payload = data.subarray(start, start + size);
    assert(crc32(payload) === checksum, 'ZIP CRC mismatch: ' + name);
    if (!name.endsWith('/')) result.set(name, payload);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  assert(offset === centralEnd, 'ZIP directory size mismatch');
  return result;
}

const required = ['index.html', 'api/core.html', 'demo/index.html', 'demo/media/sample.mp4', 'demo/media/README.md', 'downloads/index.html', archivePath, archivePath + '.sha256'];
for (const name of ['otter-basic', 'otter-vod']) {
  required.push(browserDir + '/' + name + '/' + name + '.esm.js', browserDir + '/' + name + '/' + name + '.css');
  assert(filesAt(join(site, browserDir, name, 'chunks')).some((file) => file.endsWith('.js')), 'Missing chunks for ' + name);
}
for (const file of required) assert(existsSync(join(site, file)) && statSync(join(site, file)).isFile(), 'Missing public artifact: ' + file);
for (const file of filesAt(site)) {
  if (file.endsWith('.html')) await checkHtml(file);
  else if (file.endsWith('.js')) checkModule(bytes(file).toString('utf8'), file);
  else if (file.endsWith('.css')) checkCss(bytes(file).toString('utf8'), file);
}
const browserFiles = filesAt(join(site, browserDir));
for (const license of ['LICENSE', 'NOTICE']) {
  assert(bytes(browserDir + '/' + license).equals(readFileSync(join(root, 'packages/cdn', license))), 'Incomplete browser ' + license);
}
assert(bytes(browserDir + '/README.md').length > 0, 'Browser README is empty');
const manifestLines = bytes(browserDir + '/SHA256SUMS').toString('utf8').trim().split(/\r?\n/);
const expectedManifest = browserFiles.filter((file) => file !== browserDir + '/SHA256SUMS').map((file) => sha256(bytes(file)) + '  ' + file.slice(browserDir.length + 1)).sort();
assert.deepEqual(manifestLines.sort(), expectedManifest, 'Browser checksum manifest does not cover the exact artifact');
const zip = bytes(archivePath);
assert.equal(bytes(archivePath + '.sha256').toString('utf8').trim(), sha256(zip) + '  ' + archiveName + '.zip', 'Download checksum mismatch');
const entries = readArchive(zip);
assert.equal(entries.size, browserFiles.length, 'ZIP file count differs from browser artifact');
for (const file of browserFiles) {
  const name = archiveName + '/' + file.slice(browserDir.length + 1);
  assert(entries.get(name)?.equals(bytes(file)), 'ZIP differs from browser artifact: ' + name);
}
console.log('✓ public site: ' + references + ' local references; ' + browserFiles.length + ' browser files; ZIP, checksums and licenses match');

const TYPES: Readonly<Record<string, string>> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.mp4': 'video/mp4', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.txt': 'text/plain', '.md': 'text/plain', '.zip': 'application/zip' };
function createSiteServer(): Server {
  return createServer((req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
      if (!pathname.startsWith('/otter/') || pathname.includes('\0')) { res.writeHead(404).end(); return; }
      let file = resolve(site, pathname.slice('/otter/'.length));
      if (!within(site, file) || !existsSync(file)) { res.writeHead(404).end(); return; }
      if (statSync(file).isDirectory()) file = join(file, 'index.html');
      if (!existsSync(file) || !within(site, realpathSync(file)) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
      const content = readFileSync(file);
      const headers = { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'accept-ranges': 'bytes' };
      const range = req.headers.range;
      if (range !== undefined) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (match === null || (match[1] === '' && match[2] === '')) { res.writeHead(416).end(); return; }
        const start = match[1] === '' ? Math.max(0, content.length - Number(match[2])) : Number(match[1]);
        const end = match[1] === '' || match[2] === '' ? content.length - 1 : Math.min(Number(match[2]), content.length - 1);
        if (start > end || start >= content.length) { res.writeHead(416, { 'content-range': 'bytes */' + content.length }).end(); return; }
        res.writeHead(206, { ...headers, 'content-length': end - start + 1, 'content-range': 'bytes ' + start + '-' + end + '/' + content.length });
        res.end(req.method === 'HEAD' ? undefined : content.subarray(start, end + 1));
      } else {
        res.writeHead(200, { ...headers, 'content-length': content.length });
        res.end(req.method === 'HEAD' ? undefined : content);
      }
    } catch {
      res.writeHead(400).end();
    }
  });
}

async function playAndAdvance(page: Page, label: string): Promise<void> {
  const video = page.locator('#player video').first();
  const before = await video.evaluate((element) => (element as HTMLVideoElement).currentTime);
  await page.locator('#player [data-otter-controls] otter-play-button button').click();
  await page.waitForFunction((start) => {
    const element = document.querySelector<HTMLVideoElement>('#player video');
    return element !== null && !element.paused && element.currentTime > start + 0.5 && element.videoWidth > 0;
  }, before, { timeout: 15_000 });
  const time = await video.evaluate((element) => (element as HTMLVideoElement).currentTime);
  assert(await page.locator('#source-error').isHidden(), label + ' reports a source error');
  console.log('✓ demo ' + label + ': playhead advanced to ' + time.toFixed(2) + ' s');
}

if (browserCheck) {
  let server: Server | undefined;
  let browser: Browser | undefined;
  try {
    let base: URL;
    if (remoteBase !== undefined) {
      base = new URL(remoteBase.endsWith('/') ? remoteBase : remoteBase + '/');
      assert(base.search === '' && base.hash === '', '--url must be a site directory without a query or hash');
      for (const file of required.filter((file) => !file.endsWith('.mp4'))) {
        const response = await fetch(new URL(file, base), { signal: AbortSignal.timeout(30_000), cache: 'no-store' });
        assert.equal(response.status, 200, 'Remote artifact unavailable: ' + file);
        const remote = Buffer.from(await response.arrayBuffer());
        assert(remote.equals(bytes(file)), 'Remote artifact differs from local build: ' + file);
      }
    } else {
      server = createSiteServer();
      await new Promise<void>((done, reject) => {
        server?.once('error', reject);
        server?.listen(0, '127.0.0.1', () => { server?.off('error', reject); done(); });
      });
      const address = server.address();
      assert(address !== null && typeof address !== 'string');
      base = new URL('http://127.0.0.1:' + address.port + '/otter/');
    }
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('response', (response) => { if (response.status() >= 400) errors.push(response.status() + ' ' + response.url()); });
    page.on('requestfailed', (request) => { if (request.failure()?.errorText !== 'net::ERR_ABORTED') errors.push('Request failed: ' + request.url() + ' ' + request.failure()?.errorText); });
    for (const file of ['index.html', 'api/core.html', 'downloads/index.html']) {
      const response = await page.goto(new URL(file, base).href);
      assert.equal(response?.status(), 200, 'Page unavailable: ' + file);
    }
    await page.goto(new URL('demo/index.html', base).href);
    await page.waitForFunction(() => document.querySelector('#source-status')?.textContent?.startsWith('Sample ready.'), undefined, { timeout: 15_000 });
    await playAndAdvance(page, 'sample');
    await page.locator('#local-file').setInputFiles(join(site, 'demo/media/sample.mp4'));
    await page.waitForFunction(() => document.querySelector('#source-status')?.textContent?.startsWith('sample.mp4 ready.'), undefined, { timeout: 15_000 });
    await playAndAdvance(page, 'local file');
    assert.deepEqual(errors, [], 'Browser errors or failed asset requests');
    if (screenshotDir !== undefined) {
      mkdirSync(screenshotDir, { recursive: true });
      assert(!within(realpathSync(root), realpathSync(screenshotDir)) && !within(site, realpathSync(screenshotDir)), 'Screenshot directory resolves inside the repository or site');
      await page.screenshot({ path: join(screenshotDir, 'demo-desktop.png'), fullPage: true, animations: 'disabled' });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: join(screenshotDir, 'demo-narrow.png'), fullPage: true, animations: 'disabled' });
      console.log('✓ demo screenshots: ' + screenshotDir);
    }
    await page.close();
  } finally {
    try { await browser?.close(); } finally {
      server?.closeAllConnections();
      if (server?.listening) await new Promise<void>((done, reject) => server?.close((error) => error === undefined ? done() : reject(error)));
    }
  }
}
