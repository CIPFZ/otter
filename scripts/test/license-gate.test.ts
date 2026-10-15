import { describe, expect, it } from 'vitest';
import {
  checkLicense,
  classifyLicenseId,
  parseSpdx,
  runGate,
  type DependencyNode,
  type ProjectTree,
} from '../lib/license.ts';
import { policy } from '../license-policy.ts';

const dep = (name: string, license: string | undefined, dependencies: DependencyNode[] = []): DependencyNode => ({
  name,
  version: '1.0.0',
  license,
  workspace: false,
  installed: true,
  dependencies,
});

const project = (name: string, prod: DependencyNode[], dev: DependencyNode[] = []): ProjectTree => ({
  name,
  license: 'Apache-2.0',
  prod,
  dev,
});

describe('parseSpdx', () => {
  it('parses precedence, parentheses and WITH', () => {
    expect(parseSpdx('MIT OR Apache-2.0 AND BSD-3-Clause')).toEqual({
      kind: 'or',
      left: { kind: 'license', id: 'MIT' },
      right: {
        kind: 'and',
        left: { kind: 'license', id: 'Apache-2.0' },
        right: { kind: 'license', id: 'BSD-3-Clause' },
      },
    });
    expect(parseSpdx('(Apache-2.0 WITH LLVM-exception)')).toEqual({
      kind: 'license',
      id: 'Apache-2.0',
      exception: 'LLVM-exception',
    });
  });

  it('rejects malformed expressions', () => {
    expect(() => parseSpdx('(MIT')).toThrow(SyntaxError);
    expect(() => parseSpdx('MIT OR')).toThrow(SyntaxError);
    expect(() => parseSpdx('MIT Apache-2.0')).toThrow(SyntaxError);
  });
});

describe('classifyLicenseId', () => {
  it.each([
    ['MIT', 'permissive'],
    ['Apache-2.0', 'permissive'],
    ['MPL-2.0', 'tooling'],
    ['LGPL-2.1-or-later', 'lgpl'],
    ['LGPL-3.0+', 'lgpl'],
    ['GPL-3.0-only', 'gpl'],
    ['AGPL-3.0', 'gpl'],
    ['WTFPL', 'unknown'],
  ] as const)('%s -> %s', (id, cls) => {
    expect(classifyLicenseId(id, policy)).toBe(cls);
  });
});

describe('checkLicense', () => {
  const prod = { scope: 'prod', lgplAllowed: false } as const;
  it('takes the best branch of OR and the worst of AND', () => {
    expect(checkLicense('(GPL-3.0 OR MIT)', policy, prod).ok).toBe(true);
    expect(checkLicense('MIT AND GPL-3.0', policy, prod).ok).toBe(false);
  });
  it('allows tooling licenses only in dev', () => {
    expect(checkLicense('MPL-2.0', policy, prod).ok).toBe(false);
    expect(checkLicense('MPL-2.0', policy, { scope: 'dev', lgplAllowed: false }).ok).toBe(true);
  });
  it('fails non-SPDX strings', () => {
    expect(checkLicense('SEE LICENSE IN LICENSE.md', policy, prod)).toMatchObject({ ok: false });
  });
});

describe('runGate', () => {
  it('passes a permissive forest', () => {
    const report = runGate([project('@otter-player/core', [dep('a', 'MIT', [dep('b', 'ISC')])])], policy);
    expect(report.violations).toEqual([]);
    expect(report.scanned).toBe(2);
  });

  it('blocks GPL anywhere, including deep in dev tooling', () => {
    const report = runGate(
      [project('otter-monorepo', [], [dep('tool', 'MIT', [dep('gpl-thing', 'GPL-3.0-only')])])],
      policy,
    );
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]).toMatchObject({
      package: 'gpl-thing@1.0.0',
      scope: 'dev',
      chain: ['otter-monorepo', 'tool@1.0.0', 'gpl-thing@1.0.0'],
    });
  });

  it('allows LGPL only in decoder-* and text-ass runtime dependencies', () => {
    const libde265 = dep('libde265.js', 'LGPL-3.0');
    const ok = runGate(
      [
        project('@otter-player/decoder-wasm-hevc', [libde265]),
        project('@otter-player/text-ass', [dep('libass-wasm', 'LGPL-2.1-or-later')]),
      ],
      policy,
    );
    expect(ok.violations).toEqual([]);

    const bad = runGate(
      [
        project('@otter-player/core', [libde265]),
        project('@otter-player/decoder-wasm-ffmpeg', [], [dep('ffmpeg-dev', 'LGPL-2.1')]),
      ],
      policy,
    );
    expect(bad.violations.map((v) => `${v.owner}:${v.scope}`)).toEqual([
      '@otter-player/core:prod',
      '@otter-player/decoder-wasm-ffmpeg:dev',
    ]);
  });

  it('attributes LGPL to the nearest workspace owner', () => {
    const decoder: DependencyNode = {
      ...dep('@otter-player/decoder-wasm-hevc', 'Apache-2.0', [dep('libde265.js', 'LGPL-3.0')]),
      workspace: true,
    };
    expect(runGate([project('@otter-player/presets', [decoder])], policy).violations).toEqual([]);
  });

  it('fails unknown licenses unless overridden', () => {
    const forest = [project('@otter-player/media', [dep('mystery', undefined)])];
    expect(runGate(forest, policy).violations[0]).toMatchObject({ license: 'UNKNOWN' });
    const withOverride = { ...policy, overrides: { mystery: { license: 'MIT', reason: 'LICENSE file is MIT' } } };
    expect(runGate(forest, withOverride).violations).toEqual([]);
  });

  it('requires Apache-2.0 on workspace packages and skips uninstalled optionals', () => {
    const report = runGate(
      [{ ...project('@otter-player/x', [{ ...dep('fsevents', undefined), installed: false }]), license: 'MIT' }],
      policy,
    );
    expect(report.violations.map((v) => v.reason)).toEqual(['workspace packages must be Apache-2.0 (root LICENSE)']);
    expect(report.notInstalled).toEqual(['fsevents@1.0.0']);
  });
});
