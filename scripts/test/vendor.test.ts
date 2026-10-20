import { describe, expect, it } from 'vitest';
import { checkVendor, headerLine, type VendorDir, type VendorInput } from '../lib/vendor.ts';

const upstream = {
  project: 'hls.js',
  repo: 'https://github.com/video-dev/hls.js',
  commit: 'e5ff3583965e3af16c4a4b4d2b5f7bd1ffb5b7de',
  license: 'Apache-2.0',
  level: 'L3',
  files: [{ upstream: 'src/a.ts', local: 'a.ts' }],
  localChanges: ['typed'],
};

const dir = (over: Partial<VendorDir> = {}, up: Record<string, unknown> = {}): VendorDir => ({
  dir: 'packages/x/src/vendor/hls.js',
  upstream: { ...upstream, ...up },
  files: ['a.ts'],
  contents: { 'a.ts': `${headerLine(upstream, 'src/a.ts')}\n\nexport const a = 1;\n` },
  ...over,
});

const input = (over: Partial<VendorInput> = {}): VendorInput => ({
  vendorDirs: [dir()],
  reuse: 'hls.js L1 / L3',
  ...over,
});

describe('checkVendor', () => {
  it('accepts a well-formed vendor directory', () => {
    expect(checkVendor(input())).toEqual([]);
  });

  it('requires the exact source header before any code', () => {
    const late = dir({ contents: { 'a.ts': `export const a = 1;\n${headerLine(upstream, 'src/a.ts')}\n` } });
    expect(checkVendor(input({ vendorDirs: [late] }))).toEqual([
      `packages/x/src/vendor/hls.js/a.ts: missing header "${headerLine(upstream, 'src/a.ts')}"`,
    ]);
  });

  it('flags unlisted and missing files', () => {
    const d = dir({ files: ['a.ts', 'b.ts'], contents: { 'a.ts': `${headerLine(upstream, 'src/a.ts')}\n`, 'b.ts': '' } }, {
      files: [
        { upstream: 'src/a.ts', local: 'a.ts' },
        { upstream: 'src/c.ts', local: 'c.ts' },
      ],
    });
    expect(checkVendor(input({ vendorDirs: [d] }))).toEqual([
      'packages/x/src/vendor/hls.js/b.ts: not listed in UPSTREAM.json',
      'packages/x/src/vendor/hls.js/c.ts: listed in UPSTREAM.json but missing',
    ]);
  });

  it('accepts any license (ADR-008) and a header with or without the license suffix; refuses malformed manifests', () => {
    const lgpl = dir({ contents: { 'a.ts': `${headerLine(upstream, 'src/a.ts')}, LGPL-2.1-or-later\n` } }, { license: 'LGPL-2.1-or-later' });
    expect(checkVendor(input({ vendorDirs: [lgpl] }))).toEqual([]);
    const noLicense = dir({}, { license: undefined });
    expect(checkVendor(input({ vendorDirs: [noLicense] }))).toEqual([]);
    const bad = dir({}, { commit: 'abc', level: 'L4', localChanges: [] });
    expect(checkVendor(input({ vendorDirs: [bad] }))).toEqual([
      'packages/x/src/vendor/hls.js/UPSTREAM.json: "commit" must be a full 40-character SHA',
      'packages/x/src/vendor/hls.js/UPSTREAM.json: "level" must be "L2" or "L3"',
      'packages/x/src/vendor/hls.js/UPSTREAM.json: "localChanges" must describe what was changed',
    ]);
  });

  it('requires a REUSE.md entry for every copied project (source index)', () => {
    expect(checkVendor(input({ reuse: '' }))).toEqual(['REUSE.md: hls.js is copied (packages/x/src/vendor/hls.js) but not listed']);
  });
});

describe('L2 own files', () => {
  it('own files may sit next to copies, but must not carry a copy header; ownFiles is L2-only', async () => {
    const { checkVendor } = await import('../lib/vendor.ts');
    const upstream = (extra: Record<string, unknown>) => ({
      project: 'hls.js',
      repo: 'https://github.com/video-dev/hls.js',
      commit: 'e5ff3583965e3af16c4a4b4d2b5f7bd1ffb5b7de',
      license: 'Apache-2.0',
      level: 'L2',
      files: [{ upstream: 'src/a.ts', local: 'src/a.ts' }],
      localChanges: ['x'],
      ...extra,
    });
    const header = '// Derived from hls.js@e5ff3583965e3af16c4a4b4d2b5f7bd1ffb5b7de src/a.ts, Apache-2.0\n';
    const run = (u: unknown, contents: Record<string, string>) =>
      checkVendor({
        vendorDirs: [{ dir: 'vendor/hls.js', upstream: u, files: Object.keys(contents), contents }],
        reuse: 'hls.js',
      });
    expect(run(upstream({ ownFiles: ['src/otter/**', 'package.json'] }), { 'src/a.ts': header, 'src/otter/shims.ts': '// own\n', 'package.json': '{}' })).toEqual([]);
    expect(run(upstream({ ownFiles: ['src/otter/**'] }), { 'src/a.ts': header, 'src/otter/b.ts': header })).toEqual([
      'vendor/hls.js/src/otter/b.ts: listed as own file but carries a "Derived from" header',
    ]);
    expect(run(upstream({ level: 'L3', ownFiles: ['x'] }), { 'src/a.ts': header })).toContain('vendor/hls.js/UPSTREAM.json: "ownFiles" is only for L2 packages');
  });
});
