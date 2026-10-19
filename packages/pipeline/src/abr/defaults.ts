// Default ABR rule set (ADR-005 §1) and the reserved server-hint rule.

import { createAbrController, type AbrController, type AbrRule } from './abr.js';
import { createBolaRule, type BolaRuleOptions } from '../vendor/dash.js/bola.js';
import { createDynamicRule, type DynamicRuleOptions } from '../vendor/dash.js/dynamic.js';
import {
  createInsufficientBufferRule,
  createThroughputRule,
  type InsufficientBufferRuleOptions,
  type ThroughputRuleOptions,
} from '../vendor/dash.js/rules.js';

/**
 * Reserved (SPEC §7 "ServerHint"): will vote from CMSD / Content Steering hints. Until those
 * sources exist (after M3) it always abstains, so adding it to a stack changes nothing.
 */
export function createServerHintRule(): AbrRule {
  return { id: 'serverHint', weight: 1, decide: () => null };
}

export interface DefaultAbrOptions {
  readonly throughput?: ThroughputRuleOptions;
  readonly bola?: BolaRuleOptions;
  readonly insufficientBuffer?: InsufficientBufferRuleOptions;
  readonly dynamic?: DynamicRuleOptions;
  /** Extra rules appended after the defaults. */
  readonly extra?: readonly AbrRule[];
}

/**
 * dash.js default combination: Throughput below 12 s of buffer, BOLA above (with hysteresis, never
 * both at once), InsufficientBuffer caps, ServerHint reserved; ties go to the lower level.
 */
export function createDefaultAbrController(options: DefaultAbrOptions = {}): AbrController {
  return createAbrController([
    createDynamicRule(createThroughputRule(options.throughput), createBolaRule(options.bola), options.dynamic),
    createInsufficientBufferRule(options.insufficientBuffer),
    createServerHintRule(),
    ...(options.extra ?? []),
  ]);
}
