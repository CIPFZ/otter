// Otter ABR inside hls.js (ADR-005 §1): a subclass of hls.js' AbrController whose nextAutoLevel
// comes from the pipeline rule stack. hls.js keeps its listeners, startup choice (before the first
// bandwidth sample), level caps (capLevelToPlayerSize, min/maxAutoLevel) and emergency abandonment
// (forcedAutoLevel); the rule stack only replaces the steady-state choice.

import type { AbrDriver, AbrLevel } from '@otter-player/pipeline';
import type Hls from 'hls.js';
import type { AbrController as HlsAbrController } from 'hls.js';

type AbrControllerCtor = typeof HlsAbrController;

/** Seconds buffered ahead of `time` in the range that contains it. */
export function bufferAhead(buffered: TimeRanges, time: number): number {
  for (let i = 0; i < buffered.length; i++) {
    const start = buffered.start(i);
    const end = buffered.end(i);
    // 0.5 s tolerance: the playhead can sit just before a range after a seek.
    if (time >= start - 0.5 && time <= end) return Math.max(0, end - time);
  }
  return 0;
}

export const levelsOf = (hls: Pick<Hls, 'levels'>): AbrLevel[] =>
  hls.levels.map((l, i) => ({
    id: `level-${i}`,
    bitrate: l.bitrate,
    ...(l.width > 0 ? { width: l.width } : {}),
    ...(l.height > 0 ? { height: l.height } : {}),
  }));

/** Builds the subclass against the dynamically imported hls.js module. */
export function createOtterAbrController(Base: AbrControllerCtor, driver: AbrDriver, media: HTMLMediaElement): AbrControllerCtor {
  class OtterAbrController extends Base {
    override get nextAutoLevel(): number {
      // hls.js logic runs first so its own estimator and caches stay current.
      const engine = super.nextAutoLevel;
      const hls = this.hls as Hls | undefined;
      if (hls === undefined || hls.levels.length < 2 || !driver.canEstimate) return engine;
      const current = hls.loadLevel;
      const details = hls.levels[current]?.details ?? hls.latestLevelDetails ?? undefined;
      const decision = driver.decide({
        levels: levelsOf(hls),
        current,
        bufferLevel: bufferAhead(media.buffered, media.currentTime),
        segmentDuration: details?.targetduration ?? 4,
        live: details?.live === true,
        lowLatency: hls.lowLatencyMode && (details?.partList?.length ?? 0) > 0,
        bufferTarget: hls.config.maxBufferLength,
      });
      let level = Math.min(hls.maxAutoLevel, Math.max(hls.minAutoLevel, decision.engineLevel));
      // hls.js abandoned a fragment and forced a lower level: never go above that.
      if (this.forcedAutoLevel !== -1) level = Math.min(level, this.forcedAutoLevel);
      return level;
    }

    override set nextAutoLevel(level: number) {
      super.nextAutoLevel = level;
    }
  }
  return OtterAbrController;
}
