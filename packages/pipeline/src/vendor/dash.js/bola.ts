// Derived from dash.js@a9a8542cd7e6257116be4046ebf16ac49e1cec91 src/streaming/rules/abr/BolaRule.js, BSD-3-Clause
//
// Upstream license header is reproduced below as required by BSD-3-Clause. Local changes are
// listed in ./UPSTREAM.json. For the algorithm see http://arxiv.org/abs/1601.06748.

/*
 * The copyright in this software is being made available under the BSD License,
 * included below. This software may be subject to other third party and contributor
 * rights, including patent rights, and no such rights are granted under this license.
 *
 * Copyright (c) 2016, Dash Industry Forum.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *  * Redistributions of source code must retain the above copyright notice, this
 *  list of conditions and the following disclaimer.
 *  * Redistributions in binary form must reproduce the above copyright notice,
 *  this list of conditions and the following disclaimer in the documentation and/or
 *  other materials provided with the distribution.
 *  * Neither the name of Dash Industry Forum nor the names of its
 *  contributors may be used to endorse or promote products derived from this software
 *  without specific prior written permission.
 *
 *  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS AS IS AND ANY
 *  EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 *  WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
 *  IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT,
 *  INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
 *  NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 *  PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 *  WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 *  ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 *  POSSIBILITY OF SUCH DAMAGE.
 */

import { levelForBitrate, PRIORITY, type AbrContext, type AbrLevel, type AbrRule, type AbrVote } from '../../abr/abr.js';

/** BOLA never adds artificial delay below this buffer level. */
const MINIMUM_BUFFER_S = 10;
const MINIMUM_BUFFER_PER_BITRATE_LEVEL_S = 2;

export interface BolaRuleOptions {
  /** Applied to throughput in startup and for BOLA-O (dash.js bandwidthSafetyFactor default 0.9). */
  readonly safetyFactor?: number;
  readonly weight?: number;
}

interface BolaParams {
  readonly Vp: number;
  readonly gp: number;
}

interface BolaState {
  state: 'one-bitrate' | 'startup' | 'steady';
  levelsKey: string;
  bufferTarget: number;
  utilities: number[];
  params: BolaParams | null;
  placeholderBuffer: number;
  current: number;
  lastCallMs: number;
}

/** log utilities normalised so utilities[0] === 1. */
function utilitiesOf(levels: readonly AbrLevel[]): number[] {
  const logs = levels.map((l) => Math.log(l.bitrate));
  const first = logs[0] ?? 0;
  return logs.map((u) => u - first + 1);
}

function paramsOf(bufferTarget: number, levels: readonly AbrLevel[], utilities: readonly number[]): BolaParams | null {
  let highest = 0;
  for (let i = 1; i < utilities.length; i++) if ((utilities[i] as number) > (utilities[highest] as number)) highest = i;
  // highest === 0: always lowest bitrate.
  if (highest === 0) return null;
  const bufferTime = Math.max(bufferTarget, MINIMUM_BUFFER_S + MINIMUM_BUFFER_PER_BITRATE_LEVEL_S * levels.length);
  // Vp * (utilities[0] + gp - 1) === minimumBufferS and Vp * (utilities[max] + gp - 1) === bufferTarget
  const gp = ((utilities[highest] as number) - 1) / (bufferTime / MINIMUM_BUFFER_S - 1);
  return { gp, Vp: MINIMUM_BUFFER_S / gp };
}

/** The core idea of BOLA: maximise (Vp (u_i - 1 + gp) - buffer) / bitrate_i. */
function levelFromBuffer(s: BolaState, levels: readonly AbrLevel[], bufferLevel: number): number {
  const p = s.params as BolaParams;
  let level = 0;
  let score = Number.NaN;
  for (let i = 0; i < levels.length; i++) {
    const v = (p.Vp * ((s.utilities[i] as number) - 1 + p.gp) - bufferLevel) / (levels[i] as AbrLevel).bitrate;
    if (Number.isNaN(score) || v >= score) {
      score = v;
      level = i;
    }
  }
  return level;
}

/** Buffer level at which BOLA starts preferring `level` over every lower level. */
function minBufferForLevel(s: BolaState, levels: readonly AbrLevel[], level: number): number {
  const p = s.params as BolaParams;
  const qBitrate = (levels[level] as AbrLevel).bitrate;
  const qUtility = s.utilities[level] as number;
  let min = 0;
  for (let i = level - 1; i >= 0; i--) {
    const iUtility = s.utilities[i] as number;
    if (iUtility < qUtility) {
      const iBitrate = (levels[i] as AbrLevel).bitrate;
      min = Math.max(min, p.Vp * (p.gp + (qBitrate * iUtility - iBitrate * qUtility) / (qBitrate - iBitrate)));
    }
  }
  return min;
}

function maxBufferForLevel(s: BolaState, level: number): number {
  const p = s.params as BolaParams;
  return p.Vp * ((s.utilities[level] as number) + p.gp);
}

/**
 * BOLA-O. Startup: pick by throughput and set the placeholder buffer so BOLA agrees; switch to
 * steady once a segment's worth is buffered. Steady: buffer-based choice, never increasing to a
 * level the throughput cannot sustain. Seek / reset returns to startup.
 */
export function createBolaRule(options: BolaRuleOptions = {}): AbrRule {
  const safety = options.safetyFactor ?? 0.9;
  let s: BolaState | undefined;

  const init = (ctx: AbrContext): BolaState => {
    const utilities = utilitiesOf(ctx.levels);
    const params = paramsOf(ctx.bufferTarget, ctx.levels, utilities);
    return {
      state: params === null ? 'one-bitrate' : 'startup',
      levelsKey: ctx.levels.map((l) => l.bitrate).join(','),
      bufferTarget: ctx.bufferTarget,
      utilities,
      params,
      placeholderBuffer: 0,
      current: ctx.current,
      lastCallMs: Number.NaN,
    };
  };

  /** Buffer target changed mid-stream: keep the effective buffer level at MINIMUM_BUFFER_S fixed, scale by Vp. */
  const retarget = (state: BolaState, ctx: AbrContext): void => {
    if (state.bufferTarget === ctx.bufferTarget || state.params === null) return;
    const next = paramsOf(ctx.bufferTarget, ctx.levels, state.utilities);
    if (next === null) return;
    let effective = ctx.bufferLevel + state.placeholderBuffer;
    effective = ((effective - MINIMUM_BUFFER_S) * next.Vp) / state.params.Vp + MINIMUM_BUFFER_S;
    state.params = next;
    state.bufferTarget = ctx.bufferTarget;
    state.placeholderBuffer = Math.max(0, effective - ctx.bufferLevel);
  };

  return {
    id: 'bola',
    weight: options.weight ?? 1,
    decide(ctx: AbrContext): AbrVote | null {
      const key = ctx.levels.map((l) => l.bitrate).join(',');
      if (s === undefined || s.levelsKey !== key) s = init(ctx);
      const state = s;
      if (state.state === 'one-bitrate') return null;
      retarget(state, ctx);
      if (state.current < 0) state.current = ctx.current;

      const safe = ctx.throughput * safety;
      // Buffer ran dry: the placeholder must not keep BOLA optimistic.
      if (ctx.bufferState === 'empty' && state.state === 'steady') state.placeholderBuffer = 0;

      if (state.state === 'startup') {
        if (!Number.isFinite(safe)) return null;
        const level = levelForBitrate(ctx.levels, safe);
        state.placeholderBuffer = Math.max(0, minBufferForLevel(state, ctx.levels, level) - ctx.bufferLevel);
        state.current = level;
        state.lastCallMs = ctx.now;
        if (ctx.segmentDuration > 0 && ctx.bufferLevel >= ctx.segmentDuration) state.state = 'steady';
        return { level, priority: PRIORITY.default, reason: `startup: throughput ${Math.round(safe / 1000)} kbps` };
      }

      // Steady. Compensate for time not spent downloading (live availability, engine pauses).
      if (!Number.isNaN(state.lastCallMs)) state.placeholderBuffer += Math.max(0, (ctx.now - state.lastCallMs) / 1000);
      state.lastCallMs = ctx.now;

      let level = levelFromBuffer(state, ctx.levels, ctx.bufferLevel + state.placeholderBuffer);
      // BOLA-O: only intervene when *increasing* to an *unsustainable* level; never drop below the last level.
      if (Number.isFinite(safe)) {
        const forThroughput = levelForBitrate(ctx.levels, safe);
        if (level > state.current && level > forThroughput) level = Math.max(forThroughput, state.current);
      }
      // Do not overfill the buffer with low quality: consume the placeholder buffer first.
      const delay = Math.max(0, ctx.bufferLevel + state.placeholderBuffer - maxBufferForLevel(state, level));
      state.placeholderBuffer = delay <= state.placeholderBuffer ? state.placeholderBuffer - delay : 0;
      state.current = level;
      return {
        level,
        priority: PRIORITY.default,
        reason: `steady: buffer ${ctx.bufferLevel.toFixed(1)} s + placeholder ${state.placeholderBuffer.toFixed(1)} s`,
      };
    },
    reset() {
      if (s === undefined || s.state === 'one-bitrate') return;
      s.state = 'startup';
      s.placeholderBuffer = 0;
      s.lastCallMs = Number.NaN;
    },
    onLevelApplied(level) {
      if (s !== undefined) s.current = level;
    },
  };
}
