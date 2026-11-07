import { describe, expect, it } from 'vitest';
import { parseNpmPublishReport } from '../lib/npm-report.ts';

const name = '@otter-player/core';
const version = '0.1.0-beta.0';
const report = { name, version, size: 512, unpackedSize: 2048, entryCount: 7 };
const parse = (output: string) => parseNpmPublishReport(output, name, version);

describe('npm publish dry-run report', () => {
  it('reads npm 11.15 reports keyed by package name', () => {
    expect(parse(JSON.stringify({ [name]: { ...report, filename: 'core.tgz', files: [] } }))).toEqual(report);
  });

  it('keeps support for the older flat report', () => {
    expect(parse(JSON.stringify({ ...report, filename: 'core.tgz', files: [] }))).toEqual(report);
  });

  it('selects the requested package rather than the first report', () => {
    expect(parse(JSON.stringify({ other: { ...report, name: 'other', size: 1 }, [name]: report }))).toEqual(report);
  });

  it('allows zero counts and an npm output prelude', () => {
    const empty = { ...report, size: 0, unpackedSize: 0, entryCount: 0 };
    expect(parse('npm output\n' + JSON.stringify({ [name]: empty }))).toEqual(empty);
  });

  it.each(['size', 'unpackedSize', 'entryCount'] as const)('rejects a missing %s instead of reporting undefined or NaN', (field) => {
    const incomplete: Record<string, unknown> = { ...report };
    delete incomplete[field];
    expect(() => parse(JSON.stringify({ [name]: incomplete }))).toThrow(field + ' must be a finite non-negative integer');
  });

  it.each(['size', 'unpackedSize', 'entryCount'] as const)('validates the numeric value of %s', (field) => {
    for (const value of [-1, 0.5, '7', null]) {
      expect(() => parse(JSON.stringify({ [name]: { ...report, [field]: value } }))).toThrow(field + ' must be a finite non-negative integer');
    }
    const infinite = JSON.stringify({ [name]: { ...report, [field]: 'INFINITE' } }).replace('"INFINITE"', '1e999');
    expect(() => parse(infinite)).toThrow(field + ' must be a finite non-negative integer');
  });

  it.each(['flat', 'keyed'])('rejects an incorrect name or version in a %s report', (shape) => {
    const encode = (value: typeof report): string => JSON.stringify(shape === 'keyed' ? { [name]: value } : value);
    expect(() => parse(encode({ ...report, name: 'other' }))).toThrow('expected package name ' + name);
    expect(() => parse(encode({ ...report, version: '0.1.0-beta.1' }))).toThrow('expected version ' + version);
  });

  it.each([
    ['not JSON', 'not JSON'],
    ['truncated JSON', '{'],
    ['null root', 'null'],
    ['array root', JSON.stringify([report])],
    ['missing package', JSON.stringify({ other: { ...report, name: 'other' } })],
    ['null package', JSON.stringify({ [name]: null })],
    ['array package', JSON.stringify({ [name]: [report] })],
  ])('fails clearly for %s', (_label, output) => {
    expect(() => parse(output)).toThrow('npm publish --dry-run report for ' + name + '@' + version);
  });
});
