// Size regression sentinel (ADR-004): warns (GitHub annotation, exit 0) when a watched entry grew
// by more than the threshold since the previous main run, then writes the new baseline.
//
//   node scripts/size-sentinel.ts size-report.json .size-baseline.json

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { checkGrowth, type SizeEntry } from './lib/size-sentinel.ts';

const [reportFile, baselineFile] = process.argv.slice(2);
if (reportFile === undefined || baselineFile === undefined) throw new Error('usage: size-sentinel.ts <size-limit.json> <baseline.json>');

const WATCHED = /背景视频 \/ Hero/;
const THRESHOLD_BYTES = 500;

const current = JSON.parse(readFileSync(reportFile, 'utf8')) as SizeEntry[];
const previous = existsSync(baselineFile) ? (JSON.parse(readFileSync(baselineFile, 'utf8')) as Record<string, number>) : {};
for (const r of checkGrowth(current, previous, WATCHED, THRESHOLD_BYTES)) {
  const delta = r.previous === undefined ? 'no baseline yet' : `${r.current - r.previous >= 0 ? '+' : ''}${r.current - r.previous} B since the previous main run`;
  if (r.grew) console.log(`::warning title=Size sentinel::${r.name}: ${r.current} B (${delta}; threshold ${THRESHOLD_BYTES} B)`);
  else console.log(`size sentinel: ${r.name}: ${r.current} B (${delta})`);
}
writeFileSync(baselineFile, JSON.stringify(Object.fromEntries(current.filter((e) => WATCHED.test(e.name)).map((e) => [e.name, e.size])), null, 2));
