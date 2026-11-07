import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  calls: [] as { command: string; args: string[]; stdio?: unknown; interactive?: boolean }[],
  failBuild: false,
  viewError: undefined as unknown,
  viewOutput: '',
  trustError: undefined as unknown,
  trustOutput: '',
}));
vi.mock('../lib/process.ts', () => ({
  runCommand: (command: string, args: string[], options: { stdio?: unknown } = {}): string => {
    state.calls.push({ command, args, stdio: options.stdio });
    if (command === 'npm' && args[0] === '--version') return '11.15.0';
    if (command === 'npm' && args[0] === 'whoami') return 'fixture-owner';
    if (command === 'git' && args[0] === 'status') return '';
    if (command === 'git' && args[0] === 'rev-parse') return args.includes('--abbrev-ref') ? 'main' : 'fixture-head';
    if (command === 'pnpm' && args[0] === 'build' && state.failBuild) throw new Error('fixture build failure');
    if (command === 'npm' && args[0] === 'view') {
      if (state.viewError !== undefined) throw state.viewError;
      return state.viewOutput;
    }
    return '';
  },
}));
vi.mock('../lib/interactive-command.ts', () => ({
  runInteractiveCommand: (command: string, args: string[]): string => {
    state.calls.push({ command, args, stdio: 'inherit', interactive: true });
    if (state.trustError !== undefined) throw state.trustError;
    return state.trustOutput;
  },
}));
vi.mock('node:timers/promises', () => ({ setTimeout: async () => {} }));
vi.mock('node:fs', () => ({
  existsSync: () => true,
  readdirSync: () => ['core'],
  readFileSync: (file: string) => file.endsWith('pre.json')
    ? '{"mode":"pre","tag":"beta"}'
    : '{"name":"@otter-player/core","version":"0.1.0-beta.0"}',
}));

const npmFailure = (code: string): Error => Object.assign(new Error(`fixture ${code}`), {
  stdout: JSON.stringify({ error: { code, summary: `fixture ${code}` } }),
  stderr: `npm error code ${code}\n`,
});

let argv: string[];
let tty: PropertyDescriptor | undefined;
let stdoutTty: PropertyDescriptor | undefined;
beforeEach(() => {
  vi.resetModules();
  state.calls.length = 0;
  state.failBuild = false;
  state.viewError = npmFailure('E404');
  state.viewOutput = '"0.1.0"';
  state.trustError = undefined;
  state.trustOutput = '{"type":"github","repository":"CIPFZ/otter","file":"release.yml","permissions":["createStagedPackage"]}';
  argv = process.argv;
  process.argv = [process.execPath, 'scripts/first-publish.ts'];
  tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  for (const key of Object.keys(process.env)) if (/^(?:npm|pnpm)_config_otp$/i.test(key)) vi.stubEnv(key, '');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`fixture exit ${code}`); });
});
afterEach(() => {
  process.argv = argv;
  if (tty === undefined) Reflect.deleteProperty(process.stdin, 'isTTY');
  else Object.defineProperty(process.stdin, 'isTTY', tty);
  if (stdoutTty === undefined) Reflect.deleteProperty(process.stdout, 'isTTY');
  else Object.defineProperty(process.stdout, 'isTTY', stdoutTty);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('first publish orchestration', () => {
  it('keeps dry-run non-interactive and never invokes publication', async () => {
    process.argv.push('--dry-run');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    await import('../first-publish.ts');
    expect(state.calls.some((call) => call.command === 'node' && call.args[0] === 'scripts/release-dry-run.ts')).toBe(true);
    expect(state.calls.some((call) => call.args.includes('publish'))).toBe(false);
    expect(state.calls.some((call) => call.command === 'npm' && call.args[0] === 'trust')).toBe(false);
  });

  it('finishes every check before delegating fresh 2FA to interactive publishing commands', async () => {
    await import('../first-publish.ts');
    const checkIndex = state.calls.findIndex((call) => call.command === 'node' && call.args[0] === 'scripts/release-dry-run.ts');
    const publishIndex = state.calls.findIndex((call) => call.command === 'pnpm' && call.args[0] === 'changeset');
    expect(checkIndex).toBeGreaterThan(-1);
    expect(publishIndex).toBeGreaterThan(checkIndex);
    expect(state.calls[publishIndex]).toEqual({ command: 'pnpm', args: ['changeset', 'publish'], stdio: 'inherit' });
    const placeholder = state.calls.find((call) => call.command === 'npm' && call.args[0] === 'publish');
    expect(placeholder?.stdio).toBe('inherit');
    expect(state.calls.every((call) => call.args.every((arg) => !arg.startsWith('--otp')))).toBe(true);
  });

  it('stops before any publish if the checks fail', async () => {
    state.failBuild = true;
    await expect(import('../first-publish.ts')).rejects.toThrow('fixture build failure');
    expect(state.calls.some((call) => call.args.includes('publish'))).toBe(false);
  });

  it('rejects a non-interactive publish before executing external commands', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    await expect(import('../first-publish.ts')).rejects.toThrow('fixture exit 1');
    expect(state.calls).toEqual([]);
  });

  it('does not print an early OTP supplied on the command line', async () => {
    process.argv.push('--otp=123456');
    await expect(import('../first-publish.ts')).rejects.toThrow('fixture exit 1');
    expect(state.calls).toEqual([]);
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).not.toContain('123456');
    expect(vi.mocked(console.log).mock.calls.flat().join(' ')).not.toContain('123456');
  });

  it('checks placeholder existence using npm JSON before publishing it', async () => {
    await import('../first-publish.ts');
    expect(state.calls.find((call) => call.command === 'npm' && call.args[0] === 'view')?.args)
      .toEqual(['view', 'otterplayer', 'version', '--json']);
    expect(state.calls.some((call) => call.command === 'npm' && call.args[0] === 'publish')).toBe(true);
  });

  it.each(['ETIMEDOUT', 'ENEEDAUTH', 'E403', 'EOTP'])('stops after a placeholder lookup fails with %s and preserves its output', async (code) => {
    const failure = npmFailure(code);
    state.viewError = failure;
    await expect(import('../first-publish.ts')).rejects.toBe(failure);
    expect(state.calls.at(-1)?.args).toEqual(['view', 'otterplayer', 'version', '--json']);
    expect(state.calls.some((call) => call.command === 'npm' && ['publish', 'trust'].includes(call.args[0] ?? ''))).toBe(false);
  });

  it('does not infer a missing placeholder from E404 text outside structured JSON', async () => {
    const failure = Object.assign(new Error('fixture lookup failed'), { stdout: '', stderr: 'network request failed; last cached response was E404' });
    state.viewError = failure;
    await expect(import('../first-publish.ts')).rejects.toBe(failure);
    expect(state.calls.some((call) => call.command === 'npm' && call.args[0] === 'publish')).toBe(false);
  });

  it.each(['ETIMEDOUT', 'ENEEDAUTH', 'E403', 'E404', 'EOTP'])('stops after a trust lookup fails with %s and preserves its output', async (code) => {
    const failure = npmFailure(code);
    state.viewError = undefined;
    state.trustError = failure;
    await expect(import('../first-publish.ts')).rejects.toBe(failure);
    expect(state.calls.at(-1)?.args).toEqual(['trust', 'list', '@otter-player/core', '--json']);
    expect(state.calls.some((call) => call.command === 'npm' && call.args[0] === 'trust' && call.args[1] === 'github')).toBe(false);
  });

  it('registers trust only after a successful empty trust response', async () => {
    state.trustOutput = '';
    await import('../first-publish.ts');
    expect(state.calls.some((call) => call.command === 'npm' && call.args[0] === 'trust' && call.args[1] === 'github')).toBe(true);
  });

  it.each(['{}', 'null', '""', 'not-json'])('stops on an invalid successful placeholder response: %s', async (output) => {
    state.viewError = undefined;
    state.viewOutput = output;
    await expect(import('../first-publish.ts')).rejects.toThrow();
    expect(state.calls.at(-1)?.args[0]).toBe('view');
  });

  it('keeps trust lookup attached to the real terminal while capturing its response', async () => {
    await import('../first-publish.ts');
    expect(state.calls.find((call) => call.args[0] === 'trust')).toMatchObject({
      command: 'npm', args: ['trust', 'list', '@otter-player/core', '--json'], stdio: 'inherit', interactive: true,
    });
    expect(state.calls.some((call) => call.args[0] === 'trust' && call.args[1] === 'github')).toBe(false);
  });

  it('rejects piped stdout before executing external commands', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    await expect(import('../first-publish.ts')).rejects.toThrow('fixture exit 1');
    expect(state.calls).toEqual([]);
  });

  it.each([
    { repository: 'CIPFZ/otter-fork' },
    { file: 'other-release.yml' },
    { type: 'gitlab' },
    { environment: 'production' },
    { permissions: ['createPackage'] },
    { permissions: ['createStagedPackage', 'createPackage'] },
  ])('does not skip registration for a different trust binding: %j', async (override) => {
    state.trustOutput = JSON.stringify({ type: 'github', repository: 'CIPFZ/otter', file: 'release.yml', permissions: ['createStagedPackage'], ...override });
    await import('../first-publish.ts');
    expect(state.calls.some((call) => call.args[0] === 'trust' && call.args[1] === 'github')).toBe(true);
  });

  it('finds the exact trust record among authentication prompts and multiple pretty JSON objects', async () => {
    state.trustOutput = '\x1b[1GPress ENTER to open in the browser...\n' +
      JSON.stringify({ title: 'Authenticate your account at', url: 'https://example.test/auth/fixture' }, null, 2) + '\n' +
      JSON.stringify({ type: 'github', repository: 'CIPFZ/other', file: 'release.yml', permissions: ['createStagedPackage'] }, null, 2) + '\n' +
      JSON.stringify({ id: 'quoted "identifier" with {braces}', type: 'github', repository: 'CIPFZ/otter', file: 'release.yml', permissions: ['createStagedPackage'] }, null, 2) + '\n';
    await import('../first-publish.ts');
    expect(state.calls.some((call) => call.args[0] === 'trust' && call.args[1] === 'github')).toBe(false);
  });

  it('accepts an authenticated successful empty trust response', async () => {
    state.trustOutput = 'This operation requires a one-time password.\n\x1b[1GEnter OTP: 12\r\x1b[0JEnter OTP: 123456\r\n' + JSON.stringify({ title: 'Authenticate your account at', url: 'https://example.test/auth/fixture' });
    await import('../first-publish.ts');
    expect(state.calls.some((call) => call.args[0] === 'trust' && call.args[1] === 'github')).toBe(true);
  });

  it.each(['{', '{}', 'unexpected response', '{"type":"github","permissions":"createStagedPackage"}'])('stops on malformed or unknown successful trust output: %s', async (output) => {
    state.trustOutput = output;
    await expect(import('../first-publish.ts')).rejects.toMatchObject({ stdout: output });
    expect(state.calls.at(-1)?.args).toEqual(['trust', 'list', '@otter-player/core', '--json']);
    expect(state.calls.some((call) => call.args[0] === 'trust' && call.args[1] === 'github')).toBe(false);
  });
});
