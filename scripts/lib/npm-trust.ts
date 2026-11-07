import { stripVTControlCharacters } from 'node:util';

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Match npm's individual trust JSON records while allowing its interactive authentication dialogue. */
export function hasReleaseTrust(output: string, repository: string, workflow: string): boolean {
  const text = stripVTControlCharacters(output);
  const records: unknown[] = [];
  let outside = '';
  let end = 0;
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  const invalid: () => never = () => { throw Object.assign(new Error('Unexpected npm trust list output'), { stdout: output }); };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (start < 0) {
      if (char !== '{') continue;
      outside += text.slice(end, i);
      start = i;
      depth = 1;
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      try { records.push(JSON.parse(text.slice(start, i + 1))); } catch { invalid(); }
      end = i + 1;
      start = -1;
    }
  }
  if (start >= 0) invalid();
  outside += text.slice(end);
  // npm's non-silent OTP reader echoes input and may redraw the prompt while typing.
  outside = outside.replace(/Enter OTP:[0-9A-Fa-f \t]*/g, '');
  for (const prompt of [
    'Press ENTER to open in the browser...',
    'This operation requires a one-time password.',
  ]) outside = outside.replaceAll(prompt, '');
  if (outside.trim() !== '') invalid();

  let matches = false;
  for (const record of records) {
    if (!isRecord(record)) invalid();
    if (typeof record.title === 'string' && typeof record.url === 'string' && Object.keys(record).every((key) => key === 'title' || key === 'url')) continue;
    if (typeof record.type !== 'string' || !Array.isArray(record.permissions) || !record.permissions.every((permission) => typeof permission === 'string')) invalid();
    if (record.type === 'github' && record.repository === repository && record.file === workflow && record.environment === undefined && record.permissions.length === 1 && record.permissions[0] === 'createStagedPackage') matches = true;
  }
  return matches;
}
