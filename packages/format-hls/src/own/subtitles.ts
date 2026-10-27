// Subtitle renditions of the own CMAF-HLS engine (ADR-010), a chunk loaded when a text track is
// selected: the rendition's segments around the playhead, parsed and handed out as cue batches.
// Segmented WebVTT: cue timing, settings and text of each block, placed on the media timeline. With X-TIMESTAMP-MAP the cue
// times are mapped through MPEGTS (90 kHz, the media's own PTS clock, which the engine does not
// shift): media time = cue time - LOCAL + MPEGTS / 90000. Without it the cue times are playlist
// times and `offset` (media - playlist) is added. Text keeps WebVTT markup out (tags dropped,
// the few entities decoded); styling of cue spans is the text package's business for sidecars.

import type { InbandCue } from '@otter-player/media';
import type { PartiallyResolvedTextTrack } from '../vendor/video.js/media/types/index.js';
import type { EngineInner } from './engine.js';

/**
 * Loads `partial`'s cues around the playhead every 2 s and after seeks, as `trackId` batches while
 * that track stays selected; returns the stop function.
 */
export function loadSubtitles(e: EngineInner, partial: PartiallyResolvedTextTrack, trackId: string): () => void {
  const done = new Set<string>();
  let stopped = false;
  let busy = false;
  const pull = async (): Promise<void> => {
    if (busy || stopped) return;
    busy = true;
    try {
      // Live: the subtitle playlist moves with the stream, so it is re-read each time.
      if (e._isLive()) e._forget(partial.id);
      const now = e._playlistTime();
      for (const seg of (await e._resolve(partial)).segments) {
        if (stopped || done.has(seg.id) || seg.startTime + seg.duration < now - 1 || seg.startTime > now + e._forwardS) continue;
        const text = new TextDecoder().decode((await e._get(seg, 'caption')).data);
        done.add(seg.id);
        const cues = parseVttSegment(text, e._offset());
        if (!stopped && e._textTrack() === trackId && cues.length > 0) e._bus.emit('text-cues', { trackId, cues });
      }
    } catch (err) {
      // Subtitles are not worth stopping playback for.
      if ((err as { name?: string } | null)?.name !== 'AbortError')
        e._bus.emit('error', e._core._createError({ type: 'other', details: 'subtitleLoadError', fatal: false, recoverable: true, message: String(err), cause: err }));
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void pull(), 2000);
  e._media.addEventListener('seeked', pull);
  void pull();
  return () => {
    stopped = true;
    clearInterval(timer);
    e._media.removeEventListener('seeked', pull);
  };
}

const TIME = /(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})/;

/** WebVTT timestamp (hh:mm:ss.ttt or mm:ss.ttt) -> seconds, NaN when malformed. */
export function vttTime(text: string): number {
  const m = TIME.exec(text);
  if (m === null) return Number.NaN;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

const ENTITIES: Readonly<Record<string, string>> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&nbsp;': ' ', '&lrm;': '‎', '&rlm;': '‏' };
const plain = (text: string): string => text.replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|nbsp|lrm|rlm);/g, (e) => ENTITIES[e] ?? e);

const percent = (v: string): number | undefined => (v.endsWith('%') ? Number(v.slice(0, -1)) : undefined);

/** Cue settings (line, position, size, align) on the timing line. */
function settings(parts: readonly string[]): Partial<InbandCue> {
  const out: { -readonly [K in keyof InbandCue]?: InbandCue[K] } = {};
  for (const part of parts) {
    const [key, raw = ''] = part.split(':');
    const [value = '', extra] = raw.split(',');
    if (key === 'line') {
      const p = percent(value);
      out.line = p ?? Number(value);
      out.snapToLines = p === undefined;
      if (extra === 'start' || extra === 'center' || extra === 'end') out.lineAlign = extra;
    } else if (key === 'position') {
      const p = percent(value);
      if (p !== undefined) out.position = p;
      if (extra === 'line-left' || extra === 'center' || extra === 'line-right') out.positionAlign = extra;
    } else if (key === 'size') {
      const p = percent(value);
      if (p !== undefined) out.size = p;
    } else if (key === 'align' && /^(start|center|end|left|right)$/.test(value)) {
      out.align = value as NonNullable<InbandCue['align']>;
    }
  }
  return out;
}

/** Cues of one WebVTT segment, on the media timeline. */
export function parseVttSegment(text: string, offset: number): InbandCue[] {
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  let shift = offset;
  const head = blocks[0] ?? '';
  const map = /X-TIMESTAMP-MAP=([^\n]*)/.exec(head)?.[1];
  if (map !== undefined) {
    const mpegts = Number(/MPEGTS:(\d+)/.exec(map)?.[1] ?? 0);
    const local = vttTime(/LOCAL:([\d:.]+)/.exec(map)?.[1] ?? '00:00.000');
    shift = mpegts / 90000 - (Number.isNaN(local) ? 0 : local);
  }
  const cues: InbandCue[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const [from = '', rest = ''] = (lines[at] as string).split('-->');
    const [to = '', ...parts] = rest.trim().split(/\s+/);
    const start = vttTime(from);
    const end = vttTime(to);
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    const body = plain(lines.slice(at + 1).join('\n')).trim();
    if (body === '') continue;
    const startTime = start + shift;
    const endTime = end + shift;
    // Identity is time + text: segment edges repeat a cue in both segments.
    cues.push({ id: `${startTime.toFixed(3)}-${endTime.toFixed(3)}-${body}`, startTime, endTime, text: body, ...settings(parts) });
  }
  return cues;
}
