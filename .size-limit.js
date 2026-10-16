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

// M1 scenario report (no limit): first-screen code vs. engine chunks loaded on demand. With L1
// engine adapters the SPEC §19 HLS / DASH targets are not reachable before M6 (ADR-003 §9).
const ENGINES = ['hls.js', 'shaka-player', 'mpegts.js'];
const engineFile = {
  'hls.js': 'packages/engine-adapter-hlsjs/node_modules/hls.js/dist/hls.mjs',
  'hls.js/light': 'packages/engine-adapter-hlsjs/node_modules/hls.js/dist/hls.light.mjs',
  'shaka-player': 'packages/engine-adapter-shaka/node_modules/shaka-player/dist/shaka-player.compiled.js',
  'mpegts.js': 'packages/engine-adapter-mpegts/node_modules/mpegts.js/dist/mpegts.js',
};
const scenarios = [
  { name: 'M1 scenario: progressive / native (first screen)', path: 'tooling/size/m1-progressive.js', import: '*', gzip: true },
  { name: 'M1 scenario: streaming formats (first screen, engines excluded)', path: 'tooling/size/m1-streaming.js', import: '*', gzip: true, ignore: ENGINES },
  ...Object.entries(engineFile).map(([e, path]) => ({ name: `engine chunk (dynamic import): ${e}`, path, gzip: true })),
];

const reports = readdirSync('packages')
  .filter((name) => existsSync(`packages/${name}/tsconfig.json`))
  .sort()
  .map((name) => ({ name: `@otter-player/${name}`, path: dist(name), import: '*', gzip: true }));

export default [...budgets, ...scenarios, ...reports];
