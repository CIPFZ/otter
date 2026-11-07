import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCommand } from '../lib/process.ts';

const temporaryDirs: string[] = [];
const makeDirectory = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'otter process test & '));
  temporaryDirs.push(dir);
  return dir;
};
const literalArgs = (): string[] => [
  '',
  'space value',
  '世界',
  '%OTTER_PROCESS_LITERAL%',
  '!OTTER_PROCESS_LITERAL!',
  '&',
  '|',
  '^',
  '(parentheses)',
  '"quoted"',
  'trailing\\',
];
const captureError = (action: () => unknown): Error => {
  try {
    action();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('Expected the command to fail');
};

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('release command execution', () => {
  it('preserves literal arguments when starting a native executable', () => {
    const args = literalArgs();
    const output = runCommand(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', ...args]);
    expect(JSON.parse(output)).toEqual(args);
  });

  it('keeps output and status available when a child exits unsuccessfully', () => {
    const error = captureError(() => runCommand(process.execPath, ['-e', 'process.stdout.write("out\\n"); process.stderr.write("err\\n"); process.exit(23)']));
    expect(error).toMatchObject({ status: 23, signal: null, stdout: 'out\n', stderr: 'err\n', output: [null, 'out\n', 'err\n'] });
    expect(error.message).toContain('exit code 23');
    expect(Object.hasOwn(error, 'error')).toBe(false);
  });

  it('preserves the underlying ENOENT error when a command cannot start', () => {
    const command = join(makeDirectory(), 'missing-executable');
    const error = captureError(() => runCommand(command, []));
    expect(error).toMatchObject({ code: 'ENOENT' });
    expect(error.message).toContain('ENOENT');
    expect(error.message).toContain('missing-executable');
    expect(Object.hasOwn(error, 'error')).toBe(false);
  });

  it('allows inherited stdio without expecting captured output', () => {
    expect(runCommand(process.execPath, ['-e', ''], { stdio: 'inherit' })).toBe('');
  });
});

describe.skipIf(process.platform !== 'win32')('Windows command shims', () => {
  it.each(['PATH', 'absolute', 'absolute .cmd'])('preserves arguments for a %s command in node_modules/.bin', (mode) => {
    const dir = makeDirectory();
    const bin = join(dir, 'node_modules', '.bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'argv.cjs'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
    // This forwarding shape exercises the extra parsing performed by npm-style .bin shims.
    writeFileSync(join(bin, 'otter-argv.cmd'), `@echo off\r\n@setlocal DisableDelayedExpansion\r\n@"${process.execPath}" "%~dp0argv.cjs" %*\r\n`);
    const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
    const env = { ...process.env, [pathKey]: bin + delimiter + (process.env[pathKey] ?? ''), OTTER_PROCESS_LITERAL: 'must-not-expand' };
    const sentinel = join(dir, 'unexpected-shell-output.txt');
    const args = [...literalArgs(), `& echo injected > "${sentinel}"`];
    const command = mode === 'PATH' ? 'otter-argv' : join(bin, mode === 'absolute .cmd' ? 'otter-argv.cmd' : 'otter-argv');
    const output = runCommand(command, args, { cwd: dir, env });
    expect(existsSync(sentinel)).toBe(false);
    expect(JSON.parse(output)).toEqual(args);
  });
});
