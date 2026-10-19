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

/** Spoken form for aria-valuetext: "1 minute 15 seconds". */
export function speakTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'unknown';
  const s = Math.floor(seconds);
  const parts: string[] = [];
  const unit = (n: number, word: string): void => {
    if (n > 0) parts.push(`${n} ${word}${n === 1 ? '' : 's'}`);
  };
  unit(Math.floor(s / 3600), 'hour');
  unit(Math.floor((s % 3600) / 60), 'minute');
  unit(s % 60, 'second');
  return parts.length === 0 ? '0 seconds' : parts.join(' ');
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
