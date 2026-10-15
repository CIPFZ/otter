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
  notices: `### hls.js (Apache-2.0)\n- Commit: ${upstream.commit}\n- packages/x/src/vendor/hls.js\n| \`hls.js\` | 1.7.3 |`,
  reuse: 'hls.js L1 / L3',
  runtimeDependencies: [{ pkg: '@otter-player/engine-adapter-hlsjs', name: 'hls.js' }],
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

  it('refuses copyleft code and malformed manifests', () => {
    const lgpl = dir({}, { license: 'LGPL-2.1-or-later', project: 'libde265' });
    expect(checkVendor(input({ vendorDirs: [lgpl], notices: '### libde265 (LGPL-2.1-or-later) e5ff3583965e3af16c4a4b4d2b5f7bd1ffb5b7de packages/x/src/vendor/hls.js | `hls.js` |', reuse: 'libde265 hls.js' }))).toContain(
      'packages/x/src/vendor/hls.js: libde265 is LGPL-2.1-or-later; only Apache-2.0 / MIT / BSD-2-Clause / BSD-3-Clause may be copied (REUSE §2)',
    );
    const bad = dir({}, { commit: 'abc', level: 'L4', localChanges: [] });
    expect(checkVendor(input({ vendorDirs: [bad] }))).toEqual([
      'packages/x/src/vendor/hls.js/UPSTREAM.json: "commit" must be a full 40-character SHA',
      'packages/x/src/vendor/hls.js/UPSTREAM.json: "level" must be "L2" or "L3"',
      'packages/x/src/vendor/hls.js/UPSTREAM.json: "localChanges" must describe what was changed',
    ]);
  });

  it('requires REUSE.md and THIRD_PARTY_NOTICES.md entries for copies and L1 dependencies', () => {
    const problems = checkVendor(
      input({
        notices: '',
        reuse: '',
        runtimeDependencies: [{ pkg: '@otter-player/engine-adapter-shaka', name: 'shaka-player' }],
      }),
    );
    expect(problems).toEqual([
      'THIRD_PARTY_NOTICES.md: missing "### hls.js (Apache-2.0)" for packages/x/src/vendor/hls.js',
      'THIRD_PARTY_NOTICES.md: does not list packages/x/src/vendor/hls.js',
      'REUSE.md: hls.js is copied (packages/x/src/vendor/hls.js) but not listed',
      'THIRD_PARTY_NOTICES.md: runtime dependency shaka-player (@otter-player/engine-adapter-shaka) missing from the L1 table',
      'REUSE.md: runtime dependency shaka-player (@otter-player/engine-adapter-shaka) is not listed',
    ]);
  });
});
