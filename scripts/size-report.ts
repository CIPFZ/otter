// Renders `size-limit --json` output as a Markdown table (CI job summary / PR size report).
//
//   pnpm exec size-limit --json > size.json; node scripts/size-report.ts size.json

import { readFileSync } from 'node:fs';

interface SizeResult {
  readonly name: string;
  readonly passed?: boolean;
  readonly size: number;
  readonly sizeLimit?: number;
}

const file = process.argv[2];
if (file === undefined) throw new Error('usage: size-report.ts <size-limit.json>');

const results = JSON.parse(readFileSync(file, 'utf8')) as SizeResult[];
const kb = (bytes: number): string => `${(bytes / 1000).toFixed(2)} KB`;

const lines = ['## Size (gzip, minified, with dependencies)', '', '| Entry | Size | Limit | Status |', '|---|---:|---:|---|'];
for (const r of results) {
  const status = r.sizeLimit === undefined ? 'report' : r.passed === false ? '❌ over budget' : '✅';
  lines.push(`| ${r.name} | ${kb(r.size)} | ${r.sizeLimit === undefined ? '' : kb(r.sizeLimit)} | ${status} |`);
}
console.log(lines.join('\n'));
