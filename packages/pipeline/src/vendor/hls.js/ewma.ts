// Derived from hls.js@e5ff3583965e3af16c4a4b4d2b5f7bd1ffb5b7de src/utils/ewma.ts, Apache-2.0
// Derived from hls.js@e5ff3583965e3af16c4a4b4d2b5f7bd1ffb5b7de src/utils/ewma-bandwidth-estimator.ts, Apache-2.0
//
// Copyright (c) 2017 Dailymotion (http://www.dailymotion.com). Licensed under the Apache License,
// Version 2.0. Local changes are listed in ./UPSTREAM.json.

/** Exponentially weighted moving average; about half the estimate comes from the last `halfLife` units of weight. */
export class Ewma {
  readonly halfLife: number;
  readonly #alpha: number;
  #estimate: number;
  #totalWeight: number;

  constructor(halfLife: number, estimate = 0, weight = 0) {
    this.halfLife = halfLife;
    // Larger values of alpha expire historical data more slowly.
    this.#alpha = halfLife > 0 ? Math.exp(Math.log(0.5) / halfLife) : 0;
    this.#estimate = estimate;
    this.#totalWeight = weight;
  }

  sample(weight: number, value: number): void {
    const adjAlpha = this.#alpha ** weight;
    this.#estimate = value * (1 - adjAlpha) + adjAlpha * this.#estimate;
    this.#totalWeight += weight;
  }

  get totalWeight(): number {
    return this.#totalWeight;
  }

  get estimate(): number {
    if (this.#alpha > 0) {
      const zeroFactor = 1 - this.#alpha ** this.#totalWeight;
      if (zeroFactor > 0) return this.#estimate / zeroFactor;
    }
    return this.#estimate;
  }
}

export interface BandwidthEstimate {
  /** bits per second, min(fast, slow) */
  readonly estimate: number;
  readonly fast: number;
  readonly slow: number;
}

/**
 * Bandwidth estimate as the minimum of a fast and a slow EWMA: adapts down quickly, up slowly.
 * Half-lives are in seconds of download time (hls.js defaults: slow 15 s, fast 4 s for VOD).
 */
export class EwmaBandwidthEstimator {
  readonly defaultEstimate: number;
  readonly #minWeight = 0.001;
  readonly #minDelayMs = 50;
  #slow: Ewma;
  #fast: Ewma;
  #ttfb: Ewma;
  readonly #defaultTtfb: number;

  constructor(slowHalfLife: number, fastHalfLife: number, defaultEstimate: number, defaultTtfb = 100) {
    this.defaultEstimate = defaultEstimate;
    this.#slow = new Ewma(slowHalfLife);
    this.#fast = new Ewma(fastHalfLife);
    this.#ttfb = new Ewma(slowHalfLife);
    this.#defaultTtfb = defaultTtfb;
  }

  /** Changes half-lives (e.g. live vs VOD) while keeping the accumulated estimate. */
  update(slowHalfLife: number, fastHalfLife: number): void {
    if (this.#slow.halfLife !== slowHalfLife) this.#slow = new Ewma(slowHalfLife, this.#slow.estimate, this.#slow.totalWeight);
    if (this.#fast.halfLife !== fastHalfLife) this.#fast = new Ewma(fastHalfLife, this.#fast.estimate, this.#fast.totalWeight);
    if (this.#ttfb.halfLife !== slowHalfLife) this.#ttfb = new Ewma(slowHalfLife, this.#ttfb.estimate, this.#ttfb.totalWeight);
  }

  /** One download: `durationMs` of transfer for `bytes`. */
  sample(durationMs: number, bytes: number): void {
    if (bytes <= 0) return;
    const minDelay = Math.min(this.#minDelayMs, bytes / 100_000);
    // weight is duration in seconds, value is bandwidth in bits/s
    const seconds = Math.max(durationMs, minDelay) / 1000;
    const bps = (8 * bytes) / seconds;
    this.#fast.sample(seconds, bps);
    this.#slow.sample(seconds, bps);
  }

  /** Time to first byte, ms; longer times weigh less (expected input under 1 s). */
  sampleTtfb(ttfbMs: number): void {
    const seconds = ttfbMs / 1000;
    const weight = Math.SQRT2 * Math.exp(-(seconds ** 2) / 2);
    this.#ttfb.sample(weight, Math.max(ttfbMs, 5));
  }

  get canEstimate(): boolean {
    return this.#fast.totalWeight >= this.#minWeight;
  }

  get bandwidth(): BandwidthEstimate {
    if (!this.canEstimate) {
      return { estimate: this.defaultEstimate, fast: this.defaultEstimate, slow: this.defaultEstimate };
    }
    const fast = this.#fast.estimate;
    const slow = this.#slow.estimate;
    return { estimate: Math.min(fast, slow), fast, slow };
  }

  get ttfb(): number {
    return this.#ttfb.totalWeight >= this.#minWeight ? this.#ttfb.estimate : this.#defaultTtfb;
  }
}
