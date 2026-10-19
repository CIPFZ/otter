// Derived from dash.js@a9a8542cd7e6257116be4046ebf16ac49e1cec91 src/streaming/controllers/AbrController.js, BSD-3-Clause
// Derived from dash.js@a9a8542cd7e6257116be4046ebf16ac49e1cec91 src/streaming/rules/abr/ABRRulesCollection.js, BSD-3-Clause
//
// Upstream license header is reproduced below as required by BSD-3-Clause. Local changes are
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

import type { AbrContext, AbrRule, AbrVote } from '../../abr/abr.js';

export interface DynamicRuleOptions {
  /** BOLA takes over at this buffer level and hands back below half of it (dash.js hybridSwitchBufferTime, 12 s). */
  readonly hybridSwitchBufferTime?: number;
}

/**
 * dash.js "dynamic" strategy: only one of the throughput and buffer-occupancy (BOLA) rules votes
 * at a time, chosen by buffer level with hysteresis, so the two never fight over neighbouring
 * levels. The inactive rule is not consulted (as upstream), so its state does not advance.
 */
export function createDynamicRule(throughput: AbrRule, bola: AbrRule, options: DynamicRuleOptions = {}): AbrRule {
  const switchOn = options.hybridSwitchBufferTime ?? 12;
  const switchOff = 0.5 * switchOn;
  let usingBola = false;

  return {
    id: 'dynamic',
    weight: 1,
    decide(ctx: AbrContext): AbrVote | null {
      // Hysteresis: once on BOLA, stay until the buffer drops below the switch-off threshold.
      usingBola = ctx.bufferLevel >= (usingBola ? switchOff : switchOn);
      const rule = usingBola ? bola : throughput;
      const vote = rule.decide(ctx);
      return vote === null ? null : { ...vote, reason: `${rule.id}: ${vote.reason}` };
    },
    reset() {
      usingBola = false;
      throughput.reset?.();
      bola.reset?.();
    },
    onLevelApplied(level) {
      throughput.onLevelApplied?.(level);
      bola.onLevelApplied?.(level);
    },
  };
}
