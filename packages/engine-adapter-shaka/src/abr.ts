// Otter ABR inside Shaka (ADR-005 §1): a shaka.extern.AbrManager backed by the pipeline rule stack.
// Shaka hands us the playable variants and every segment download; we answer chooseVariant() and
// call switchCallback when the stack picks a different variant. Typed structurally, like the rest
// of the adapter (shaka-types.ts).
//
// Audio is not part of ABR (separate audio and video, SPEC §19 B 站式): the rules choose among
// the video Representations of the audio stream already playing, so bandwidth never changes the
// audio and a video switch never makes Shaka fetch audio again. A language change (Shaka hands new
// variants without that audio stream) picks the audio of the first new variant.

import type { AbrDriver, AbrLevel } from '@otter-player/pipeline';

export interface ShakaVariant {
  readonly id: number;
  readonly bandwidth: number;
  readonly video: { readonly width?: number | null; readonly height?: number | null } | null;
  readonly audio?: { readonly id: number } | null;
}

export interface ShakaRestrictions {
  readonly minWidth?: number;
  readonly maxWidth?: number;
  readonly minHeight?: number;
  readonly maxHeight?: number;
  readonly minPixels?: number;
  readonly maxPixels?: number;
  readonly minBandwidth?: number;
  readonly maxBandwidth?: number;
}

interface ShakaSegmentContext {
  readonly segment?: { readonly startTime?: number; readonly endTime?: number } | null;
}

/** Downloads below this are init / index segments and say nothing about throughput. */
const MIN_SAMPLE_BYTES = 16_000;

export type ShakaSwitch = (variant: ShakaVariant, clearBuffer?: boolean, safeMargin?: number) => void;

export interface OtterShakaAbr {
  init(switchCallback: ShakaSwitch): void;
  stop(): void;
  release(): void;
  setVariants(variants: readonly ShakaVariant[], isLowLatency?: boolean): boolean;
  chooseVariant(): ShakaVariant;
  enable(): void;
  disable(): void;
  segmentDownloaded(deltaTimeMs: number, numBytes: number, allowSwitch: boolean, request?: unknown, context?: ShakaSegmentContext): void;
  trySuggestStreams(): void;
  getBandwidthEstimate(): number;
  setMediaElement(media: HTMLMediaElement | null): void;
  setCmsdManager(manager: unknown): void;
  playbackRateChanged(rate: number): void;
  configure(config: { readonly restrictions?: ShakaRestrictions; readonly switchInterval?: number }): void;
  isInitialized(): boolean;
  /** Last variant this manager chose and why (for QoE quality-switch reasons). */
  readonly lastChoice: { readonly id: string; readonly reason: string } | undefined;
}

export function allowedBy(v: ShakaVariant, r: ShakaRestrictions): boolean {
  const w = v.video?.width ?? null;
  const h = v.video?.height ?? null;
  const within = (x: number | null, min?: number, max?: number): boolean =>
    x === null || ((min === undefined || x >= min) && (max === undefined || x <= max));
  return (
    within(w, r.minWidth, r.maxWidth) &&
    within(h, r.minHeight, r.maxHeight) &&
    within(w !== null && h !== null ? w * h : null, r.minPixels, r.maxPixels) &&
    within(v.bandwidth, r.minBandwidth, r.maxBandwidth)
  );
}

const levelOf = (v: ShakaVariant): AbrLevel => ({
  id: `variant-${v.id}`,
  bitrate: v.bandwidth,
  ...(v.video?.width != null ? { width: v.video.width } : {}),
  ...(v.video?.height != null ? { height: v.video.height } : {}),
});

export interface OtterShakaAbrOptions {
  /** Shaka streaming.bufferingGoal (default 10 s); BOLA scales with it. */
  readonly bufferTarget?: number;
  /** Seconds buffered ahead of the playhead. */
  readonly bufferAhead: (media: HTMLMediaElement) => number;
  /** ms, monotonic; injectable for tests. */
  readonly now?: () => number;
}

export function createOtterShakaAbr(driver: AbrDriver, options: OtterShakaAbrOptions): OtterShakaAbr {
  let switchCb: ShakaSwitch | undefined;
  let all: readonly ShakaVariant[] = [];
  let variants: readonly ShakaVariant[] = [];
  let restrictions: ShakaRestrictions = {};
  let enabled = false;
  let lowLatency = false;
  let media: HTMLMediaElement | null = null;
  let current: ShakaVariant | undefined;
  let segmentDuration = 4;
  let last: { id: string; reason: string } | undefined;
  // Shaka AbrConfiguration.switchInterval (s): minimum time between up-switches.
  let switchIntervalMs = 8000;
  let lastSwitchMs = Number.NEGATIVE_INFINITY;
  const now = options.now ?? (() => performance.now());
  const onSeeking = (): void => driver.reset();

  const filter = (): void => {
    const allowed = all.filter((v) => allowedBy(v, restrictions));
    // Shaka's SimpleAbrManager falls back to all variants when restrictions exclude everything.
    variants = allowed.length > 0 ? allowed : all;
  };

  /** The variants with the audio stream playing (or, at the start / after a language change, the first one's). */
  const pool = (): readonly ShakaVariant[] => {
    const playing = current?.audio?.id;
    const audio = playing !== undefined && variants.some((v) => v.audio?.id === playing) ? playing : variants[0]?.audio?.id;
    return audio === undefined ? variants : variants.filter((v) => v.audio?.id === audio);
  };

  const choose = (): ShakaVariant | undefined => {
    const list = pool();
    if (list.length === 0) return undefined;
    const levels = list.map(levelOf);
    const currentIndex = current === undefined ? -1 : list.findIndex((v) => v.id === current?.id);
    if (!driver.canEstimate) {
      // Before any sample: highest variant that fits the default estimate, else the lowest.
      const sorted = [...list].sort((a, b) => a.bandwidth - b.bandwidth);
      let pick = sorted[0] as ShakaVariant;
      for (const v of sorted) if (v.bandwidth <= driver.bandwidth.estimate) pick = v;
      last = { id: `variant-${pick.id}`, reason: `startup: default estimate ${Math.round(driver.bandwidth.estimate / 1000)} kbps` };
      return pick;
    }
    const d = driver.decide({
      levels,
      current: currentIndex,
      bufferLevel: media === null ? 0 : options.bufferAhead(media),
      segmentDuration,
      live: media !== null && media.duration === Number.POSITIVE_INFINITY,
      lowLatency,
      bufferTarget: options.bufferTarget ?? 10,
    });
    const chosen = list[d.engineLevel];
    if (chosen !== undefined) last = { id: `variant-${chosen.id}`, reason: d.reason };
    return chosen;
  };

  const stop = (): void => {
    switchCb = undefined;
    all = [];
    variants = [];
    current = undefined;
    media?.removeEventListener('seeking', onSeeking);
  };

  const suggest = (): void => {
    // Shaka makes the initial choice through chooseVariant(); never switch before it.
    if (!enabled || switchCb === undefined || current === undefined) return;
    const next = choose();
    if (next === undefined || next.id === current.id) return;
    // Up-switches wait for switchInterval (Shaka semantics); down-switches protect against
    // rebuffering and apply at once.
    if (next.bandwidth > current.bandwidth && now() - lastSwitchMs < switchIntervalMs) return;
    lastSwitchMs = now();
    current = next;
    const list = pool();
    driver.applied(list.indexOf(next), list.map(levelOf));
    switchCb(next, false);
  };

  // No `this` in the methods: Shaka may call them detached.
  return {
    init(cb) {
      switchCb = cb;
    },
    stop,
    release() {
      stop();
      media = null;
    },
    setVariants(next, isLowLatency) {
      const changed = next.length !== all.length || next.some((v, i) => v.id !== all[i]?.id);
      all = next;
      lowLatency = isLowLatency === true;
      filter();
      return changed;
    },
    chooseVariant() {
      const v = choose() ?? (variants[0] as ShakaVariant);
      current = v;
      lastSwitchMs = now();
      const list = pool();
      driver.applied(list.indexOf(v), list.map(levelOf));
      return v;
    },
    enable() {
      enabled = true;
    },
    disable() {
      enabled = false;
    },
    segmentDownloaded(deltaTimeMs, numBytes, allowSwitch, _request, context) {
      if (numBytes >= MIN_SAMPLE_BYTES) {
        driver.sampleDownload(deltaTimeMs, numBytes);
        driver.segmentAppended();
      }
      const seg = context?.segment;
      if (seg?.startTime != null && seg.endTime != null && seg.endTime > seg.startTime) segmentDuration = seg.endTime - seg.startTime;
      if (allowSwitch) suggest();
    },
    trySuggestStreams: suggest,
    getBandwidthEstimate: () => driver.bandwidth.estimate,
    setMediaElement(el) {
      media?.removeEventListener('seeking', onSeeking);
      media = el;
      media?.addEventListener('seeking', onSeeking);
    },
    // CMSD feeds the reserved serverHint rule later (ADR-005 §1).
    setCmsdManager: () => undefined,
    playbackRateChanged: () => undefined,
    configure(config) {
      restrictions = config.restrictions ?? {};
      if (config.switchInterval !== undefined && Number.isFinite(config.switchInterval)) switchIntervalMs = config.switchInterval * 1000;
      filter();
    },
    isInitialized: () => switchCb !== undefined,
    get lastChoice() {
      return last;
    },
  };
}
