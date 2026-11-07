import { appendFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export interface TerminalCaptureTarget {
  readonly stdout: string;
  readonly stderr: string;
}

const VARIABLE = 'OTTER_TERMINAL_CAPTURE';

/** Each inherited target receives the same terminal bytes; paths must be absolute. */
export function parseTerminalCaptureTargets(value: string | undefined): TerminalCaptureTarget[] {
  if (value === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(VARIABLE + ' must be a JSON array of stdout/stderr paths');
  }
  if (!Array.isArray(parsed)) throw new Error(VARIABLE + ' must be a JSON array of stdout/stderr paths');
  return parsed.map((target: unknown) => {
    if (typeof target !== 'object' || target === null || !('stdout' in target) || !('stderr' in target) ||
      typeof target.stdout !== 'string' || typeof target.stderr !== 'string' ||
      !isAbsolute(target.stdout) || !isAbsolute(target.stderr)) {
      throw new Error(VARIABLE + ' targets must have absolute stdout and stderr paths');
    }
    return { stdout: target.stdout, stderr: target.stderr };
  });
}

/** Add a capture target to a child environment without changing the current process. */
export function terminalCaptureEnvironment(target: TerminalCaptureTarget, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const targets = parseTerminalCaptureTargets(JSON.stringify([...parseTerminalCaptureTargets(env[VARIABLE]), target]));
  return {
    ...env,
    NODE_OPTIONS: [env.NODE_OPTIONS, '--import=' + import.meta.url].filter(Boolean).join(' '),
    [VARIABLE]: JSON.stringify(targets),
  };
}

type TerminalStream = Pick<NodeJS.WriteStream, 'isTTY' | 'write'>;

/** Tee writes without replacing the stream, its file descriptor or its terminal behavior. */
export function captureTerminalStream(stream: TerminalStream, paths: readonly string[]): void {
  if (stream.isTTY !== true || paths.length === 0) return;
  const destinations = [...new Set(paths)];
  const original = stream.write;
  stream.write = function (this: TerminalStream, ...args: Parameters<typeof original>): boolean {
    const [chunk, encoding] = args;
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8') : chunk as Uint8Array;
    // Keep the original arguments, receiver, callback and backpressure result.
    const accepted = Reflect.apply(original, this, args) as boolean;
    for (const path of destinations) appendFileSync(path, bytes);
    return accepted;
  } as typeof original;
}

// Loaded by Node's --import before the CLI. A pipe remains a pipe; no TTY flags are fabricated.
const targets = parseTerminalCaptureTargets(process.env[VARIABLE]);
captureTerminalStream(process.stdout, targets.map((target) => target.stdout));
captureTerminalStream(process.stderr, targets.map((target) => target.stderr));
