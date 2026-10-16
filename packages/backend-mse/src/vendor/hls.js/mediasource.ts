// Derived from hls.js@e5ff3583965e3af16c4a4b4d2b5f7bd1ffb5b7de src/utils/mediasource-helper.ts, Apache-2.0
// Derived from hls.js@e5ff3583965e3af16c4a4b4d2b5f7bd1ffb5b7de src/controller/buffer-controller.ts, Apache-2.0
//
// Copyright (c) 2017 Dailymotion (http://www.dailymotion.com). Licensed under the Apache License,
// Version 2.0. Local changes are listed in ./UPSTREAM.json.

type MediaSourceCtor = typeof MediaSource;

interface MediaSourceGlobals {
  MediaSource?: MediaSourceCtor;
  ManagedMediaSource?: MediaSourceCtor;
  WebKitMediaSource?: MediaSourceCtor;
}

const globals = (): MediaSourceGlobals => globalThis as unknown as MediaSourceGlobals;

/** ManagedMediaSource when preferred (or when it is the only option), else MediaSource. */
export function getMediaSource(preferManagedMediaSource = true): MediaSourceCtor | undefined {
  const g = globals();
  const mms = (preferManagedMediaSource || g.MediaSource === undefined) && g.ManagedMediaSource;
  return mms || g.MediaSource || g.WebKitMediaSource;
}

export function isManagedMediaSource(source: MediaSourceCtor | undefined): boolean {
  return source !== undefined && source === globals().ManagedMediaSource;
}

export function removeSourceChildren(node: HTMLElement): void {
  for (const source of Array.from(node.querySelectorAll('source'))) {
    node.removeChild(source);
  }
}

export function addSource(media: HTMLMediaElement, url: string, type = 'video/mp4'): HTMLSourceElement {
  const source = media.ownerDocument.createElement('source');
  source.type = type;
  source.src = url;
  media.appendChild(source);
  return source;
}
