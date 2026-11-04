// The TSDoc gate (AGENT §4, the six conventions; run by `pnpm check:docs-site`). For the
// user-facing entries: every export documented (pure structural types excepted by name), every
// member of an options interface documented and, when optional, carrying @defaultValue; `@see` and
// `{@link}` pointing at public exports only; no stray tags (an unquoted `@otter-player/x` in a
// comment starts a tag and cuts the text). For createPlayer, the ten presets and the three
// bindings: an @example equal to its region in the e2e example site. For core's OtterError: an
// error-code table that lists exactly the codes the sources raise. Internal packages: reported only.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ApiEntry, ApiSurface, ApiTag } from './api-surface.ts';
import type { ErrorCodes } from './error-codes.ts';

/** The entries a host imports: gated at 100 %. */
export const USER_FACING = /^@otter-player\/(core|presets(\/[\w-]+)?|react|vue|svelte|ui-core|input(\/remote)?|format-[\w-]+|engine-adapter-[\w-]+|engine-pipeline(\/[\w-]+)?)$/;

/** Pure structural types (a function signature or a union with nothing to say): `entry#Name`. */
export const STRUCTURAL: ReadonlySet<string> = new Set([
  '@otter-player/core#Unsubscribe',
  '@otter-player/core#EventHandler',
  '@otter-player/core#StateListener',
  '@otter-player/core#ActionHandler',
  '@otter-player/core#QoeEventType',
]);

/** Interfaces whose members a host writes (option bags), beyond the `*Options` / `*Props` names. */
const OPTION_BAGS: ReadonlySet<string> = new Set(['RemoteSeek', 'InputTimings']);
export const isOptionBag = (name: string): boolean => /(Options|Props)$/.test(name) || OPTION_BAGS.has(name);

/** TSDoc tags in use; anything else is a typo or an unquoted `@scope/name`. */
const KNOWN_TAGS: ReadonlySet<string> = new Set(['param', 'returns', 'defaultValue', 'example', 'see', 'remarks', 'deprecated', 'typeParam', 'throws', 'privateRemarks', 'internal', 'beta']);

/** Export (`entry#Name`) → its example region in e2e/site (`// #region example:<region>`). */
export const EXAMPLES: Readonly<Record<string, string>> = {
  '@otter-player/presets#createPlayer': 'createPlayer',
  '@otter-player/presets/basic#createBasicPlayer': 'basic',
  '@otter-player/presets/vod#createVodPlayer': 'vod',
  '@otter-player/presets/live#createLivePlayer': 'live',
  '@otter-player/presets/lowlatency#createLowLatencyPlayer': 'lowlatency',
  '@otter-player/presets/ott-drm#createOttDrmPlayer': 'ott-drm',
  '@otter-player/presets/surveillance#createSurveillancePlayer': 'surveillance',
  '@otter-player/presets/danmaku#createDanmakuPlayer': 'danmaku',
  '@otter-player/presets/shorts#createShortsPlayer': 'shorts',
  '@otter-player/presets/tv#createTvPlayer': 'tv',
  '@otter-player/presets/background#createBackgroundPlayer': 'background',
  '@otter-player/react#OtterPlayer': 'react',
  '@otter-player/vue#OtterPlayer': 'vue',
  '@otter-player/svelte#otterPlayer': 'svelte',
};

const dedent = (s: string): string => {
  const lines = s.replace(/^\n+|\s+$/g, '').split('\n');
  const indent = Math.min(...lines.filter((l) => l.trim() !== '').map((l) => /^ */.exec(l)?.[0].length ?? 0));
  return lines.map((l) => l.slice(indent)).join('\n');
};

/** The example regions of a site's sources: `// #region example:<name>` (or `<!-- … -->`) to `#endregion`. */
export function exampleRegions(files: readonly { name: string; text: string }[]): Map<string, { code: string; file: string }> {
  const out = new Map<string, { code: string; file: string }>();
  for (const f of files) {
    for (const m of f.text.matchAll(/^[ \t]*(?:\/\/|<!--) #region example:([\w-]+)(?: -->)?\n([\s\S]*?)\n[ \t]*(?:\/\/|<!--) #endregion/gm)) {
      out.set(m[1] as string, { code: dedent(m[2] as string), file: f.name });
    }
  }
  return out;
}

/** The code of an @example tag: its fenced block (TS keeps the fence in the tag text). */
export const exampleCode = (tag: ApiTag): string => dedent(/```\w*\n([\s\S]*?)```/.exec(tag.text)?.[1] ?? tag.text);

/** The e2e example site's sources (e2e/site/examples/). */
export function readExampleRegions(root: string): Map<string, { code: string; file: string }> {
  const dir = join(root, 'e2e/site/examples');
  return exampleRegions(readdirSync(dir).map((name) => ({ name: `e2e/site/examples/${name}`, text: readFileSync(join(dir, name), 'utf8') })));
}

/** The codes in the table of an export's comment (first column, backquoted). */
export const tableCodes = (doc: string): string[] => [...doc.matchAll(/^\|\s*`([\w*]+)`\s*\|/gm)].map((m) => m[1] as string);

export interface GateInput {
  readonly api: ApiSurface;
  readonly examples: ReadonlyMap<string, { code: string; file: string }>;
  readonly errorCodes: ErrorCodes;
}

/** The problems the gate finds (empty: it passes). */
export function docsGate({ api, examples, errorCodes }: GateInput): string[] {
  const problems: string[] = [];
  const publicNames = new Set(api.entries.flatMap((e) => e.exports.map((x) => x.name)));
  const userFacing = api.entries.filter((e: ApiEntry) => !e.css && USER_FACING.test(e.specifier));
  const checkRefs = (where: string, tags: readonly ApiTag[], links: readonly string[]): void => {
    for (const t of tags) {
      if (!KNOWN_TAGS.has(t.name)) problems.push(`${where}: unknown tag @${t.name} (an unquoted \`@scope/name\` in the comment? quote it with backticks)`);
      if (t.name === 'see') {
        const target = /^\{@link\s+([\w$]+)/.exec(t.text)?.[1] ?? /^([\w$]+)/.exec(t.text)?.[1];
        if (target === undefined || !publicNames.has(target)) problems.push(`${where}: @see ${t.text.split('\n')[0]}: not a public export`);
      }
    }
    for (const l of links) {
      const target = l.split(/[.#]/)[0] as string;
      if (!publicNames.has(target)) problems.push(`${where}: {@link ${l}}: not a public export`);
    }
  };
  for (const e of userFacing) {
    for (const x of e.exports) {
      const id = `${e.specifier}#${x.name}`;
      if (x.doc === '' && !STRUCTURAL.has(id)) problems.push(`${id}: no doc comment`);
      checkRefs(id, x.tags, x.links);
      if (x.kind === 'interface' && isOptionBag(x.name)) {
        for (const m of x.members) {
          if (m.doc === '') problems.push(`${id}.${m.name}: option without a doc comment`);
          if (m.optional && !m.tags.some((t) => t.name === 'defaultValue')) problems.push(`${id}.${m.name}: optional option without @defaultValue`);
        }
      }
      for (const m of x.members) checkRefs(`${id}.${m.name}`, m.tags, m.links);
    }
  }
  for (const [id, region] of Object.entries(EXAMPLES)) {
    const [specifier, name] = id.split('#') as [string, string];
    const x = api.entries.find((e) => e.specifier === specifier)?.exports.find((y) => y.name === name);
    const tag = x?.tags.find((t) => t.name === 'example');
    const want = examples.get(region);
    if (want === undefined) problems.push(`${id}: no example region "${region}" in e2e/site/examples`);
    else if (tag === undefined) problems.push(`${id}: no @example (take it from ${want.file}, region ${region})`);
    else if (exampleCode(tag) !== want.code) problems.push(`${id}: @example differs from ${want.file} (region ${region})`);
  }
  const otterError = api.entries.find((e) => e.specifier === '@otter-player/core')?.exports.find((x) => x.name === 'OtterError');
  const listed = new Set(tableCodes(otterError?.doc ?? ''));
  for (const [code, files] of errorCodes) if (!listed.has(code)) problems.push(`error code ${code} (${files.join(', ')}): not in OtterError's table`);
  for (const code of listed) if (!errorCodes.has(code)) problems.push(`error code ${code}: in OtterError's table, raised nowhere`);
  return problems;
}

/** Coverage of the internal packages (reported, not gated). */
export function internalCoverage(api: ApiSurface): { documented: number; total: number } {
  const internal = api.entries.filter((e) => !e.css && !USER_FACING.test(e.specifier));
  const total = internal.reduce((n, e) => n + e.exports.length, 0);
  return { documented: total - internal.reduce((n, e) => n + e.exports.filter((x) => x.doc === '').length, 0), total };
}
