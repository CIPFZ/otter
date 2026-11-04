import { describe, expect, it } from 'vitest';
import type { ApiEntry, ApiExport, ApiSurface } from '../lib/api-surface.ts';
import { docsGate, exampleRegions, tableCodes } from '../lib/docs-gate.ts';
import { errorCodesIn } from '../lib/error-codes.ts';
import { markdown } from '../docs-site.ts';

describe('docs site generator', () => {
  it('renders the README Markdown subset: headings one level down, lists, tables, code, inline marks', () => {
    const html = markdown('## A\n\nText with `code` and **bold** [link](x.html).\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = 1 < 2;\n```');
    expect(html).toContain('<h3>A</h3>');
    expect(html).toContain('<p>Text with <code>code</code> and <strong>bold</strong> <a href="x.html">link</a>.</p>');
    expect(html).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(html).toContain('<thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody>');
    expect(html).toContain('<pre><code class="lang-ts">const x = 1 &lt; 2;</code></pre>');
  });
});

const x = (name: string, over: Partial<ApiExport> = {}): ApiExport => ({ name, kind: 'function', signature: '', doc: 'Does a thing.', tags: [], links: [], members: [], ...over });
const entry = (specifier: string, exports: ApiExport[]): ApiEntry => ({ specifier, pkg: specifier, file: 'x.ts', css: false, exports, variables: [] });
const EXAMPLE = { name: 'example', text: "```ts\nimport { createVodPlayer } from '@otter-player/presets/vod';\n\nconst player = createVodPlayer({ container });\n```" };
/** A surface the gate passes: every gated example present, the error table equal to the sources. */
const passing = (): { api: ApiSurface; examples: Map<string, { code: string; file: string }>; errorCodes: Map<string, string[]> } => {
  const code = "import { createVodPlayer } from '@otter-player/presets/vod';\n\nconst player = createVodPlayer({ container });";
  const regions = ['createPlayer', 'basic', 'vod', 'live', 'lowlatency', 'ott-drm', 'surveillance', 'danmaku', 'shorts', 'tv', 'background', 'react', 'vue', 'svelte'];
  const fns: [string, string][] = [
    ['@otter-player/presets', 'createPlayer'],
    ['@otter-player/presets/basic', 'createBasicPlayer'],
    ['@otter-player/presets/vod', 'createVodPlayer'],
    ['@otter-player/presets/live', 'createLivePlayer'],
    ['@otter-player/presets/lowlatency', 'createLowLatencyPlayer'],
    ['@otter-player/presets/ott-drm', 'createOttDrmPlayer'],
    ['@otter-player/presets/surveillance', 'createSurveillancePlayer'],
    ['@otter-player/presets/danmaku', 'createDanmakuPlayer'],
    ['@otter-player/presets/shorts', 'createShortsPlayer'],
    ['@otter-player/presets/tv', 'createTvPlayer'],
    ['@otter-player/presets/background', 'createBackgroundPlayer'],
    ['@otter-player/react', 'OtterPlayer'],
    ['@otter-player/vue', 'OtterPlayer'],
    ['@otter-player/svelte', 'otterPlayer'],
  ];
  const entries = fns.map(([s, n]) => entry(s, [x(n, { tags: [EXAMPLE] })]));
  entries.push(entry('@otter-player/core', [x('OtterError', { kind: 'interface', doc: 'Errors.\n\n| Code | Type |\n|---|---|\n| `noRoute` | media |\n| `shaka*` | varies |' })]));
  return { api: { entries, undocumented: [] }, examples: new Map(regions.map((r) => [r, { code, file: `e2e/site/examples/${r}.ts` }])), errorCodes: new Map([['noRoute', ['a.ts']], ['shaka*', ['b.ts']]]) };
};

describe('TSDoc gate (AGENT §4)', () => {
  it('passes a surface that keeps every convention', () => {
    expect(docsGate(passing())).toEqual([]);
  });

  it('fails an undocumented user-facing export; an internal one and an allowlisted structural type pass', () => {
    const input = passing();
    const entries = [...input.api.entries, entry('@otter-player/format-hls', [x('createHlsFormat', { doc: '' })]), entry('@otter-player/media', [x('createSession', { doc: '' })]), entry('@otter-player/core', [x('Unsubscribe', { kind: 'type', doc: '' })])];
    expect(docsGate({ ...input, api: { ...input.api, entries } })).toEqual(['@otter-player/format-hls#createHlsFormat: no doc comment']);
  });

  it('fails an option without a doc comment, and an optional one without @defaultValue', () => {
    const input = passing();
    const opts = x('HlsFormatOptions', {
      kind: 'interface',
      members: [
        { name: 'engine', type: 'string', doc: 'Engine.', tags: [], links: [], optional: true },
        { name: 'abr', type: 'string', doc: '', tags: [{ name: 'defaultValue', text: "'otter'" }], links: [], optional: true },
        { name: 'type', type: 'string', doc: 'Type.', tags: [], links: [], optional: false },
      ],
    });
    const entries = [...input.api.entries, entry('@otter-player/format-hls', [opts])];
    expect(docsGate({ ...input, api: { ...input.api, entries } })).toEqual(['@otter-player/format-hls#HlsFormatOptions.engine: optional option without @defaultValue', '@otter-player/format-hls#HlsFormatOptions.abr: option without a doc comment']);
  });

  it('fails @see and {@link} to names no entry exports, and stray tags (an unquoted @scope/name)', () => {
    const input = passing();
    const bad = x('createHlsFormat', { tags: [{ name: 'see', text: 'internalHelper' }, { name: 'otter-player', text: '/text, not by the engines.' }], links: ['OtterError', 'secretThing.x'] });
    const entries = [...input.api.entries, entry('@otter-player/format-hls', [bad])];
    expect(docsGate({ ...input, api: { ...input.api, entries } })).toEqual([
      '@otter-player/format-hls#createHlsFormat: @see internalHelper: not a public export',
      '@otter-player/format-hls#createHlsFormat: unknown tag @otter-player (an unquoted `@scope/name` in the comment? quote it with backticks)',
      '@otter-player/format-hls#createHlsFormat: {@link secretThing.x}: not a public export',
    ]);
  });

  it('fails a gated function without @example, or one that drifted from its e2e region', () => {
    const input = passing();
    const entries = input.api.entries.map((e) =>
      e.specifier === '@otter-player/presets/vod' ? { ...e, exports: [x('createVodPlayer', { tags: [{ name: 'example', text: '```ts\nconst player = createVodPlayer({ container, title: "x" });\n```' }] })] } : e.specifier === '@otter-player/presets/tv' ? { ...e, exports: [x('createTvPlayer')] } : e,
    );
    expect(docsGate({ ...input, api: { ...input.api, entries } })).toEqual([
      '@otter-player/presets/vod#createVodPlayer: @example differs from e2e/site/examples/vod.ts (region vod)',
      '@otter-player/presets/tv#createTvPlayer: no @example (take it from e2e/site/examples/tv.ts, region tv)',
    ]);
  });

  it("fails an error code missing from OtterError's table, and a table row no source raises", () => {
    const input = passing();
    const errorCodes = new Map([['noRoute', ['a.ts']], ['liveOnly', ['packages/format-flv/src/index.ts']]]);
    expect(docsGate({ ...input, errorCodes })).toEqual(["error code liveOnly (packages/format-flv/src/index.ts): not in OtterError's table", "error code shaka*: in OtterError's table, raised nowhere"]);
  });

  it('reads example regions (TS and Svelte markers, dedented) and table codes', () => {
    const regions = exampleRegions([
      { name: 'a.ts', text: "import x from './x';\n  // #region example:a\n  const p = 1;\n    nested();\n  // #endregion\n" },
      { name: 'B.svelte', text: '<!-- #region example:b -->\n<script>\n  let x = 1;\n</script>\n<!-- #endregion -->\n' },
    ]);
    expect(regions.get('a')).toEqual({ code: 'const p = 1;\n  nested();', file: 'a.ts' });
    expect(regions.get('b')?.code).toBe('<script>\n  let x = 1;\n</script>');
    expect(tableCodes('| Code | x |\n|---|---|\n| `a` | 1 |\n| `flv*` | 2 |\nnot | `c` |')).toEqual(['a', 'flv*']);
  });
});

describe('error codes from the sources', () => {
  it('takes literal details, template prefixes, alternatives, and the codes passed to a helper that forwards its parameter', () => {
    const src = `
      const fatal = (type, details, message) => createError({ type, details, fatal: true, recoverable: false, message });
      function pluginError(details: string) { return createError({ type: 'other', details, fatal: true, recoverable: false }); }
      throw createError({ type: 'media', details: 'noRoute', fatal: true, recoverable: false });
      errors.push({ fatal: true, details: \`flv\${type}\` });
      createError({ type: 'media', details: name === 'NotAllowedError' ? 'playNotAllowed' : 'playFailed', fatal: false, recoverable: true });
      fail(fatal('mux', 'demuxFailed', 'x'));
      throw pluginError('pluginDuplicate');
      const other = { details: e.details };
    `;
    expect(errorCodesIn(src).sort()).toEqual(['demuxFailed', 'flv*', 'noRoute', 'playFailed', 'playNotAllowed', 'pluginDuplicate'].sort());
  });
});
