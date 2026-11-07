import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  calls: [] as { command: string; args: string[] }[],
  pre: undefined as string | undefined,
  preError: undefined as unknown,
  viewError: undefined as unknown,
  viewOutput: '',
}));
vi.mock('../lib/process.ts', () => ({
  runCommand: (command: string, args: string[]): string => {
    state.calls.push({ command, args });
    if (command === 'npm' && args[0] === 'view') {
      if (state.viewError !== undefined) throw state.viewError;
      return state.viewOutput;
    }
    if (command === 'pnpm' && args[0] === 'pack') return 'fixture-core.tgz';
    return '';
  },
}));
vi.mock('node:fs', () => ({
  existsSync: () => true,
  mkdtempSync: () => 'fixture-stage-temp',
  readdirSync: () => ['core'],
  readFileSync: (file: string): string => {
    if (!file.endsWith('pre.json')) return '{"name":"@otter-player/core","version":"0.1.0-beta.0"}';
    if (state.preError !== undefined) throw state.preError;
    if (state.pre === undefined) throw Object.assign(new Error('fixture missing prerelease state'), { code: 'ENOENT' });
    return state.pre;
  },
}));
const npmFailure = (code: string): Error => Object.assign(new Error(`fixture ${code}`), {
  stdout: JSON.stringify({ error: { code, summary: `fixture ${code}` } }),
  stderr: `npm error code ${code}\n`,
});
let argv: string[];
beforeEach(() => {
  vi.resetModules();
  state.calls.length = 0;
  state.pre = undefined;
  state.preError = undefined;
  state.viewError = npmFailure('E404');
  state.viewOutput = '"0.1.0-beta.0"';
  argv = process.argv;
  process.argv = [process.execPath, 'scripts/stage-release.ts'];
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  process.argv = argv;
  vi.restoreAllMocks();
});

describe('staged release orchestration', () => {
  it.each([
    [undefined, 'latest'],
    ['{"mode":"pre","tag":"beta"}', 'beta'],
    ['{"mode":"exit","tag":"beta"}', 'latest'],
  ] as const)('selects the dist-tag from prerelease state %s', async (pre, tag) => {
    state.pre = pre;
    await import('../stage-release.ts');
    expect(state.calls.find((call) => call.command === 'npm' && call.args[0] === 'view')?.args)
      .toEqual(['view', '@otter-player/core@0.1.0-beta.0', 'version', '--json']);
    expect(state.calls.find((call) => call.command === 'npm' && call.args[0] === 'stage')?.args)
      .toEqual(['stage', 'publish', 'fixture-core.tgz', '--tag', tag]);
  });

  it('skips the exact version already present on npm', async () => {
    state.pre = '{"mode":"pre","tag":"beta"}';
    state.viewError = undefined;
    await import('../stage-release.ts');
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]?.args[0]).toBe('view');
  });

  it.each(['ETIMEDOUT', 'ENEEDAUTH', 'E403', 'EOTP'])('stops a failed npm query with %s before packing or staging and preserves its output', async (code) => {
    state.pre = '{"mode":"pre","tag":"beta"}';
    const failure = npmFailure(code);
    state.viewError = failure;
    await expect(import('../stage-release.ts')).rejects.toBe(failure);
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]?.args).toEqual(['view', '@otter-player/core@0.1.0-beta.0', 'version', '--json']);
  });

  it('does not mistake unstructured E404 text for a missing version', async () => {
    state.pre = '{"mode":"pre","tag":"beta"}';
    const failure = Object.assign(new Error('fixture query failure'), { stdout: '', stderr: 'network failure after a previous E404' });
    state.viewError = failure;
    await expect(import('../stage-release.ts')).rejects.toBe(failure);
    expect(state.calls).toHaveLength(1);
  });

  it('does not hide prerelease file permission errors', async () => {
    const failure = Object.assign(new Error('fixture denied'), { code: 'EACCES' });
    state.preError = failure;
    await expect(import('../stage-release.ts')).rejects.toBe(failure);
    expect(state.calls).toEqual([]);
  });

  it('does not hide malformed prerelease JSON', async () => {
    state.pre = '{';
    await expect(import('../stage-release.ts')).rejects.toThrow(SyntaxError);
    expect(state.calls).toEqual([]);
  });

  it('packs a dry run without invoking npm stage', async () => {
    state.pre = '{"mode":"pre","tag":"beta"}';
    process.argv.push('--dry-run');
    await import('../stage-release.ts');
    expect(state.calls.some((call) => call.command === 'pnpm' && call.args[0] === 'pack')).toBe(true);
    expect(state.calls.some((call) => call.command === 'npm' && call.args[0] === 'stage')).toBe(false);
  });

  it.each(['{}', 'null', '"0.0.0"', 'not-json'])('stops on an invalid or mismatched successful version response: %s', async (output) => {
    state.pre = '{"mode":"pre","tag":"beta"}';
    state.viewError = undefined;
    state.viewOutput = output;
    await expect(import('../stage-release.ts')).rejects.toThrow();
    expect(state.calls).toHaveLength(1);
  });
});
