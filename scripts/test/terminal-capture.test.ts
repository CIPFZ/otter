import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureTerminalStream, parseTerminalCaptureTargets, terminalCaptureEnvironment } from '../lib/terminal-capture.ts';

const directories: string[] = [];
const directory = (): string => {
  const path = mkdtempSync(join(tmpdir(), 'otter terminal capture & '));
  directories.push(path);
  return path;
};
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('terminal capture', () => {
  it('copies Unicode, explicit encodings, buffers and byte views to every target', () => {
    const dir = directory();
    const paths = [join(dir, 'full output.log'), join(dir, 'query output.log')];
    const original = vi.fn(() => true);
    const stream = { isTTY: true, write: original as NodeJS.WriteStream['write'] };
    captureTerminalStream(stream, [...paths, paths[0] as string]);
    stream.write('世界');
    stream.write('é', 'latin1');
    stream.write(Buffer.from([0, 255]));
    stream.write(new Uint8Array([1, 2]));
    const expected = Buffer.concat([Buffer.from('世界'), Buffer.from([233, 0, 255, 1, 2])]);
    for (const path of paths) expect(readFileSync(path)).toEqual(expected);
    expect(original).toHaveBeenCalledTimes(4);
    expect(original.mock.contexts.every((context) => context === stream)).toBe(true);
    expect(stream.isTTY).toBe(true);
  });

  it('preserves the write arguments, callback and backpressure result', () => {
    const path = join(directory(), 'output.log');
    const callback = vi.fn();
    const original = vi.fn(() => false);
    const stream = { isTTY: true, write: original as NodeJS.WriteStream['write'] };
    captureTerminalStream(stream, [path]);
    expect(stream.write('first', callback)).toBe(false);
    expect(original).toHaveBeenLastCalledWith('first', callback);
    expect(callback).not.toHaveBeenCalled();
    expect(stream.write('second', 'utf8', callback)).toBe(false);
    expect(original).toHaveBeenLastCalledWith('second', 'utf8', callback);
    expect(readFileSync(path, 'utf8')).toBe('firstsecond');
  });

  it('leaves non-terminal streams and their write method unchanged', () => {
    const path = join(directory(), 'output.log');
    const original = vi.fn(() => true);
    const stream = { isTTY: false, write: original as NodeJS.WriteStream['write'] };
    captureTerminalStream(stream, [path]);
    expect(stream.write).toBe(original);
    stream.write('pipe');
    expect(existsSync(path)).toBe(false);
    expect(stream.isTTY).toBe(false);
  });

  it('preserves errors from the original terminal write', () => {
    const failure = new Error('terminal failed');
    const path = join(directory(), 'output.log');
    const stream = { isTTY: true, write: vi.fn(() => { throw failure; }) as NodeJS.WriteStream['write'] };
    captureTerminalStream(stream, [path]);
    expect(() => stream.write('message')).toThrow(failure);
    expect(existsSync(path)).toBe(false);
  });
});

describe('terminal capture environment', () => {
  it('appends a child target and preload without changing the parent environment', () => {
    const dir = directory();
    const parent = { stdout: join(dir, 'parent.log'), stderr: join(dir, 'parent-errors.log') };
    const child = { stdout: join(dir, 'query.log'), stderr: join(dir, 'query-errors.log') };
    const env = { NODE_OPTIONS: '--trace-warnings', OTTER_TERMINAL_CAPTURE: JSON.stringify([parent]), OTHER: 'kept' };
    const result = terminalCaptureEnvironment(child, env);
    expect(parseTerminalCaptureTargets(result.OTTER_TERMINAL_CAPTURE)).toEqual([parent, child]);
    expect(result.NODE_OPTIONS).toBe('--trace-warnings --import=' + new URL('../lib/terminal-capture.ts', import.meta.url).href);
    expect(result.OTHER).toBe('kept');
    expect(env).toEqual({ NODE_OPTIONS: '--trace-warnings', OTTER_TERMINAL_CAPTURE: JSON.stringify([parent]), OTHER: 'kept' });
    expect(parseTerminalCaptureTargets(undefined)).toEqual([]);
  });

  it.each(['', 'null', '{}', '[null]', '[{}]', '[{"stdout":"relative","stderr":"relative"}]'])('rejects invalid capture configuration %s', (value) => {
    expect(() => parseTerminalCaptureTargets(value)).toThrow('OTTER_TERMINAL_CAPTURE');
  });
});
