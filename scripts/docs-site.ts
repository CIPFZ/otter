// The docs site (ADR-013 batch 4, M5 handoff §7): static HTML generated from the sources, not
// written by hand. Pages:
// - index: the API grouped as a host uses it (§7's table), the presets, the bindings, TSDoc coverage;
// - one page per package: every entry (index and sub-paths) with its exports, signatures, doc
//   comments and interface members; skins: their CSS variables;
// - one page per preset: its header comment, its options, its example (the @example of its create
//   function, the same code as its region in e2e/site/examples/) and a link that runs that example
//   on the e2e site with a fixture (served by `pnpm docs:serve` or the e2e preview server: the docs
//   are copied into the site build under /docs/);
// - one page per binding (React, Vue, Svelte): the package README, the binding's example and the
//   example app source, with links to its server-rendered example pages.
// English (AGENT §4: the docs site, TSDoc and READMEs are English). `pnpm check:docs-site` builds
// it and runs the TSDoc gate (scripts/lib/docs-gate.ts): it fails on any problem the gate finds.
// Built in CI (and with every e2e site build); not deployed (ADR-014: later).
//
//   node scripts/docs-site.ts [outDir]     (default docs-site/dist)

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readApiSurface, type ApiEntry, type ApiExport, type ApiTag } from './lib/api-surface.ts';
import { docsGate, exampleCode, EXAMPLES, internalCoverage, readExampleRegions, USER_FACING } from './lib/docs-gate.ts';
import { readErrorCodes } from './lib/error-codes.ts';
import { EXAMPLE_SOURCES } from '../e2e/site/examples/sources.ts';

const root = join(import.meta.dirname, '..');

/** §7: the packages by what a host does with them. */
const GROUPS: readonly (readonly [string, readonly string[]])[] = [
  ['Assembly', ['core', 'presets']],
  ['Playback session', ['media', 'qoe', 'preferences']],
  ['Backends', ['backend-mse', 'backend-native', 'backend-webcodecs']],
  ['Formats', ['format-hls', 'format-dash', 'format-flv', 'format-ts', 'format-mp4-range', 'format-file', 'format-whep']],
  ['Engine adapters and pipeline', ['engine-adapter-hlsjs', 'engine-adapter-shaka', 'engine-adapter-mpegts', 'engine-pipeline', 'pipeline']],
  ['Decoding', ['decoder-webcodecs', 'decoder-wasm-hevc', 'decoder-pool', 'demux-mediabunny', 'decoder-wasm-ffmpeg']],
  ['Picture and presentation', ['surface', 'presentation']],
  ['Input', ['input']],
  ['UI and skins', ['ui-core', 'ui-skin-default', 'ui-skin-minimal', 'ui-skin-tv', 'ui-skin-audio']],
  ['Captions', ['text', 'text-ass']],
  ['Danmaku and overlays', ['danmaku', 'overlay-watermark', 'overlay-thumbnails', 'overlay-ads']],
  ['Framework bindings', ['react', 'vue', 'svelte']],
  ['Plugins (stubs)', ['plugin-analytics', 'plugin-cast', 'plugin-p2p', 'plugin-record', 'plugin-screenshot']],
];

const BINDINGS: readonly { id: string; name: string; app: string; example: string }[] = [
  { id: 'react', name: 'React', app: 'e2e/site/react-app.tsx', example: '@otter-player/react#OtterPlayer' },
  { id: 'vue', name: 'Vue', app: 'e2e/site/vue-app.ts', example: '@otter-player/vue#OtterPlayer' },
  { id: 'svelte', name: 'Svelte', app: 'e2e/site/SvelteApp.svelte', example: '@otter-player/svelte#otterPlayer' },
];


const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slug = (pkg: string): string => pkg.replace('@otter-player/', '');

/** A small Markdown subset (the packages' READMEs): headings, paragraphs, lists, code, tables, inline code / bold / links. */
export function markdown(md: string): string {
  const inline = (s: string): string =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  const out: string[] = [];
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const fence = /^```(\w*)/.exec(line);
    if (fence !== null) {
      const code: string[] = [];
      for (i++; i < lines.length && !(lines[i] as string).startsWith('```'); i++) code.push(lines[i] as string);
      out.push(`<pre><code class="lang-${fence[1]}">${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h !== null) {
      // The README's title is the page's: headings start one level down.
      const level = Math.min(6, (h[1] as string).length + 1);
      out.push(`<h${level}>${inline(h[2] as string)}</h${level}>`);
      continue;
    }
    if (line.startsWith('|')) {
      const rows: string[][] = [];
      for (; i < lines.length && (lines[i] as string).startsWith('|'); i++) rows.push((lines[i] as string).slice(1, -1).split('|').map((c) => c.trim()));
      i--;
      const [head, , ...body] = rows;
      out.push(`<table><thead><tr>${(head ?? []).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      for (; i < lines.length && /^\s*[-*]\s+/.test(lines[i] as string); i++) items.push((lines[i] as string).replace(/^\s*[-*]\s+/, ''));
      i--;
      out.push(`<ul>${items.map((x) => `<li>${inline(x)}</li>`).join('')}</ul>`);
      continue;
    }
    if (line.trim() === '') continue;
    const para: string[] = [line];
    for (i++; i < lines.length && (lines[i] as string).trim() !== '' && !/^(#|```|\||\s*[-*]\s)/.test(lines[i] as string); i++) para.push(lines[i] as string);
    i--;
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('\n');
}

const page = (title: string, body: string, depth: number): string => {
  const up = '../'.repeat(depth);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Otter</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="${up}style.css">
</head>
<body>
<header><a href="${up}index.html">Otter docs</a></header>
<main>
<h1>${esc(title)}</h1>
${body}
</main>
</body>
</html>
`;
};

const STYLE = `body { margin: 0; font: 15px/1.6 system-ui, -apple-system, 'Segoe UI', sans-serif; color: #1b2430; background: #fff; }
header { padding: 12px 24px; background: #10161e; } header a { color: #1ee9e6; font-weight: 600; text-decoration: none; }
main { max-width: 1040px; margin: 0 auto; padding: 8px 24px 64px; }
a { color: #0b6e8a; } code { font: 13px ui-monospace, Menlo, Consolas, monospace; background: #f1f4f7; padding: 1px 4px; border-radius: 4px; }
pre { background: #0f1720; color: #e6edf3; padding: 12px 14px; border-radius: 8px; overflow: auto; } pre code { background: none; color: inherit; padding: 0; }
table { border-collapse: collapse; width: 100%; margin: 8px 0 16px; } th, td { border: 1px solid #dde3ea; padding: 6px 8px; text-align: left; vertical-align: top; }
th { background: #f6f8fa; } .kind { font-size: 12px; color: #5a6878; text-transform: uppercase; letter-spacing: 0.04em; }
.export { border-top: 1px solid #e3e8ee; padding-top: 8px; margin-top: 16px; } td.doc { white-space: pre-line; } .muted { color: #5a6878; }
`;

/** `{@link X}` in a comment: a link to X's section on its package page, where X is a public export. */
type Linker = (name: string) => string | undefined;

const docText = (text: string, link: Linker, depth: number): string =>
  esc(text).replace(/\{@link\s+([\w$.#]+)\s*\}/g, (_, name: string) => {
    const href = link(name.split(/[.#]/)[0] as string);
    return href === undefined ? `<code>${esc(name)}</code>` : `<a href="${'../'.repeat(depth)}${href}"><code>${esc(name)}</code></a>`;
  });

/** A doc comment as Markdown (tables, lists, code), its `{@link X}` as links. */
const docMarkdown = (text: string, link: Linker, depth: number): string =>
  markdown(
    text.replace(/\{@link\s+([\w$.#]+)\s*\}/g, (_, name: string) => {
      const href = link(name.split(/[.#]/)[0] as string);
      return href === undefined ? `\`${name}\`` : `[\`${name}\`](${'../'.repeat(depth)}${href})`;
    }),
  );

const tagHtml = (tags: readonly ApiTag[], link: Linker, depth: number): string =>
  tags
    .map((t) => {
      if (t.name === 'example') return `<p class="muted">Example</p><pre><code>${esc(exampleCode(t))}</code></pre>`;
      if (t.name === 'see') return `<p class="muted">See ${docText(t.text, link, depth)}</p>`;
      if (t.name === 'defaultValue') return `<p class="muted">Default: ${docText(t.text, link, depth)}</p>`;
      return '';
    })
    .join('');

const exportHtml = (x: ApiExport, link: Linker, depth = 1): string => {
  const sig = x.signature === '' ? '' : `<pre><code>${esc(x.kind === 'type' ? `type ${x.name} = ${x.signature}` : x.kind === 'const' ? `const ${x.name}: ${x.signature}` : x.signature)}</code></pre>`;
  const defaults = (m: ApiExport['members'][number]): string => {
    const t = m.tags.find((y) => y.name === 'defaultValue');
    return t === undefined ? '' : docText(t.text, link, depth);
  };
  const withDefaults = x.members.some((m) => m.tags.some((t) => t.name === 'defaultValue'));
  const members =
    x.members.length === 0
      ? ''
      : `<table><thead><tr><th>Member</th><th>Type</th>${withDefaults ? '<th>Default</th>' : ''}<th>Description</th></tr></thead><tbody>${x.members
          .map((m) => `<tr><td><code>${esc(m.name)}${m.optional ? '?' : ''}</code></td><td><code>${esc(m.type)}</code></td>${withDefaults ? `<td>${defaults(m)}</td>` : ''}<td class="doc">${docText(m.doc, link, depth)}</td></tr>`)
          .join('')}</tbody></table>`;
  return `<section class="export" id="${esc(x.name)}"><h3>${esc(x.name)} <span class="kind">${x.kind}</span></h3>${x.doc === '' ? '' : `<div class="doc">${docMarkdown(x.doc, link, depth)}</div>`}${tagHtml(x.tags, link, depth)}${sig}${members}</section>`;
};

const entryHtml = (e: ApiEntry, link: Linker): string => {
  if (e.css) {
    return `<h2><code>${esc(e.specifier)}</code> <span class="kind">CSS</span></h2><p class="muted">A CSS-only entry (<code>${esc(e.file)}</code>). The CSS variables it sets:</p><table><thead><tr><th>Variable</th><th>Value</th></tr></thead><tbody>${e.variables.map((v) => `<tr><td><code>${esc(v.name)}</code></td><td><code>${esc(v.value)}</code></td></tr>`).join('')}</tbody></table>`;
  }
  return `<h2><code>${esc(e.specifier)}</code></h2><p class="muted">Source <code>${esc(e.file)}</code>, ${e.exports.length} exports.</p>${e.exports.map((x) => exportHtml(x, link)).join('\n')}`;
};

/** The leading `//` comment of a source file. */
const headerComment = (file: string): string =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((_, i, all) => all.slice(0, i + 1).every((l) => l.startsWith('//')))
    .map((l) => l.replace(/^\/\/ ?/, ''))
    .join(' ')
    .trim();

/** The page of the e2e site that runs a docs example with its fixture. */
const exampleLink = (region: string, depth: number): string => {
  const src = EXAMPLE_SOURCES[region];
  if (src === undefined) return '';
  const href = `${'../'.repeat(depth + 1)}examples.html?example=${encodeURIComponent(region)}&src=${src}`;
  return `<p>Run it on the example site (e2e fixtures; <code>pnpm docs:serve</code> or the e2e preview server): <a class="live" href="${esc(href)}">examples.html?example=${esc(region)}</a>${region === 'ott-drm' ? ' (the e2e test injects the ClearKey keys, see <code>e2e/examples.spec.ts</code>)' : ''}</p>`;
};

export function buildDocsSite(outDir: string): { pages: number; undocumented: number; exports: number; problems: readonly string[] } {
  const api = readApiSurface(root);
  const problems = docsGate({ api, examples: readExampleRegions(root), errorCodes: readErrorCodes(root) });
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, 'api'), { recursive: true });
  mkdirSync(join(outDir, 'presets'), { recursive: true });
  mkdirSync(join(outDir, 'bindings'), { recursive: true });
  writeFileSync(join(outDir, 'style.css'), STYLE);
  let pages = 0;
  const byPkg = new Map<string, ApiEntry[]>();
  for (const e of api.entries) byPkg.set(slug(e.pkg), [...(byPkg.get(slug(e.pkg)) ?? []), e]);
  // Where each public name is documented (its first entry), for {@link}.
  const anchors = new Map<string, string>();
  for (const e of api.entries) for (const x of e.exports) if (!anchors.has(x.name)) anchors.set(x.name, `api/${slug(e.pkg)}.html#${encodeURIComponent(x.name)}`);
  const link: Linker = (name) => anchors.get(name);

  // Package pages.
  for (const [pkg, entries] of byPkg) {
    const readme = join(root, 'packages', pkg, 'README.md');
    let intro = '';
    try {
      intro = markdown(readFileSync(readme, 'utf8').replace(/^# .*\n/, ''));
    } catch {
      intro = '';
    }
    writeFileSync(join(outDir, 'api', `${pkg}.html`), page(`@otter-player/${pkg}`, `${intro}${entries.map((e) => entryHtml(e, link)).join('\n')}`, 1));
    pages++;
  }

  // Preset pages.
  const ids = [...readFileSync(join(root, 'packages/presets/src/index.ts'), 'utf8').matchAll(/^\s+'([a-z-]+)',$/gm)].map((m) => m[1] as string);
  for (const id of ids) {
    const entry = api.entries.find((e) => e.specifier === `@otter-player/presets/${id}`);
    const options = entry?.exports.filter((x) => x.kind === 'interface' && /Options$/.test(x.name)) ?? [];
    const create = entry?.exports.find((x) => x.kind === 'function' && x.name.startsWith('create'));
    const example = create?.tags.find((t) => t.name === 'example');
    const body = [
      `<p>${esc(headerComment(join(root, 'packages/presets/src', `${id}.ts`)))}</p>`,
      `<pre><code>import { ${esc(create?.name ?? 'createPlayer')} } from '@otter-player/presets/${id}';</code></pre>`,
      `<h2>Example</h2><p class="muted">The @example of <code>${esc(create?.name ?? '')}</code>, the same code as <code>e2e/site/examples/</code> (<code>container</code> and <code>src</code> are the example page's host element and source).</p><pre><code>${esc(example === undefined ? '' : exampleCode(example))}</code></pre>`,
      exampleLink(id, 1),
      options.length === 0 ? '' : `<h2>Options</h2>${options.map((x) => exportHtml(x, link)).join('\n')}`,
      `<p><a href="../api/presets.html">Full API: @otter-player/presets</a></p>`,
    ].join('\n');
    writeFileSync(join(outDir, 'presets', `${id}.html`), page(`Preset: ${id}`, body, 1));
    pages++;
  }

  // Binding pages.
  for (const b of BINDINGS) {
    const readme = markdown(readFileSync(join(root, 'packages', b.id, 'README.md'), 'utf8').replace(/^# .*\n/, ''));
    const app = readFileSync(join(root, b.app), 'utf8');
    const [specifier, name] = b.example.split('#') as [string, string];
    const example = api.entries.find((e) => e.specifier === specifier)?.exports.find((x) => x.name === name)?.tags.find((t) => t.name === 'example');
    const region = EXAMPLES[b.example] as string;
    const live = ['basic', 'vod', 'surveillance'].map((p) => `<a class="live" href="../../${b.id}-${p}.html">${b.id}-${p}.html</a>`).join(', ');
    const body = [
      readme,
      `<h2>Example</h2><p class="muted">The @example of <code>${esc(name)}</code> (<code>e2e/site/examples/</code>).</p><pre><code>${esc(example === undefined ? '' : exampleCode(example))}</code></pre>`,
      exampleLink(region, 1),
      `<h2>Example app</h2><p class="muted"><code>${esc(b.app)}</code>, rendered on the server in Node at build time and hydrated in the browser: ${live}.</p><pre><code>${esc(app)}</code></pre>`,
      `<p><a href="../api/${b.id}.html">Full API: @otter-player/${b.id}</a></p>`,
    ].join('\n');
    writeFileSync(join(outDir, 'bindings', `${b.id}.html`), page(`${b.name} bindings`, body, 1));
    pages++;
  }

  // Index.
  const exportsCount = api.entries.reduce((n, e) => n + e.exports.length, 0);
  const userFacing = api.entries.filter((e) => !e.css && USER_FACING.test(e.specifier));
  const userExports = userFacing.reduce((n, e) => n + e.exports.length, 0);
  const internal = internalCoverage(api);
  const grouped = new Set(GROUPS.flatMap(([, pkgs]) => pkgs));
  const rest = [...byPkg.keys()].filter((p) => !grouped.has(p));
  const groupRows = [...GROUPS, ...(rest.length === 0 ? [] : [['Other', rest] as const])]
    .map(([name, pkgs]) => `<tr><td>${esc(name)}</td><td>${pkgs.filter((p) => byPkg.has(p)).map((p) => `<a href="api/${p}.html">${esc(p)}</a>`).join(', ')}</td></tr>`)
    .join('');
  const index = [
    `<p>Generated from the sources (${api.entries.length} entries, ${exportsCount} exports); the text is the sources' TSDoc.</p>`,
    `<h2>Presets</h2><ul>${ids.map((id) => `<li><a href="presets/${id}.html">${esc(id)}</a></li>`).join('')}</ul>`,
    `<h2>Framework bindings</h2><ul>${BINDINGS.map((b) => `<li><a href="bindings/${b.id}.html">${esc(b.name)}</a></li>`).join('')}</ul>`,
    `<h2>API by use</h2><table><thead><tr><th>Group</th><th>Packages</th></tr></thead><tbody>${groupRows}</tbody></table>`,
    `<h2>TSDoc coverage</h2><p class="muted">User-facing entries (${userFacing.length}): ${userExports} exports, gated at 100 % by <code>pnpm check:docs-site</code>${problems.length === 0 ? '' : ` (${problems.length} problems now)`}. Internal packages: ${internal.documented} / ${internal.total} exports documented (recorded, not gated).</p>`,
  ].join('\n');
  writeFileSync(join(outDir, 'index.html'), page('Otter docs', index, 0));
  pages++;
  return { pages, undocumented: api.undocumented.length, exports: exportsCount, problems };
}

if (import.meta.filename === process.argv[1]) {
  const out = process.argv[2] ?? join(root, 'docs-site', 'dist');
  const r = buildDocsSite(out);
  if (r.problems.length > 0) {
    for (const p of r.problems) console.error(`✗ ${p}`);
    console.error(`✗ docs: ${r.problems.length} TSDoc problems (AGENT §4, scripts/lib/docs-gate.ts)`);
    process.exit(1);
  }
  console.log(`✓ docs site: ${r.pages} pages in ${out}; TSDoc gate passed; ${r.exports - r.undocumented} / ${r.exports} exports documented`);
}
