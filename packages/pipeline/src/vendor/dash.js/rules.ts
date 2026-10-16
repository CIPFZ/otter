// Derived from dash.js@a9a8542cd7e6257116be4046ebf16ac49e1cec91 src/streaming/rules/abr/ThroughputRule.js, BSD-3-Clause
// Derived from dash.js@a9a8542cd7e6257116be4046ebf16ac49e1cec91 src/streaming/rules/abr/InsufficientBufferRule.js, BSD-3-Clause
//
// Upstream license headers are reproduced below as required by BSD-3-Clause. Local changes are
// listed in ./UPSTREAM.json.

/*
 * The copyright in this software is being made available under the BSD License,
 * included below. This software may be subject to other third party and contributor
 * rights, including patent rights, and no such rights are granted under this license.
 *
 * Copyright (c) 2013, Dash Industry Forum.
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

import { levelForBitrate, PRIORITY, type AbrContext, type AbrRule, type AbrVote } from '../../abr/abr.js';

export interface ThroughputRuleOptions {
  /** Applied to the estimate before picking a level (dash.js bandwidthSafetyFactor default 0.9). */
  readonly safetyFactor?: number;
  readonly weight?: number;
}

/**
 * Highest level that fits the (safety-scaled) throughput, once the buffer is loaded or the
 * stream is live. Abstains until the estimator has samples.
 */
export function createThroughputRule(options: ThroughputRuleOptions = {}): AbrRule {
  const safety = options.safetyFactor ?? 0.9;
  return {
    id: 'throughput',
    weight: options.weight ?? 1,
    decide(ctx: AbrContext): AbrVote | null {
      if (!Number.isFinite(ctx.throughput)) return null;
      if (ctx.bufferState !== 'loaded' && !ctx.live) return null;
      const safe = ctx.throughput * safety;
      const level = levelForBitrate(ctx.levels, safe);
      return { level, priority: PRIORITY.default, reason: `throughput ${Math.round(safe / 1000)} kbps fits level ${level}` };
    },
  };
}

/*
 * The copyright in this software is being made available under the BSD License,
 * included below. This software may be subject to other third party and contributor
 * rights, including patent rights, and no such rights are granted under this license.
 *
 * Copyright (c) 2013, Dash Industry Forum.
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

export interface InsufficientBufferRuleOptions {
  /** dash.js throughputSafetyFactor default 0.7. */
  readonly throughputSafetyFactor?: number;
  /** Segments appended after load / seek before the rule acts (dash.js default 2). */
  readonly segmentIgnoreCount?: number;
  readonly weight?: number;
}

/**
 * Caps the level so a whole segment can download before the buffer runs out:
 * maxBitrate = throughput × safety × bufferLevel / segmentDuration. Empty buffer caps at 0.
 * Off in low-latency mode (the buffer is intentionally tiny there).
 */
export function createInsufficientBufferRule(options: InsufficientBufferRuleOptions = {}): AbrRule {
  const safety = options.throughputSafetyFactor ?? 0.7;
  const ignore = options.segmentIgnoreCount ?? 2;
  return {
    id: 'insufficientBuffer',
    weight: options.weight ?? 1,
    decide(ctx: AbrContext): AbrVote | null {
      if (ctx.lowLatency || ctx.segmentsAppended < ignore || !(ctx.segmentDuration > 0)) return null;
      if (ctx.bufferState === 'empty') {
        return { maxLevel: 0, priority: PRIORITY.default, reason: 'buffer empty: lowest level' };
      }
      const bitrate = (ctx.throughput * safety * ctx.bufferLevel) / ctx.segmentDuration;
      if (!Number.isFinite(bitrate) || bitrate <= 0) return null;
      const maxLevel = levelForBitrate(ctx.levels, bitrate);
      return { maxLevel, priority: PRIORITY.default, reason: `buffer ${ctx.bufferLevel.toFixed(1)} s allows up to level ${maxLevel}` };
    },
  };
}
