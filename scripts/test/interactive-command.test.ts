import { appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInteractiveCommand } from '../lib/interactive-command.ts';
import { runCommand } from '../lib/process.ts';
import { parseTerminalCaptureTargets } from '../lib/terminal-capture.ts';

vi.mock('../lib/process.ts', () => ({ runCommand: vi.fn() }));

const mockRun = vi.mocked(runCommand);
const directories: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('interactive Node command', () => {
  it('inherits the real terminal, captures output and keeps parent log targets', () => {
    const parentDir = mkdtempSync(join(tmpdir(), 'otter parent capture & '));
    directories.push(parentDir);
    const parent = { stdout: join(parentDir, 'full.log'), stderr: join(parentDir, 'errors.log') };
    vi.stubEnv('NODE_OPTIONS', '--trace-warnings');
    vi.stubEnv('OTTER_TERMINAL_CAPTURE', JSON.stringify([parent]));
    let temporaryDirectory = '';
    mockRun.mockImplementation((command, args, options) => {
      expect(command).toBe('npm');
      expect(args).toEqual(['trust', 'list', '@otter-player/core']);
      expect(options?.cwd).toBe(parentDir);
      expect(options?.stdio).toBe('inherit');
      expect(options?.env?.NODE_OPTIONS).toContain('--trace-warnings --import=file:');
      const targets = parseTerminalCaptureTargets(options?.env?.OTTER_TERMINAL_CAPTURE);
      expect(targets[0]).toEqual(parent);
      expect(targets).toHaveLength(2);
      const target = targets[1];
      if (target === undefined) throw new Error('missing query target');
      temporaryDirectory = dirname(target.stdout);
      appendFileSync(target.stdout, 'trusted 世界\n');
      appendFileSync(target.stderr, 'npm notice\n');
      return '';
    });
    expect(runInteractiveCommand('npm', ['trust', 'list', '@otter-player/core'], parentDir)).toBe('trusted 世界\n');
    expect(existsSync(temporaryDirectory)).toBe(false);
    expect(process.env.OTTER_TERMINAL_CAPTURE).toBe(JSON.stringify([parent]));
    expect(process.env.NODE_OPTIONS).toBe('--trace-warnings');
  });

  it('retains the original failure and attaches terminal output before cleanup', () => {
    vi.stubEnv('OTTER_TERMINAL_CAPTURE', undefined);
    const failure = Object.assign(new Error('npm failed'), { status: 23, signal: null, pid: 42, code: 'EFAIL' });
    let temporaryDirectory = '';
    mockRun.mockImplementation((_command, _args, options) => {
      const target = parseTerminalCaptureTargets(options?.env?.OTTER_TERMINAL_CAPTURE).at(-1);
      if (target === undefined) throw new Error('missing query target');
      temporaryDirectory = dirname(target.stdout);
      appendFileSync(target.stdout, 'partial output\n');
      appendFileSync(target.stderr, 'failure detail\n');
      throw failure;
    });
    let caught: unknown;
    try {
      runInteractiveCommand('npm', ['trust', 'list'], tmpdir());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(caught).toMatchObject({ status: 23, signal: null, pid: 42, code: 'EFAIL', stdout: 'partial output\n', stderr: 'failure detail\n', output: [null, 'partial output\n', 'failure detail\n'] });
    expect(existsSync(temporaryDirectory)).toBe(false);
  });

  it('retains a spawn error when the command never wrote output', () => {
    vi.stubEnv('OTTER_TERMINAL_CAPTURE', undefined);
    const failure = Object.assign(new Error('not found'), { code: 'ENOENT' });
    mockRun.mockImplementation(() => { throw failure; });
    expect(() => runInteractiveCommand('missing', [], tmpdir())).toThrow(failure);
    expect(failure).toMatchObject({ code: 'ENOENT', stdout: '', stderr: '', output: [null, '', ''] });
  });
});
