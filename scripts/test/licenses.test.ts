import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { audit, cdnInputs, classify, licenseProblems } from '../lib/licenses.ts';

describe('license rules of published packages (ADR-014 §4a)', () => {
  it('classifies names and SPDX expressions', () => {
    expect(['MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'ISC', '0BSD'].map(classify)).toEqual(Array(6).fill('permissive'));
    expect(classify('MPL-2.0')).toBe('mpl');
    expect(classify('LGPL-2.1-or-later')).toBe('lgpl');
    expect(classify('GPL-3.0 (repository LICENSE)')).toBe('gpl');
    expect(classify('AGPL-3.0')).toBe('gpl');
    expect(classify('(MIT OR GPL-3.0)')).toBe('permissive');
    expect(classify('MIT AND LGPL-3.0')).toBe('lgpl');
    expect(classify(undefined)).toBe('unknown');
    expect(classify('WTFPL')).toBe('unknown');
  });

  it('refuses GPL, LGPL and unlicensed code in a package; reads copied files by header, then UPSTREAM.json; follows the dependency tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'otter-licenses-'));
    const pkg = join(root, 'packages', 'p');
    mkdirSync(join(pkg, 'src/vendor/a'), { recursive: true });
    mkdirSync(join(pkg, 'src/vendor/b'), { recursive: true });
    writeFileSync(join(pkg, 'src/vendor/a/UPSTREAM.json'), JSON.stringify({ project: 'a', license: 'GPL-3.0' }));
    writeFileSync(join(pkg, 'src/vendor/a/x.js'), '// no header\n');
    writeFileSync(join(pkg, 'src/vendor/b/UPSTREAM.json'), JSON.stringify({ project: 'b' }));
    writeFileSync(join(pkg, 'src/vendor/b/y.ts'), '// Derived from b@0123abc src/y.ts MIT\n');
    writeFileSync(join(pkg, 'src/vendor/b/z.ts'), '// nothing\n');
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@otter-player/p', dependencies: { dep: '1', '@otter-player/core': 'workspace:*' } }));
    for (const [name, license, deps] of [['dep', 'MIT', { sub: '1' }], ['sub', 'LGPL-3.0', {}]] as const) {
      mkdirSync(join(root, 'node_modules', name), { recursive: true });
      writeFileSync(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '1.0.0', license, dependencies: deps }));
    }
    const items = audit(root, pkg);
    expect(items.map((i) => `${i.kind} ${i.via ?? i.name} ${i.license}`).sort()).toEqual(
      ['copied packages/p/src/vendor/a/x.js GPL-3.0', 'copied packages/p/src/vendor/b/y.ts MIT', 'copied packages/p/src/vendor/b/z.ts ', 'dependency dep MIT', 'dependency dep > sub LGPL-3.0'].sort(),
    );
    expect(licenseProblems('p', items)).toEqual([
      'p: copied packages/p/src/vendor/a/x.js is GPL-3.0: GPL / AGPL may not be in a public package',
      'p: copied packages/p/src/vendor/b/z.ts is without a license: no recognised license',
      'p: dependency dep > sub is LGPL-3.0: LGPL only as a separately loaded artefact outside the tarball',
    ]);
  });

  it.each(['/', '\\'])('audits workspace and npm CDN inputs with %s separators', (separator) => {
    const root = mkdtempSync(join(tmpdir(), 'otter-cdn-licenses-'));
    try {
      const pkg = join(root, 'packages', 'cdn');
      const workspace = join(root, 'packages', 'p');
      const vendor = join(root, 'vendor', 'a');
      const depPath = 'node_modules/.pnpm/@scope+dep@1.0.0/node_modules/@scope/dep';
      const dep = join(root, depPath);
      for (const dir of [join(pkg, 'dist'), join(workspace, 'dist'), vendor, dep]) mkdirSync(dir, { recursive: true });
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@otter-player/cdn', otter: { cdn: true } }));
      writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: '@otter-player/p', otter: { bundle: ['@otter-vendor/a'] } }));
      writeFileSync(join(workspace, 'dist/index.js'), '// built workspace code\n');
      writeFileSync(join(vendor, 'UPSTREAM.json'), JSON.stringify({ project: 'a', license: 'GPL-3.0' }));
      writeFileSync(join(vendor, 'x.js'), '// vendored code\n');
      writeFileSync(join(dep, 'package.json'), JSON.stringify({ name: '@scope/dep', version: '1.0.0', license: 'MIT' }));
      writeFileSync(join(dep, 'index.js'), '// npm dependency\n');
      const inputs = ['packages/p/dist/index.js', depPath + '/index.js'].map((file) => file.replaceAll('/', separator));
      writeFileSync(join(pkg, 'dist/inputs.json'), JSON.stringify(inputs));

      expect(cdnInputs(root, pkg)).toEqual({
        workspace: ['p'],
        npm: [{ name: '@scope/dep', version: '1.0.0', license: 'MIT', dir: dep }],
      });
      const items = audit(root, pkg);
      expect(items).toEqual([
        { kind: 'bundled', name: 'vendor/a/x.js', license: 'GPL-3.0', verdict: 'gpl' },
        { kind: 'bundled', name: '@scope/dep@1.0.0', license: 'MIT', verdict: 'permissive' },
      ]);
      expect(licenseProblems('cdn', items)).toEqual(['cdn: bundled vendor/a/x.js is GPL-3.0: GPL / AGPL may not be in a public package']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
