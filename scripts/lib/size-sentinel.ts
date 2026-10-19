// Size regression sentinel (ADR-004): entries that are reported but not gated (the Hero scenario
// until M6) must not creep. Compares with the previous main run and warns, never fails.

export interface SizeEntry {
  readonly name: string;
  readonly size: number;
}

export interface SentinelResult {
  readonly name: string;
  readonly previous: number | undefined;
  readonly current: number;
  readonly grew: boolean;
}

export function checkGrowth(current: readonly SizeEntry[], previous: Readonly<Record<string, number>>, match: RegExp, thresholdBytes: number): SentinelResult[] {
  return current
    .filter((e) => match.test(e.name))
    .map((e) => {
      const before = previous[e.name];
      return { name: e.name, previous: before, current: e.size, grew: before !== undefined && e.size - before > thresholdBytes };
    });
}
