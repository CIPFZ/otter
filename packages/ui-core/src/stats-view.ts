// Stats for nerds view (UI-DESIGN §8), loaded the first time the panel is shown. Rows come from
// the store only: playback, network and QoE, plus the router's explanation.

import type { UiState } from './context.js';
import type { IconNode } from './icons.js';
import type { T as Tokens } from './primitives.js';
import type { UiStrings } from './strings.js';

/** Helpers owned by the main chunk (see the Stats element). */
export interface StatsDeps {
  readonly T: typeof Tokens;
  readonly glass: () => string;
  readonly glassFallback: (selector: string) => string;
  readonly icon: (node: IconNode) => string;
  readonly Copy: IconNode;
  readonly X: IconNode;
  readonly formatBitrate: (bps: number) => string;
  readonly formatMs: (ms: number) => string;
  readonly formatSeconds: (s: number | null | undefined) => string;
  readonly escapeHtml: (s: string) => string;
}

/** Builds the panel in `root`; returns its render function. */
export function mountStats(host: HTMLElement & { readonly strings: UiStrings }, root: ShadowRoot, d: StatsDeps): (s: Readonly<UiState>) => void {
  const { T } = d;
  root.innerHTML = `<style>
:host([hidden]) { display: none; }
:host { display: block; box-sizing: border-box; max-width: 360px; padding: 10px 12px 8px; border-radius: ${T.radius}; ${d.glass()}
  color: ${T.fg}; font: 500 11px/18px ${T.font}; }
.bar { display: flex; justify-content: flex-end; gap: 2px; margin: -6px -8px 0 0; float: right; }
.bar button { all: unset; cursor: pointer; width: 24px; height: 24px; display: grid; place-items: center; border-radius: 6px; color: ${T.muted}; }
.bar button:hover { background: ${T.hover}; color: ${T.fg}; }
.bar button:focus-visible { outline: 2px solid ${T.accentDeep}; outline-offset: 1px; }
.bar svg { width: 14px; height: 14px; }
dl { display: grid; grid-template-columns: max-content 1fr; column-gap: 14px; margin: 0; }
dl + dl { margin-top: 6px; }
dt { color: ${T.muted}; } dd { margin: 0; font-family: ${T.mono}; overflow-wrap: anywhere; }
details { margin-top: 6px; color: ${T.muted}; }
summary { cursor: pointer; } summary:focus-visible { outline: 2px solid ${T.accentDeep}; border-radius: 4px; }
pre { white-space: pre-wrap; margin: 4px 0 0; max-height: 12em; overflow: auto; font: 10px/1.4 ${T.mono}; color: ${T.fg}; }
${d.glassFallback(':host')}
</style><section part="panel"><div class="bar"><button part="copy" type="button" data-action="copy">${d.icon(d.Copy)}</button><button part="close" type="button" data-action="close">${d.icon(d.X)}</button></div>
<div class="body"></div><details part="route"><summary>Route (router.explain)</summary><pre></pre></details></section>`;
  const body = root.querySelector('.body') as HTMLElement;
  const route = root.querySelector('pre') as HTMLElement;
  let json = '';
  root.querySelector('[data-action="close"]')?.addEventListener('click', () => {
    host.hidden = true;
  });
  root.querySelector('[data-action="copy"]')?.addEventListener('click', () => {
    void navigator.clipboard?.writeText(json).catch(() => undefined);
  });
  const { formatBitrate, formatMs, formatSeconds, escapeHtml } = d;

  return (s) => {
    const t = host.strings;
    root.querySelector('section')?.setAttribute('aria-label', t.statistics);
    root.querySelector('[data-action="copy"]')?.setAttribute('aria-label', t.copy);
    root.querySelector('[data-action="close"]')?.setAttribute('aria-label', t.close);
    const q = s.qoe;
    const active = s.tracks.video.find((v) => v.id === s.activeQuality) ?? s.tracks.video.find((v) => v.selected);
    const buffer = Math.max(0, s.bufferedEnd - s.currentTime);
    const groups: [string, [string, string][]][] = [
      [
        t.statsPlayback,
        [
          ['Status', s.error === null ? s.status : `${s.status} (${s.error.type}: ${s.error.details})`],
          ['Format', s.format ?? '—'],
          ['Backend', `${s.backend ?? '—'}${s.mms ? ' (MMS)' : ''}`],
          ['Resolution', s.videoWidth > 0 ? `${s.videoWidth}×${s.videoHeight}` : '—'],
          ['Codec', active?.codec ?? q?.codec ?? '—'],
        ],
      ],
      [
        t.statsNetwork,
        [
          ['Quality', `${s.activeQuality ?? '—'} (${s.quality})${active?.bitrate === undefined ? '' : ` · ${formatBitrate(active.bitrate)}`}`],
          // Not measured yet: the engine's default is labelled, nothing is shown as a measurement.
          ['Bandwidth', q?.bandwidth == null ? '—' : `${formatBitrate(q.bandwidth)}${q.bandwidthEstimated === true ? ' (est.)' : ''}`],
          ['Buffer', formatSeconds(buffer)],
          ['Latency', s.live ? formatSeconds(s.latency ?? q?.latency) : '—'],
        ],
      ],
      [
        t.statsQuality,
        [
          ['TTFF', q?.ttff == null ? '—' : formatMs(q.ttff)],
          ['Rebuffers', q === undefined ? '—' : `${q.rebufferCount} (${formatMs(q.rebufferDuration)})`],
          ['Switches', q === undefined ? '—' : String(q.qualitySwitches)],
          ['Dropped', q === undefined ? '—' : `${q.droppedFrames} / ${q.totalFrames}`],
          ['Errors', q === undefined ? '—' : `${q.errors}${q.lastError === null ? '' : ` (last: ${q.lastError.details})`}`],
        ],
      ],
    ];
    json = JSON.stringify(Object.fromEntries(groups.flatMap(([, rows]) => rows)), null, 2);
    const html = groups
      .map(([, rows]) => `<dl>${rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd data-stat="${escapeHtml(k)}">${escapeHtml(v)}</dd>`).join('')}</dl>`)
      .join('');
    if (body.innerHTML !== html) body.innerHTML = html;
    const text = s.route === null ? 'no decision yet' : JSON.stringify(s.route, null, 2);
    if (route.textContent !== text) route.textContent = text;
  };
}
