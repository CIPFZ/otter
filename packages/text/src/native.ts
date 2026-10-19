// Native TextTrack path (ADR-007 §6), loaded the first time it is needed: the selected track's cues
// are mirrored into a TextTrack on the <video> as VTTCues, for modes where only the video element
// is on screen (iPhone system fullscreen, video PiP) or when the host asks for native captions.
// The system draws them with the user's OS caption preferences; Otter's CVAA style does not apply.

import type { CueNode, TextCue } from './cue.js';

// cue.js' cueText, repeated: a value import would make cue.js a shared chunk (side-effects gate).
const textOf = (nodes: readonly CueNode[]): string => nodes.map((n) => (n.type === 'text' ? n.text : textOf(n.children))).join('');

/** What the shell hands over: the <video> element (text never touches it otherwise). */
export interface NativeTextSink {
  addTextTrack(kind: TextTrackKind, label?: string, language?: string): TextTrack;
}

export interface NativeTrackInfo {
  readonly id: string;
  readonly role: 'subtitles' | 'captions';
  readonly label?: string;
  readonly language?: string;
}

export interface NativeMirror {
  /** Shows `track` with `cues` (added incrementally); every other mirrored track is disabled. */
  show(track: NativeTrackInfo, cues: readonly TextCue[]): void;
  /** Back to Otter's renderer: mirrored tracks go `hidden` (cues kept for the next switch). */
  hide(): void;
  /** New source: drops all mirrored cues. */
  reset(): void;
}

interface Mirrored {
  readonly track: TextTrack;
  readonly cues: Map<string, VTTCue>;
}

const toVttCue = (c: TextCue): VTTCue => {
  const cue = new VTTCue(c.startTime, c.endTime, textOf(c.nodes));
  const s = c.settings;
  if (typeof s.line === 'number') cue.line = s.line;
  if (typeof s.position === 'number') cue.position = s.position;
  if (typeof s.size === 'number') cue.size = s.size;
  cue.snapToLines = s.snapToLines;
  cue.align = s.align;
  return cue;
};

export function createNativeMirror(sink: NativeTextSink): NativeMirror {
  // addTextTrack() tracks cannot be removed: one per Otter track id, reused across switches.
  const tracks = new Map<string, Mirrored>();
  return {
    show(info, cues) {
      let m = tracks.get(info.id);
      if (m === undefined) {
        m = { track: sink.addTextTrack(info.role, info.label ?? info.language ?? '', info.language ?? ''), cues: new Map() };
        tracks.set(info.id, m);
      }
      for (const [id, other] of tracks) if (id !== info.id) other.track.mode = 'disabled';
      m.track.mode = 'showing';
      for (const c of cues) {
        if (m.cues.has(c.id)) continue;
        const cue = toVttCue(c);
        m.cues.set(c.id, cue);
        m.track.addCue(cue);
      }
    },
    hide() {
      for (const m of tracks.values()) if (m.track.mode === 'showing') m.track.mode = 'hidden';
    },
    reset() {
      for (const m of tracks.values()) {
        for (const cue of m.cues.values()) m.track.removeCue(cue);
        m.cues.clear();
        m.track.mode = 'disabled';
      }
    },
  };
}
