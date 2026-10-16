// Default ABR rule set (ADR-005 §1) and the reserved server-hint rule.

import { createAbrController, type AbrController, type AbrRule } from './abr.js';
import { createBolaRule, type BolaRuleOptions } from '../vendor/dash.js/bola.js';
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
  /** Extra rules appended after the defaults. */
  readonly extra?: readonly AbrRule[];
}

/**
 * Throughput + BOLA + InsufficientBuffer + ServerHint (dash.js "dynamic" combination): throughput
 * and BOLA vote, InsufficientBuffer caps, ties go to the lower level.
 */
export function createDefaultAbrController(options: DefaultAbrOptions = {}): AbrController {
  return createAbrController([
    createThroughputRule(options.throughput),
    createBolaRule(options.bola),
    createInsufficientBufferRule(options.insufficientBuffer),
    createServerHintRule(),
    ...(options.extra ?? []),
  ]);
}
