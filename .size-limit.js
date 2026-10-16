// Size budgets (SPEC §1.1, §19). Budgets are acceptance criteria: exceeding one fails CI.
// Every JS package is also reported without a limit so growth is visible in each PR.
// Measured with esbuild (minified, all dependencies, gzip), which also bundles imported CSS.
import { existsSync, readdirSync } from 'node:fs';

const dist = (name) => `packages/${name}/dist/index.js`;

const budgets = [
  { name: 'budget: core (SPEC §1.1, ≤ 15 KB)', path: dist('core'), import: '*', gzip: true, limit: '15 KB' },
  {
    name: 'budget: ui-skin-default + ui-core + presentation + text (SPEC §1.1, ≤ 30 KB)',
    // Combined entry: size-limit cannot `import: '*'` several files in one check.
    path: 'tooling/size/default-ui.js',
    import: '*',
    gzip: true,
    limit: '30 KB',
  },
  { name: 'budget: danmaku (SPEC §1.1, ≤ 10 KB)', path: dist('danmaku'), import: '*', gzip: true, limit: '10 KB' },
];

// SPEC §19 scenarios, two scopes (ADR-004):
// - own code: Otter packages + non-engine L1 deps; engines ignored. Gate for M1-M5.
// - with engines: own code + the engine chunks the scenario's first playback loads. Report only
//   until M6 (no limit). Engines must stay dynamic chunks; check-engine-chunks enforces that.
const ENGINE_FILES = {
  'hls.js': 'packages/engine-adapter-hlsjs/node_modules/hls.js/dist/hls.mjs',
  'shaka-player': 'packages/engine-adapter-shaka/node_modules/shaka-player/dist/shaka-player.compiled.js',
  'mpegts.js': 'packages/engine-adapter-mpegts/node_modules/mpegts.js/dist/mpegts.js',
};
const ENGINES = Object.keys(ENGINE_FILES);

/**
 * id, SPEC §19 row, own-code limit, engines loaded by the scenario's default first playback,
 * and the milestone the limit becomes blocking. The Hero target (< 5 KB, no UI, native mp4) is
 * a dedicated minimal preset that ships in M6 (SPEC §21); until then its general-purpose
 * composition (media session + router, 8.6 KB) is reported, not gated.
 */
const SCENARIOS = [
  ['short-vod', '短视频 / 简单点播', '30 KB', []],
  ['long-vod', '长视频点播 + 多清晰度 + 字幕', '80 KB', ['hls.js']],
  ['live', '直播 + LL-HLS / LL-DASH', '90 KB', ['hls.js']],
  ['cn-live', '国内直播 / 电商', '70 KB', ['mpegts.js']],
  ['danmaku', 'B 站式弹幕站', '120 KB', ['shaka-player']],
  ['background', '背景视频 / Hero', '5 KB', [], 'M6'],
  ['shorts', '沉浸竖屏信息流', '60 KB', []],
  ['tv', '电视遥控器', '90 KB', ['hls.js']],
];

const scenarios = SCENARIOS.flatMap(([id, row, limit, engines, gatedFrom]) => {
  const own = {
    name: gatedFrom === undefined ? `§19 own code: ${row} (≤ ${limit})` : `§19 own code (report, ≤ ${limit} gated from ${gatedFrom}): ${row}`,
    path: `tooling/size/scenario-${id}.js`,
    import: '*',
    gzip: true,
    ignore: ENGINES,
    ...(gatedFrom === undefined ? { limit } : {}),
  };
  if (engines.length === 0) return [own];
  return [own, { name: `§19 with engines (report): ${row} + ${engines.join(' + ')}`, path: [`tooling/size/scenario-${id}.js`, ...engines.map((e) => ENGINE_FILES[e])], gzip: true, ignore: ENGINES }];
});

const engineChunks = Object.entries(ENGINE_FILES).map(([e, path]) => ({ name: `engine chunk (dynamic import): ${e}`, path, gzip: true }));

const reports = readdirSync('packages')
  .filter((name) => existsSync(`packages/${name}/tsconfig.json`))
  .sort()
  .map((name) => ({ name: `@otter-player/${name}`, path: dist(name), import: '*', gzip: true }));

export default [...budgets, ...scenarios, ...engineChunks, ...reports];
