import type { SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import spawn from 'cross-spawn';

type CommandOptions = Omit<SpawnSyncOptionsWithStringEncoding, 'encoding' | 'shell'>;

/** Run native programs and Windows command shims while preserving argument boundaries. */
export function runCommand(command: string, args: string[], options: CommandOptions = {}): string {
  const result = spawn.sync(command, args, { ...options, encoding: 'utf8', shell: false });
  if (result.error || result.status !== 0) {
    const reason = result.signal !== null ? `signal ${result.signal}` : `exit code ${result.status}`;
    const error = result.error ?? new Error(`${command} failed with ${reason}`);
    // Callers inspect these streams to report build and publishing failures.
    throw Object.assign(error, {
      status: result.status,
      signal: result.signal,
      pid: result.pid,
      output: result.output,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  return result.stdout ?? '';
}
