// The docs site (ADR-013 batch 4, M5 handoff §7): static HTML generated from the sources, not
// written by hand. Pages:
// - index: the API grouped as a host uses it (§7's table), the presets, the bindings, TSDoc coverage;
// - one page per package: every entry (index and sub-paths) with its exports, signatures, doc
//   comments and interface members; skins: their CSS variables;
// - one page per preset: its header comment, its options, the example from the e2e site
//   (e2e/site/presets.ts) and a link to that page with the e2e fixtures (served by `pnpm docs:serve`
//   or the e2e preview server: the docs are copied into the site build under /docs/);
// - one page per binding (React, Vue, Svelte): the package README and the example app source, with
//   links to its server-rendered example pages.
// Built in CI (`pnpm check:docs-site`, and with every e2e site build); not deployed (ADR-014: later).
//
//   node scripts/docs-site.ts [outDir]     (default docs-site/dist)

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readApiSurface, type ApiEntry, type ApiExport } from './lib/api-surface.ts';

const root = join(import.meta.dirname, '..');

/** §7: the packages by what a host does with them. */
const GROUPS: readonly (readonly [string, readonly string[]])[] = [
  ['组装', ['core', 'presets']],
  ['播放会话', ['media', 'qoe', 'preferences']],
  ['后端', ['backend-mse', 'backend-native', 'backend-webcodecs']],
  ['格式', ['format-hls', 'format-dash', 'format-flv', 'format-ts', 'format-mp4-range', 'format-file', 'format-whep']],
  ['引擎适配器与管线', ['engine-adapter-hlsjs', 'engine-adapter-shaka', 'engine-adapter-mpegts', 'engine-pipeline', 'pipeline']],
  ['解码', ['decoder-webcodecs', 'decoder-wasm-hevc', 'decoder-pool', 'demux-mediabunny', 'decoder-wasm-ffmpeg']],
  ['画面与呈现', ['surface', 'presentation']],
  ['输入', ['input']],
  ['UI 与皮肤', ['ui-core', 'ui-skin-default', 'ui-skin-minimal', 'ui-skin-tv', 'ui-skin-audio']],
  ['字幕', ['text', 'text-ass']],
  ['弹幕与叠加', ['danmaku', 'overlay-watermark', 'overlay-thumbnails', 'overlay-ads']],
  ['框架绑定', ['react', 'vue', 'svelte']],
  ['插件（桩）', ['plugin-analytics', 'plugin-cast', 'plugin-p2p', 'plugin-record', 'plugin-screenshot']],
];

const BINDINGS: readonly { id: string; name: string; app: string }[] = [
  { id: 'react', name: 'React', app: 'e2e/site/react-app.tsx' },
  { id: 'vue', name: 'Vue', app: 'e2e/site/vue-app.ts' },
  { id: 'svelte', name: 'Svelte', app: 'e2e/site/SvelteApp.svelte' },
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
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Otter</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="${up}style.css">
</head>
<body>
<header><a href="${up}index.html">Otter 文档</a></header>
<main>
<h1>${esc(title)}</h1>
${body}
</main>
</body>
</html>
`;
};

const STYLE = `body { margin: 0; font: 15px/1.6 system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif; color: #1b2430; background: #fff; }
header { padding: 12px 24px; background: #10161e; } header a { color: #1ee9e6; font-weight: 600; text-decoration: none; }
main { max-width: 1040px; margin: 0 auto; padding: 8px 24px 64px; }
a { color: #0b6e8a; } code { font: 13px ui-monospace, Menlo, Consolas, monospace; background: #f1f4f7; padding: 1px 4px; border-radius: 4px; }
pre { background: #0f1720; color: #e6edf3; padding: 12px 14px; border-radius: 8px; overflow: auto; } pre code { background: none; color: inherit; padding: 0; }
table { border-collapse: collapse; width: 100%; margin: 8px 0 16px; } th, td { border: 1px solid #dde3ea; padding: 6px 8px; text-align: left; vertical-align: top; }
th { background: #f6f8fa; } .kind { font-size: 12px; color: #5a6878; text-transform: uppercase; letter-spacing: 0.04em; }
.export { border-top: 1px solid #e3e8ee; padding-top: 8px; margin-top: 16px; } .doc { white-space: pre-line; } .muted { color: #5a6878; }
`;

const exportHtml = (x: ApiExport): string => {
  const sig = x.signature === '' ? '' : `<pre><code>${esc(x.kind === 'type' ? `type ${x.name} = ${x.signature}` : x.kind === 'const' ? `const ${x.name}: ${x.signature}` : x.signature)}</code></pre>`;
  const members =
    x.members.length === 0
      ? ''
      : `<table><thead><tr><th>成员</th><th>类型</th><th>说明</th></tr></thead><tbody>${x.members
          .map((m) => `<tr><td><code>${esc(m.name)}${m.optional ? '?' : ''}</code></td><td><code>${esc(m.type)}</code></td><td class="doc">${esc(m.doc)}</td></tr>`)
          .join('')}</tbody></table>`;
  return `<section class="export" id="${esc(x.name)}"><h3>${esc(x.name)} <span class="kind">${x.kind}</span></h3>${x.doc === '' ? '' : `<p class="doc">${esc(x.doc)}</p>`}${sig}${members}</section>`;
};

const entryHtml = (e: ApiEntry): string => {
  if (e.css) {
    return `<h2><code>${esc(e.specifier)}</code> <span class="kind">CSS</span></h2><p class="muted">纯 CSS 入口（<code>${esc(e.file)}</code>）。它设置的 CSS 变量：</p><table><thead><tr><th>变量</th><th>值</th></tr></thead><tbody>${e.variables.map((v) => `<tr><td><code>${esc(v.name)}</code></td><td><code>${esc(v.value)}</code></td></tr>`).join('')}</tbody></table>`;
  }
  return `<h2><code>${esc(e.specifier)}</code></h2><p class="muted">源文件 <code>${esc(e.file)}</code>，${e.exports.length} 个导出。</p>${e.exports.map(exportHtml).join('\n')}`;
};

/** The first `else if (kind === 'id')` / `if (kind === 'id')` block of e2e/site/presets.ts. */
export function presetExample(site: string, id: string): string {
  const at = site.search(new RegExp(`if \\(kind === '${id}'\\) \\{`));
  if (at < 0) return '';
  const open = site.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < site.length; i++) {
    if (site[i] === '{') depth++;
    else if (site[i] === '}' && --depth === 0) {
      return site
        .slice(open + 1, i)
        .split('\n')
        .map((l) => l.replace(/^ {2}/, ''))
        .join('\n')
        .trim();
    }
  }
  return '';
}

/** The fixture query each preset's e2e cases open (e2e/presets.spec.ts), first one per preset. */
function presetQueries(): Map<string, string> {
  const specs = ['e2e/presets.spec.ts'].map((f) => readFileSync(join(root, f), 'utf8')).join('\n');
  const out = new Map<string, string>();
  for (const m of specs.matchAll(/goto\('\/presets\.html\?preset=([a-z-]+)([^']*)'\)/g)) if (!out.has(m[1] as string)) out.set(m[1] as string, `preset=${m[1]}${m[2]}`);
  // The surveillance wall's e2e case builds its query; the same streams here.
  out.set('surveillance', 'preset=surveillance&streams=/live/stream.flv,/live/stream.flv,/live/stream.ts,/hls-fmp4/master.m3u8');
  return out;
}

/** The leading `//` comment of a source file. */
const headerComment = (file: string): string =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((_, i, all) => all.slice(0, i + 1).every((l) => l.startsWith('//')))
    .map((l) => l.replace(/^\/\/ ?/, ''))
    .join(' ')
    .trim();

export function buildDocsSite(outDir: string): { pages: number; undocumented: number; exports: number } {
  const api = readApiSurface(root);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, 'api'), { recursive: true });
  mkdirSync(join(outDir, 'presets'), { recursive: true });
  mkdirSync(join(outDir, 'bindings'), { recursive: true });
  writeFileSync(join(outDir, 'style.css'), STYLE);
  let pages = 0;
  const byPkg = new Map<string, ApiEntry[]>();
  for (const e of api.entries) byPkg.set(slug(e.pkg), [...(byPkg.get(slug(e.pkg)) ?? []), e]);

  // Package pages.
  for (const [pkg, entries] of byPkg) {
    const readme = join(root, 'packages', pkg, 'README.md');
    let intro = '';
    try {
      intro = markdown(readFileSync(readme, 'utf8').replace(/^# .*\n/, ''));
    } catch {
      intro = '';
    }
    writeFileSync(join(outDir, 'api', `${pkg}.html`), page(`@otter-player/${pkg}`, `${intro}${entries.map(entryHtml).join('\n')}`, 1));
    pages++;
  }

  // Preset pages.
  const ids = [...readFileSync(join(root, 'packages/presets/src/index.ts'), 'utf8').matchAll(/^\s+'([a-z-]+)',$/gm)].map((m) => m[1] as string);
  const site = readFileSync(join(root, 'e2e/site/presets.ts'), 'utf8');
  const queries = presetQueries();
  for (const id of ids) {
    const entry = api.entries.find((e) => e.specifier === `@otter-player/presets/${id}`);
    const options = entry?.exports.filter((x) => x.kind === 'interface' && /Options$/.test(x.name)) ?? [];
    const block = presetExample(site, id);
    // The page's shared options and its load, where the block uses them.
    const common = /^const common = .*$/m.exec(site)?.[0];
    const example = [block.includes('...common') && common !== undefined ? common : '', block, /^\s*player = /m.test(block) ? 'void player.load(src, { autoplay: true });' : ''].filter((x) => x !== '').join('\n');
    const query = queries.get(id);
    const body = [
      `<p>${esc(headerComment(join(root, 'packages/presets/src', `${id}.ts`)))}</p>`,
      `<pre><code>import { ${esc(entry?.exports.find((x) => x.kind === 'function' && x.name.startsWith('create'))?.name ?? 'createPlayer')} } from '@otter-player/presets/${id}';</code></pre>`,
      `<h2>示例</h2><p class="muted">取自 e2e 示例页 <code>e2e/site/presets.ts</code>（<code>container</code>、<code>params</code> 是那一页的宿主元素与地址参数）。</p><pre><code>${esc(example)}</code></pre>`,
      query === undefined ? '' : `<p>在示例页里运行（e2e 夹具，<code>pnpm docs:serve</code> 或 e2e 预览服务）：<a class="live" href="../../presets.html?${esc(query)}">presets.html?${esc(query)}</a>${id === 'ott-drm' ? '（ClearKey 密钥由测试注入，见 <code>e2e/presets.spec.ts</code>）' : ''}</p>`,
      options.length === 0 ? '' : `<h2>选项</h2>${options.map(exportHtml).join('\n')}`,
      `<p><a href="../api/presets.html">完整 API：@otter-player/presets</a></p>`,
    ].join('\n');
    writeFileSync(join(outDir, 'presets', `${id}.html`), page(`preset：${id}`, body, 1));
    pages++;
  }

  // Binding pages.
  for (const b of BINDINGS) {
    const readme = markdown(readFileSync(join(root, 'packages', b.id, 'README.md'), 'utf8').replace(/^# .*\n/, ''));
    const app = readFileSync(join(root, b.app), 'utf8');
    const live = ['basic', 'vod', 'surveillance'].map((p) => `<a class="live" href="../../${b.id}-${p}.html">${b.id}-${p}.html</a>`).join('、');
    const body = `${readme}<h2>示例应用</h2><p class="muted"><code>${esc(b.app)}</code>，构建时在 Node 里服务端渲染，浏览器里水合：${live}。</p><pre><code>${esc(app)}</code></pre><p><a href="../api/${b.id}.html">完整 API：@otter-player/${b.id}</a></p>`;
    writeFileSync(join(outDir, 'bindings', `${b.id}.html`), page(`${b.name} 绑定`, body, 1));
    pages++;
  }

  // Index.
  const exportsCount = api.entries.reduce((n, e) => n + e.exports.length, 0);
  const grouped = new Set(GROUPS.flatMap(([, pkgs]) => pkgs));
  const rest = [...byPkg.keys()].filter((p) => !grouped.has(p));
  const groupRows = [...GROUPS, ...(rest.length === 0 ? [] : [['其他', rest] as const])]
    .map(([name, pkgs]) => `<tr><td>${esc(name)}</td><td>${pkgs.filter((p) => byPkg.has(p)).map((p) => `<a href="api/${p}.html">${esc(p)}</a>`).join('、')}</td></tr>`)
    .join('');
  const index = [
    `<p>从源码生成（${api.entries.length} 个入口、${exportsCount} 个导出）。说明文字来自源码里的文档注释，目前多为英文。</p>`,
    `<h2>Preset</h2><ul>${ids.map((id) => `<li><a href="presets/${id}.html">${esc(id)}</a></li>`).join('')}</ul>`,
    `<h2>框架绑定</h2><ul>${BINDINGS.map((b) => `<li><a href="bindings/${b.id}.html">${esc(b.name)}</a></li>`).join('')}</ul>`,
    `<h2>API（按用途）</h2><table><thead><tr><th>分组</th><th>包</th></tr></thead><tbody>${groupRows}</tbody></table>`,
    `<h2>文档注释覆盖</h2><p class="muted">${exportsCount - api.undocumented.length} / ${exportsCount} 个导出有文档注释。</p>`,
  ].join('\n');
  writeFileSync(join(outDir, 'index.html'), page('Otter 文档', index, 0));
  pages++;
  return { pages, undocumented: api.undocumented.length, exports: exportsCount };
}

if (import.meta.filename === process.argv[1]) {
  const out = process.argv[2] ?? join(root, 'docs-site', 'dist');
  const r = buildDocsSite(out);
  console.log(`✓ docs site: ${r.pages} pages in ${out}; ${r.exports - r.undocumented} / ${r.exports} exports documented`);
}
