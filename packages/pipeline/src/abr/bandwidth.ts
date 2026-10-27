// Bandwidth estimate for ABR: two exponentially weighted moving averages of download throughput
// (fast and slow half-lives, the estimate is the lower of the two) and one of the time to first
// byte. Design and arithmetic after hls.js' EwmaBandWidthEstimator (L4 since M5 close-out: its
// classes rewritten as one small closure for the own engine's VOD chunk, REUSE §3).

export interface BandwidthEstimate {
  /** bits per second, min(fast, slow) */
  readonly estimate: number;
  readonly fast: number;
  readonly slow: number;
}

export interface BandwidthEstimator {
  /** One download: `durationMs` of transfer for `bytes`. */
  sample(durationMs: number, bytes: number): void;
  /** Time to first byte, ms; longer times weigh less (expected input under 1 s). */
  sampleTtfb(ttfbMs: number): void;
  readonly canEstimate: boolean;
  readonly bandwidth: BandwidthEstimate;
  /** ms */
  readonly ttfb: number;
}

/** [sample(weight, value), estimate(), totalWeight()]: unbiased at the start (zero-factor). */
function ewma(halfLife: number): [(weight: number, value: number) => void, () => number, () => number] {
  const alpha = Math.exp(Math.log(0.5) / halfLife);
  let estimate = 0;
  let total = 0;
  return [
    (weight, value) => {
      const a = alpha ** weight;
      estimate = value * (1 - a) + a * estimate;
      total += weight;
    },
    () => estimate / (1 - alpha ** total || 1),
    () => total,
  ];
}

const MIN_WEIGHT = 0.001;

export function createBandwidthEstimator(slowHalfLife: number, fastHalfLife: number, defaultEstimate: number, defaultTtfb = 100): BandwidthEstimator {
  const [slow, slowValue] = ewma(slowHalfLife);
  const [fast, fastValue, fastWeight] = ewma(fastHalfLife);
  const [ttfb, ttfbValue, ttfbWeight] = ewma(slowHalfLife);
  return {
    sample(durationMs, bytes) {
      if (bytes <= 0) return;
      // weight is duration in seconds, value is bandwidth in bits/s
      const seconds = Math.max(durationMs, Math.min(50, bytes / 100_000)) / 1000;
      fast(seconds, (8 * bytes) / seconds);
      slow(seconds, (8 * bytes) / seconds);
    },
    sampleTtfb(ms) {
      ttfb(Math.SQRT2 * Math.exp(-((ms / 1000) ** 2) / 2), Math.max(ms, 5));
    },
    get canEstimate() {
      return fastWeight() >= MIN_WEIGHT;
    },
    get bandwidth() {
      if (fastWeight() < MIN_WEIGHT) return { estimate: defaultEstimate, fast: defaultEstimate, slow: defaultEstimate };
      const f = fastValue();
      const s = slowValue();
      return { estimate: Math.min(f, s), fast: f, slow: s };
    },
    get ttfb() {
      return ttfbWeight() >= MIN_WEIGHT ? ttfbValue() : defaultTtfb;
    },
  };
}
