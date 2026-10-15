// Scaffolds a workspace package with the repo conventions (ESM, sideEffects: false — or ["*.css"]
// for CSS-only skins, ADR-002 — source export condition, project references) and registers it in
// tsconfig.build.json.
//
//   node scripts/new-package.ts <name> --description "..." [--deps core,media] [--no-dom] [--css]
//
// --no-dom  compile against lib ES2022 only (must stay Worker/DOM-free, like core)
// --css     CSS-only package (skins): src/index.css is copied to dist, no TypeScript or JS at all

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const root = join(import.meta.dirname, '..');

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    description: { type: 'string' },
    deps: { type: 'string', default: '' },
    'no-dom': { type: 'boolean', default: false },
    css: { type: 'boolean', default: false },
  },
});

const name = positionals[0];
if (name === undefined || !/^[a-z][a-z0-9-]*$/.test(name)) {
  throw new Error('usage: new-package.ts <kebab-name> --description "..." [--deps a,b] [--no-dom] [--css]');
}
if (values.description === undefined) throw new Error('--description is required');

const dir = join(root, 'packages', name);
if (existsSync(dir)) throw new Error(`packages/${name} already exists`);
const deps = values.deps.split(',').filter((d) => d !== '');
for (const d of deps) {
  if (!existsSync(join(root, 'packages', d))) throw new Error(`unknown workspace dependency "${d}"`);
}

const write = (rel: string, content: string): void => {
  const file = join(dir, rel);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content);
};
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const pkg: Record<string, unknown> = {
  name: `@otter-player/${name}`,
  version: '0.0.0',
  description: values.description,
  license: 'Apache-2.0',
  type: 'module',
  sideEffects: false,
};

if (values.css) {
  Object.assign(pkg, {
    // Importing a skin from JS must keep its CSS; skins have no JS that could be tree-shaken.
    sideEffects: ['*.css'],
    exports: { '.': { style: './dist/index.css', default: './dist/index.css' } },
    files: ['dist'],
    scripts: { build: 'node ../../tooling/copy-css.ts' },
  });
  write('package.json', json(pkg));
  write('src/index.css', `/* @otter-player/${name}: CSS only (SPEC §14.4). */\n`);
} else {
  Object.assign(pkg, {
    exports: {
      '.': {
        '@otter-player/source': './src/index.ts',
        types: './dist/index.d.ts',
        default: './dist/index.js',
      },
    },
    files: ['dist', 'src'],
    scripts: { build: 'vite build --config ../../tooling/vite.lib.config.ts' },
  });
  if (deps.length > 0) {
    pkg['dependencies'] = Object.fromEntries(deps.map((d) => [`@otter-player/${d}`, 'workspace:*']));
  }
  write('package.json', json(pkg));
  const lib = values['no-dom'] ? ['ES2022'] : ['ES2022', 'DOM'];
  write(
    'tsconfig.json',
    json({
      extends: '../../tsconfig.base.json',
      compilerOptions: { rootDir: 'src', outDir: 'dist', tsBuildInfoFile: 'dist/.tsbuildinfo', lib },
      include: ['src'],
      ...(deps.length > 0 ? { references: deps.map((d) => ({ path: `../${d}` })) } : {}),
    }),
  );
  write('src/index.ts', 'export {};\n');

  const buildConfigPath = join(root, 'tsconfig.build.json');
  const buildConfig = JSON.parse(readFileSync(buildConfigPath, 'utf8')) as { references: { path: string }[] };
  buildConfig.references.push({ path: `packages/${name}` });
  buildConfig.references.sort((a, b) => a.path.localeCompare(b.path));
  writeFileSync(buildConfigPath, json(buildConfig));
}

console.log(`created packages/${name}`);
