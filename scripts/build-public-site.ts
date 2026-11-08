// Assemble the public site from the existing workspace build (ADR-015).
// Run pnpm build first; this script never builds or publishes an npm package.
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildDocsSite } from './docs-site.ts';
import { runCommand } from './lib/process.ts';
import { writePublicDemo } from './lib/public-demo.ts';

const root = join(import.meta.dirname, '..');
const SOURCE_COMMIT = '56893d2dd70f370be4e1828f4753f560e9ecc804';
const VERSION = '0.1.0-beta.0';
const sourcePaths = ['packages', 'vendor', 'tooling', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'tsconfig.build.json', 'scripts/build-cdn.ts'];
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Sorted POSIX names; reject links and special files in a downloadable artifact. */
function files(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const name = prefix + entry.name;
    if (entry.isDirectory()) return files(join(dir, entry.name), name + '/');
    if (!entry.isFile()) throw new Error('Unsupported artifact entry: ' + name);
    return [name];
  }).sort();
}

/** ZIP's IEEE CRC-32, computed without an additional build dependency. */
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) === 0 ? 0 : 0xedb88320);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Deterministic ZIP store entries: UTF-8 names, fixed 1980-01-01 date, no platform tool. */
function zipDirectory(dir: string, prefix: string): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  const names = files(dir);
  if (names.length >= 0xffff) throw new Error('The browser archive needs ZIP64');
  let offset = 0;
  for (const name of names) {
    const label = Buffer.from(prefix + '/' + name, 'utf8');
    const data = readFileSync(join(dir, name));
    if (label.length > 0xffff || data.length >= 0xffffffff || offset >= 0xffffffff) throw new Error('The browser archive exceeds ZIP limits');
    const crc = crc32(data);
    const entry = Buffer.alloc(30);
    entry.writeUInt32LE(0x04034b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(0x0800, 6);
    entry.writeUInt16LE(33, 12);
    entry.writeUInt32LE(crc, 14);
    entry.writeUInt32LE(data.length, 18);
    entry.writeUInt32LE(data.length, 22);
    entry.writeUInt16LE(label.length, 26);
    local.push(entry, label, data);
    const index = Buffer.alloc(46);
    index.writeUInt32LE(0x02014b50, 0);
    index.writeUInt16LE(20, 4);
    index.writeUInt16LE(20, 6);
    index.writeUInt16LE(0x0800, 8);
    index.writeUInt16LE(33, 14);
    index.writeUInt32LE(crc, 16);
    index.writeUInt32LE(data.length, 20);
    index.writeUInt32LE(data.length, 24);
    index.writeUInt16LE(label.length, 28);
    index.writeUInt32LE(offset, 42);
    central.push(index, label);
    offset += entry.length + label.length + data.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  if (offset + centralSize >= 0xffffffff) throw new Error('The browser archive needs ZIP64');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

function assertFrozenSources(): void {
  const changed = runCommand('git', ['diff', '--name-only', SOURCE_COMMIT, '--', ...sourcePaths], { cwd: root }).trim();
  const added = runCommand('git', ['ls-files', '--others', '--exclude-standard', '--', ...sourcePaths], { cwd: root }).trim();
  if (changed !== '' || added !== '') throw new Error('Browser release inputs differ from ' + SOURCE_COMMIT + ':\n' + [changed, added].filter(Boolean).join('\n'));
  const manifest = JSON.parse(readFileSync(join(root, 'packages/cdn/package.json'), 'utf8')) as { version: string };
  if (manifest.version !== VERSION) throw new Error('Update the public-site release record before distributing another version');
}

export function buildPublicSite(outDir: string): void {
  assertFrozenSources();
  const cdn = join(root, 'packages/cdn');
  for (const preset of ['basic', 'vod']) {
    for (const extension of ['esm.js', 'css']) {
      const entry = join(cdn, 'dist', 'otter-' + preset, 'otter-' + preset + '.' + extension);
      if (!statSync(entry).isFile()) throw new Error('Run pnpm build before assembling the public site: ' + entry);
    }
  }
  const docs = buildDocsSite(outDir, { publicSite: true });
  if (docs.problems.length !== 0) throw new Error('Docs gate failed:\n' + docs.problems.join('\n'));
  writePublicDemo(outDir, VERSION);
  const browser = join(outDir, 'browser', VERSION);
  cpSync(join(cdn, 'dist'), browser, { recursive: true });
  for (const license of ['LICENSE', 'NOTICE']) copyFileSync(join(cdn, license), join(browser, license));
  const readme = [
    '# Otter browser distribution ' + VERSION,
    '',
    'This archive contains the prebuilt basic and vod ESM presets, their CSS and every on-demand JavaScript chunk.',
    'Player source: https://github.com/CIPFZ/otter/tree/' + SOURCE_COMMIT,
    'The site build checks that the player sources, dependencies and build configuration still match this frozen npm release source.',
    'The public site is released independently. The npm first release and trusted-publisher setup are not yet complete.',
    '',
    '## Files',
    '',
    '- otter-basic/otter-basic.esm.js and otter-basic/otter-basic.css: basic preset with the minimal skin.',
    '- otter-vod/otter-vod.esm.js and otter-vod/otter-vod.css: vod preset with the default skin.',
    '- Each preset\'s chunks/ directory: keep every file beside its entry at the same relative path.',
    '- LICENSE: Otter\'s Apache-2.0 license.',
    '- NOTICE: bundled third-party projects, source locations and their complete license texts (including MPL-2.0 parts).',
    '- inputs.json: the CDN build input list for its license audit.',
    '- SHA256SUMS: SHA-256 of every file above and this README, with paths relative to this directory; the manifest excludes itself.',
    '',
    '## Use',
    '',
    'Extract the whole archive and serve it over HTTP or HTTPS. Do not open modules using file://.',
    'Load the matching CSS, then import the preset from a script with type="module".',
    'For example, import { createVodPlayer } from "./otter-vod/otter-vod.esm.js";',
    'and link ./otter-vod/otter-vod.css. Keep chunks/ in place for features loaded on demand.',
    'No npm install or external CDN is required for these browser files.',
    '',
    'Demo: https://cipfz.github.io/otter/demo/',
    'API documentation: https://cipfz.github.io/otter/',
    '',
    'Browser baseline: Chrome/Edge 110+, Firefox 115+, Safari/iOS 16.4+. This is a beta; device and codec support still depends on the browser.',
    '',
  ].join('\n');
  writeFileSync(join(browser, 'README.md'), readme);
  writeFileSync(join(browser, 'SHA256SUMS'), files(browser).map((name) => hash(readFileSync(join(browser, name))) + '  ' + name + '\n').join(''));

  const media = join(outDir, 'demo', 'media');
  mkdirSync(media, { recursive: true });
  const sample = 'e2e/media/vod/progressive.mp4';
  copyFileSync(join(root, sample), join(media, 'sample.mp4'));
  copyFileSync(join(root, 'LICENSE'), join(media, 'LICENSE'));
  writeFileSync(join(media, 'README.md'), [
    '# Otter demo media', '',
    'sample.mp4 is copied without modification from ' + sample + ' in Otter.',
    'It is an Otter-generated synthetic test pattern and a 440 Hz sine tone, distributed under the repository Apache-2.0 license (LICENSE in this directory).',
    'No third-party film, recording or remote sample is used.',
    'Recipe: e2e/media/generate.sh, using FFmpeg lavfi testsrc2 (640x360, 25 fps) and sine (48000 Hz), encoded as 8 seconds of H.264 + AAC.',
    'FFmpeg is a generation tool and is not distributed with this site.',
    'Source and recipe: https://github.com/CIPFZ/otter/blob/' + SOURCE_COMMIT + '/e2e/media/generate.sh',
    'SHA-256: ' + hash(readFileSync(join(media, 'sample.mp4'))), '',
  ].join('\n'));

  const downloads = join(outDir, 'downloads');
  mkdirSync(downloads, { recursive: true });
  const zipName = 'otter-browser-' + VERSION + '.zip';
  const zip = zipDirectory(browser, 'otter-browser-' + VERSION);
  const digest = hash(zip);
  writeFileSync(join(downloads, zipName), zip);
  writeFileSync(join(downloads, zipName + '.sha256'), digest + '  ' + zipName + '\n');
  writeFileSync(join(downloads, 'index.html'), downloadPage(zipName, digest, zip.length));
  writeFileSync(join(outDir, '.nojekyll'), '');
  console.log('✓ public site: ' + docs.pages + ' docs pages, demo, basic + vod browser files, and ' + zipName + ' (' + zip.length + ' bytes)');
  console.log('✓ browser source: ' + SOURCE_COMMIT + '; archive SHA-256: ' + digest);
}

function downloadPage(zipName: string, digest: string, size: number): string {
  return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Browser downloads · Otter</title><link rel="icon" href="data:,"><link rel="stylesheet" href="../style.css"></head><body>' +
    '<header><nav aria-label="Main navigation"><a href="../index.html">Docs</a> · <a href="../demo/index.html">Demo</a> · <a href="index.html" aria-current="page">Downloads</a></nav></header>' +
    '<main><h1>Otter browser downloads</h1><p>Version <strong>' + VERSION + '</strong> · Beta</p>' +
    '<p>Use the complete browser distribution without npm. It includes both <strong>basic</strong> and <strong>vod</strong> presets, their skins and every on-demand chunk.</p>' +
    '<p><a href="' + zipName + '" download>Download ' + zipName + '</a> (' + size.toLocaleString('en-US') + ' bytes; ' + (size / 1024 / 1024).toFixed(2) + ' MiB)</p>' +
    '<p><a href="' + zipName + '.sha256">Archive checksum</a> · <a href="../browser/' + VERSION + '/SHA256SUMS">Individual file checksums</a></p>' +
    '<p>SHA-256</p><pre><code>' + digest + '</code></pre>' +
    '<h2>Install on your site</h2><p>Extract the entire archive and serve it over HTTP or HTTPS. Keep each chunks directory beside its entry. Import the ESM entry from a module script and load its matching CSS. Opening modules with file:// is not supported.</p>' +
    '<table><thead><tr><th>Preset</th><th>ESM entry</th><th>Stylesheet</th></tr></thead><tbody>' +
    ['basic', 'vod'].map((id) => '<tr><td>' + id + '</td><td><a href="../browser/' + VERSION + '/otter-' + id + '/otter-' + id + '.esm.js">otter-' + id + '.esm.js</a></td><td><a href="../browser/' + VERSION + '/otter-' + id + '/otter-' + id + '.css">otter-' + id + '.css</a></td></tr>').join('') +
    '</tbody></table><p>Downloading an entry by itself is not enough: it imports other files. Use the ZIP to keep the complete directory layout.</p>' +
    '<p><a href="../browser/' + VERSION + '/README.md">Archive README</a> · <a href="../browser/' + VERSION + '/LICENSE">Apache-2.0 license</a> · <a href="../browser/' + VERSION + '/NOTICE">Third-party notices and license texts</a></p>' +
    '<h2>Release status</h2><p>The docs, demo and browser download are available independently. The npm first release and trusted-publisher setup are not yet complete.</p>' +
    '<p><a href="https://github.com/CIPFZ/otter/tree/' + SOURCE_COMMIT + '">Frozen player source</a>. Site-only updates do not change this player version.</p>' +
    '<p><a href="../demo/index.html">Try the demo</a> with the bundled synthetic sample; no external sample server is required.</p></main></body></html>\n';
}

if (import.meta.filename === process.argv[1]) buildPublicSite(resolve(process.argv[2] ?? join(root, 'docs-site/dist')));
