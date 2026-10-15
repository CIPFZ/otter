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

const reports = readdirSync('packages')
  .filter((name) => existsSync(`packages/${name}/tsconfig.json`))
  .sort()
  .map((name) => ({ name: `@otter-player/${name}`, path: dist(name), import: '*', gzip: true }));

export default [...budgets, ...reports];
