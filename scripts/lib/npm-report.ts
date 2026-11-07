/** Statistics emitted by npm publish --dry-run --json for one package. */
export interface NpmPublishReport {
  name: string;
  version: string;
  size: number;
  unpackedSize: number;
  entryCount: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Accept npm's package-keyed output and the older flat report, rejecting incomplete data. */
export function parseNpmPublishReport(output: string, name: string, version: string): NpmPublishReport {
  const label = `npm publish --dry-run report for ${name}@${version}`;
  const fail = (reason: string): never => { throw new Error(`${label}: ${reason}`); };
  let parsed: unknown;
  try {
    const start = output.indexOf('{');
    parsed = JSON.parse(start < 0 ? output : output.slice(start));
  } catch {
    return fail('invalid JSON');
  }
  if (!isRecord(parsed)) return fail('expected a JSON object');
  const report: unknown = Object.hasOwn(parsed, name) ? parsed[name] : parsed;
  if (!isRecord(report)) return fail('expected a package report object');
  if (report.name !== name) return fail(`expected package name ${name}, got ${String(report.name)}`);
  if (report.version !== version) return fail(`expected version ${version}, got ${String(report.version)}`);
  const count = (field: 'size' | 'unpackedSize' | 'entryCount'): number => {
    const value = report[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
      return fail(`${field} must be a finite non-negative integer`);
    }
    return value;
  };
  return { name, version, size: count('size'), unpackedSize: count('unpackedSize'), entryCount: count('entryCount') };
}
