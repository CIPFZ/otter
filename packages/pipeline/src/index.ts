// Self-built pipeline (SPEC §7). DOM-free so it can run in a Worker. M2 ships the ABR rule stack
// (ADR-005 §1), which already drives hls.js and Shaka; Loader / Demuxer / Remuxer / Buffer /
// LiveController arrive with the own FLV / TS / fMP4 pipeline in M3.

export {
  createAbrController,
  levelForBitrate,
  PRIORITY,
  type AbrContext,
  type AbrController,
  type AbrDecision,
  type AbrLevel,
  type AbrRule,
  type AbrVote,
  type BufferState,
  type Priority,
} from './abr/abr.js';
export { createDefaultAbrController, createServerHintRule, type DefaultAbrOptions } from './abr/defaults.js';
export { createBolaRule, type BolaRuleOptions } from './vendor/dash.js/bola.js';
export { createDynamicRule, type DynamicRuleOptions } from './vendor/dash.js/dynamic.js';
export {
  createInsufficientBufferRule,
  createThroughputRule,
  type InsufficientBufferRuleOptions,
  type ThroughputRuleOptions,
} from './vendor/dash.js/rules.js';
export { Ewma, EwmaBandwidthEstimator, type BandwidthEstimate } from './vendor/hls.js/ewma.js';
export {
  createAbrDriver,
  type AbrDriver,
  type AbrDriverOptions,
  type AbrEngineDecision,
  type AbrSnapshot,
} from './abr/driver.js';
export { createLiveController, type LiveAction, type LiveController, type LiveControllerOptions, type LiveSample } from './live/controller.js';
export type { Cea608Channel, Cea608Cue, Cea608Decoder } from './captions/cea608.js';
