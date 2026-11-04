import { container, sources } from './page.ts';
// #region example:surveillance
import { createSurveillancePlayer } from '@otter-player/presets/surveillance';
import '@otter-player/ui-skin-default';

// One tile per stream: HTTP-FLV, WS-FLV, live MPEG-TS, HLS.
const player = createSurveillancePlayer({ container, title: 'Lobby', streams: sources });
// #endregion
export { player };
