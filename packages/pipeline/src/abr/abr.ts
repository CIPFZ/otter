// ABR rule stack (SPEC §7, ADR-005 §1): engine-independent, DOM-free. Rules vote; the controller
// applies limits, then a weighted vote, and explains the result. Engines (hls.js abrController,
// Shaka abrFactory, later the own pipeline) feed it AbrContext and apply the chosen level.

/** One rendition, sorted ascending by bitrate in AbrContext.levels. */
export interface AbrLevel {
  /** Engine-side id (`level-2`, `variant-7`, ...). */
  readonly id: string;
  /** bits per second */
  readonly bitrate: number;
  readonly width?: number;
  readonly height?: number;
}

export type BufferState = 'empty' | 'loading' | 'loaded';

export interface AbrContext {
  /** Ascending by bitrate. Index into this array is the "level". */
  readonly levels: readonly AbrLevel[];
  /** Level currently being fetched, -1 before the first decision. */
  readonly current: number;
  /** Seconds of media buffered ahead of the playhead. */
  readonly bufferLevel: number;
  readonly bufferState: BufferState;
  /** bits per second; NaN until the estimator has samples. */
  readonly throughput: number;
  /** Average time to first byte, ms. */
  readonly latencyMs: number;
  /** Duration of the next segment, seconds. */
  readonly segmentDuration: number;
  readonly live: boolean;
  readonly lowLatency: boolean;
  /** Media segments appended since load / seek (rules ignore the first few). */
  readonly segmentsAppended: number;
  /** Engine buffer target, seconds (BOLA scales with it). */
  readonly bufferTarget: number;
  /** ms, monotonic; injectable for tests. */
  readonly now: number;
}

/** Relative strength of a vote (dash.js SwitchRequest.PRIORITY). */
export const PRIORITY = { weak: 0.5, default: 1, strong: 2 } as const;
export type Priority = (typeof PRIORITY)[keyof typeof PRIORITY];

export interface AbrVote {
  /** Preferred level. */
  readonly level?: number;
  /** Upper bound for every other vote. */
  readonly maxLevel?: number;
  /** Lower bound for every other vote. */
  readonly minLevel?: number;
  readonly priority: Priority;
  readonly reason: string;
}

export interface AbrRule {
  readonly id: string;
  /** Multiplies the vote priority in the weighted vote. */
  readonly weight: number;
  /** null: abstain. */
  decide(ctx: AbrContext): AbrVote | null;
  /** Called on seek / new load. */
  reset?(): void;
  /** Called when a level change was applied, so stateful rules (BOLA) can follow manual / engine switches. */
  onLevelApplied?(level: number): void;
}

export interface AbrDecision {
  readonly level: number;
  readonly reason: string;
  readonly votes: readonly { readonly rule: string; readonly vote: AbrVote }[];
}

/** Highest level whose bitrate fits `bps` (dash.js getOptimalRepresentationForBitrate); 0 if none fits. */
export function levelForBitrate(levels: readonly AbrLevel[], bps: number): number {
  if (!Number.isFinite(bps) || bps <= 0) return 0;
  let best = 0;
  for (let i = 0; i < levels.length; i++) {
    if ((levels[i] as AbrLevel).bitrate <= bps) best = i;
  }
  return best;
}

export interface AbrController {
  readonly rules: readonly AbrRule[];
  decide(ctx: AbrContext): AbrDecision;
  reset(): void;
  levelApplied(level: number): void;
}

export function createAbrController(rules: readonly AbrRule[]): AbrController {
  return {
    rules,
    decide(ctx) {
      const top = ctx.levels.length - 1;
      if (top < 0) return { level: -1, reason: 'no levels', votes: [] };
      if (top === 0) return { level: 0, reason: 'single level', votes: [] };

      const votes: { rule: string; vote: AbrVote }[] = [];
      for (const rule of rules) {
        const vote = rule.decide(ctx);
        if (vote !== null) votes.push({ rule: rule.id, vote });
      }

      let max = top;
      let min = 0;
      for (const { vote } of votes) {
        if (vote.maxLevel !== undefined) max = Math.min(max, vote.maxLevel);
        if (vote.minLevel !== undefined) min = Math.max(min, vote.minLevel);
      }
      // A cap (rebuffer protection) beats a floor.
      if (min > max) min = max;

      const tally = new Map<number, number>();
      for (const { rule, vote } of votes) {
        if (vote.level === undefined) continue;
        const weight = (rules.find((r) => r.id === rule)?.weight ?? 1) * vote.priority;
        const level = Math.min(max, Math.max(min, vote.level));
        tally.set(level, (tally.get(level) ?? 0) + weight);
      }

      const clamp = (l: number): number => Math.min(max, Math.max(min, l));
      if (tally.size === 0) {
        const keep = clamp(ctx.current < 0 ? 0 : ctx.current);
        const capped = votes.find(({ vote }) => vote.maxLevel !== undefined && vote.maxLevel < (ctx.current < 0 ? 0 : ctx.current));
        return { level: keep, reason: capped === undefined ? 'no preference: keep' : `capped by ${capped.rule}: ${capped.vote.reason}`, votes };
      }
      // Highest weight wins; ties go to the lower level (safer).
      let level = -1;
      let best = Number.NEGATIVE_INFINITY;
      for (const [l, w] of [...tally].sort((a, b) => a[0] - b[0])) {
        if (w > best) {
          best = w;
          level = l;
        }
      }
      const winners = votes.filter(({ vote }) => vote.level !== undefined && clamp(vote.level) === level).map(({ rule, vote }) => `${rule}: ${vote.reason}`);
      return { level, reason: winners.join('; '), votes };
    },
    reset() {
      for (const r of rules) r.reset?.();
    },
    levelApplied(level) {
      for (const r of rules) r.onLevelApplied?.(level);
    },
  };
}
