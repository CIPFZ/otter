// Casting (ADR-007 §5): Remote Playback API for Cast-style receivers and WebKit's AirPlay picker.
// Safari implements the Remote Playback API on top of AirPlay, so where the AirPlay picker exists
// the Cast state stays `unavailable` and only the AirPlay button shows. The Google Cast Web Sender
// SDK is an external script and belongs to plugin-cast.

import type { Unsubscribe } from '@otter-player/core';

export type RemoteState = 'unavailable' | 'available' | 'connecting' | 'connected';

export interface RemoteStates {
  readonly cast: RemoteState;
  readonly airplay: RemoteState;
}

interface AirPlayVideo {
  webkitShowPlaybackTargetPicker?: () => void;
  webkitCurrentPlaybackTargetIsWireless?: boolean;
}

export interface RemoteControl {
  /** Opens the system device picker; call inside the user gesture. */
  prompt(target: 'cast' | 'airplay'): void;
  destroy(): void;
}

export function createRemoteControl(video: HTMLVideoElement | undefined, report: (s: Partial<RemoteStates>) => void): RemoteControl {
  const v = video as (HTMLVideoElement & AirPlayVideo) | undefined;
  const offs: Unsubscribe[] = [];
  const airplay = typeof v?.webkitShowPlaybackTargetPicker === 'function';
  const remote = airplay ? undefined : v?.remote;
  const on = (target: EventTarget, type: string, h: (e: Event) => void): void => {
    target.addEventListener(type, h);
    offs.push(() => target.removeEventListener(type, h));
  };

  if (v !== undefined && airplay) {
    let available = false;
    const update = (): void => report({ airplay: v.webkitCurrentPlaybackTargetIsWireless === true ? 'connected' : available ? 'available' : 'unavailable' });
    on(v, 'webkitplaybacktargetavailabilitychanged', (e) => {
      available = (e as Event & { availability?: string }).availability === 'available';
      update();
    });
    on(v, 'webkitcurrentplaybacktargetiswirelesschanged', update);
  }
  if (remote !== undefined) {
    let available = false;
    const state = (): void => report({ cast: remote.state === 'disconnected' ? (available ? 'available' : 'unavailable') : remote.state });
    let watch: number | undefined;
    remote
      .watchAvailability((a) => {
        available = a;
        state();
      })
      .then(
        (id) => (watch = id),
        // NotSupportedError (e.g. MSE without a remote-capable source): stays unavailable.
        () => undefined,
      );
    for (const type of ['connecting', 'connect', 'disconnect']) on(remote, type, state);
    offs.push(() => {
      if (watch !== undefined) void remote.cancelWatchAvailability(watch).catch(() => undefined);
    });
  }

  return {
    prompt(target) {
      if (target === 'airplay') v?.webkitShowPlaybackTargetPicker?.();
      else void remote?.prompt().catch(() => undefined);
    },
    destroy() {
      for (const off of offs.splice(0)) off();
    },
  };
}
