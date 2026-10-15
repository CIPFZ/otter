import { describe, expect, it } from 'vitest';
import { checkBoundaries, scanImports, type PackageInfo } from '../lib/boundaries.ts';

const pkg = (dir: string, overrides: Partial<PackageInfo> = {}, manifest: Partial<PackageInfo['manifest']> = {}): PackageInfo => ({
  dir,
  manifest: {
    name: `@otter-player/${dir}`,
    type: 'module',
    license: 'Apache-2.0',
    sideEffects: false,
    exports: { '.': './dist/index.js' },
    ...manifest,
  },
  lib: ['ES2022', 'DOM'],
  references: [],
  imports: {},
  ...overrides,
});

describe('checkBoundaries', () => {
  it('accepts a conforming package', () => {
    expect(checkBoundaries([pkg('core', { lib: ['ES2022'] })])).toEqual([]);
  });

  it('enforces manifest conventions', () => {
    const problems = checkBoundaries([pkg('text', {}, { name: 'otter-text', sideEffects: true, main: 'index.cjs' })]);
    expect(problems).toEqual([
      'packages/text: name must be "@otter-player/text"',
      'packages/text: "sideEffects" must be false',
      'packages/text: "main" is not allowed; use "exports"',
    ]);
  });

  it('keeps core dependency-free, DOM-free and relative-only', () => {
    const problems = checkBoundaries([
      pkg('core', { lib: ['ES2022', 'DOM'], imports: { 'src/a.ts': ['./b', 'zustand'] } }, { dependencies: { zustand: '^5' } }),
    ]);
    expect(problems).toEqual([
      'packages/core: core must have no runtime dependencies',
      'packages/core: tsconfig lib must not include DOM / WebWorker',
      'packages/core: src/a.ts imports "zustand"; core may only use relative imports',
    ]);
  });

  it('skins are CSS only with sideEffects ["*.css"] (Q7)', () => {
    const skin = (overrides: Partial<PackageInfo> = {}, manifest: Partial<PackageInfo['manifest']> = {}): PackageInfo =>
      pkg('ui-skin-tv', { lib: undefined, ...overrides }, { sideEffects: ['*.css'], exports: { '.': { style: './dist/index.css' } }, ...manifest });
    expect(checkBoundaries([skin()])).toEqual([]);
    expect(
      checkBoundaries([
        skin(
          { lib: ['ES2022', 'DOM'], imports: { 'src/index.ts': [] } },
          { sideEffects: false, exports: { '.': { style: './dist/index.css', default: './dist/index.js' } } },
        ),
      ]),
    ).toEqual([
      'packages/ui-skin-tv: skin packages must declare "sideEffects": ["*.css"]',
      'packages/ui-skin-tv: skin packages are CSS only and must not have a tsconfig',
      'packages/ui-skin-tv: skin packages must not contain JS/TS (src/index.ts)',
      'packages/ui-skin-tv: skin packages may only export .css files, not ./dist/index.js',
    ]);
    // The exception is for skins only.
    expect(checkBoundaries([pkg('text', {}, { sideEffects: ['*.css'] })])).toEqual([
      'packages/text: "sideEffects" must be false',
    ]);
  });

  it('forbids render -> engine implementation and engine -> render edges', () => {
    const problems = checkBoundaries([
      pkg('ui-core', { references: ['backend-mse'] }, { dependencies: { '@otter-player/backend-mse': 'workspace:*' } }),
      pkg('format-hls', { references: ['surface'] }, { dependencies: { '@otter-player/surface': 'workspace:*' } }),
    ]);
    expect(problems).toEqual([
      'packages/ui-core: render-layer package must not depend on engine implementation backend-mse',
      'packages/format-hls: engine package must not depend on surface',
    ]);
  });

  it('requires declared deps and matching tsconfig references', () => {
    const problems = checkBoundaries([
      pkg('surface', { imports: { 'src/index.ts': ['@otter-player/core', 'node:fs'] } }),
    ]);
    expect(problems).toEqual([
      'packages/surface: src/index.ts imports "@otter-player/core" which is not a declared dependency',
      'packages/surface: src/index.ts imports Node builtin "node:fs"',
    ]);
    const refs = checkBoundaries([pkg('surface', {}, { dependencies: { '@otter-player/core': 'workspace:*' } })]);
    expect(refs).toEqual(['packages/surface: tsconfig references [] must match workspace deps [core]']);
  });
});

describe('scanImports', () => {
  it('finds static, type, re-export, side-effect and dynamic imports, ignoring comments', () => {
    const src = `
      import { a } from '@otter-player/core';
      import type { B } from "./b";
      export { c } from './c';
      export type { D } from '@otter-player/media';
      import 'side-effect';
      const m = import('hls.js');
      // import { x } from 'commented-out';
      /* import y from 'block-comment'; */
      const url = 'https://example.test/a.m3u8';
    `;
    expect(scanImports(src).sort()).toEqual(['./b', './c', '@otter-player/core', '@otter-player/media', 'hls.js', 'side-effect']);
  });
});
