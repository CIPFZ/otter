// @otter-player/text/render (ADR-008): the cue renderer and the WebVTT layout, an entry of its own
// so the text overlay loads it with the first cue it draws; pages without captions on screen do
// not carry it (first-screen budget, SPEC §1.1).

export { createCueRenderer, type CueRenderer } from './renderer.js';
export {
  cueArea,
  horizontalLayout,
  layoutCues,
  type Area,
  type Box,
  type HorizontalLayout,
  type LayoutItem,
  type PlacedCue,
} from './layout.js';
