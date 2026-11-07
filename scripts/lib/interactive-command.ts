import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from './process.ts';
import { terminalCaptureEnvironment } from './terminal-capture.ts';

export { terminalCaptureEnvironment } from './terminal-capture.ts';

/** Capture a Node CLI's output while leaving its actual terminal available for authentication. */
export function runInteractiveCommand(command: string, args: string[], cwd: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'otter interactive '));
  const stdout = join(directory, 'stdout.log');
  const stderr = join(directory, 'stderr.log');
  try {
    writeFileSync(stdout, '');
    writeFileSync(stderr, '');
    const env = terminalCaptureEnvironment({ stdout, stderr });
    try {
      runCommand(command, args, { cwd, env, stdio: 'inherit' });
    } catch (error) {
      const out = readFileSync(stdout, 'utf8');
      const err = readFileSync(stderr, 'utf8');
      const failure = error instanceof Error ? error : new Error(String(error), { cause: error });
      throw Object.assign(failure, { stdout: out, stderr: err, output: [null, out, err] });
    }
    return readFileSync(stdout, 'utf8');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
