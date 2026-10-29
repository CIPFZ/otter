// Display formatting shared by the primitives and the stats panel.

/** 75 -> "1:15", 3725 -> "1:02:05". Non-finite values render as "--:--". */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Units of a spoken duration (a UiStrings table): "{n} minute" / "{n} minutes", ... */
export type TimeWords = Readonly<Record<'hour' | 'hours' | 'minute' | 'minutes' | 'second' | 'seconds' | 'timeUnknown', string>>;

const EN_WORDS: TimeWords = { hour: '{n} hour', hours: '{n} hours', minute: '{n} minute', minutes: '{n} minutes', second: '{n} second', seconds: '{n} seconds', timeUnknown: 'unknown' };

/** Spoken form for aria-valuetext: "1 minute 15 seconds" (in the words of `w`, default English). */
export function speakTime(seconds: number, w: TimeWords = EN_WORDS): string {
  if (!Number.isFinite(seconds) || seconds < 0) return w.timeUnknown;
  const s = Math.floor(seconds);
  const parts: string[] = [];
  const unit = (n: number, one: string, many: string): void => {
    if (n > 0) parts.push((n === 1 ? one : many).replace('{n}', String(n)));
  };
  unit(Math.floor(s / 3600), w.hour, w.hours);
  unit(Math.floor((s % 3600) / 60), w.minute, w.minutes);
  unit(s % 60, w.second, w.seconds);
  return parts.length === 0 ? w.seconds.replace('{n}', '0') : parts.join(' ');
}

/** bits per second -> "4.2 Mbps". */
export function formatBitrate(bps: number | null | undefined): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps) || bps <= 0) return '—';
  return bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} Mbps` : `${Math.round(bps / 1e3)} kbps`;
}

export function formatMs(ms: number | null | undefined): string {
  return ms === null || ms === undefined || !Number.isFinite(ms) ? '—' : `${Math.round(ms)} ms`;
}

export function formatSeconds(s: number | null | undefined): string {
  return s === null || s === undefined || !Number.isFinite(s) ? '—' : `${s.toFixed(1)} s`;
}
