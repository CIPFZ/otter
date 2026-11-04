// What the example page gives every example (e2e/site/examples.html): the host element and the
// sources from the query (?src=<url>[,<url>...]). The examples' code, between their
// `// #region example:<name>` markers, is the code of the @example blocks in the TSDoc
// (`pnpm check:docs-site` compares them) and the docs site's example sections.

import type { DrmConfig } from '@otter-player/media';

declare global {
  interface Window {
    /** ott-drm: the DRM config a test sets before the page script runs (init script). */
    OTTER_DRM?: DrmConfig;
  }
}

const params = new URLSearchParams(location.search);
export const container = document.getElementById('player') as HTMLElement;
/** The first source. */
export const src = (params.get('src') ?? '').split(',')[0] ?? '';
/** All sources (a wall's streams, a feed). */
export const sources = (params.get('src') ?? '').split(',');
/** ott-drm: license servers (the tests inject ClearKey keys). */
export const drm: DrmConfig = window.OTTER_DRM ?? { servers: {} };
