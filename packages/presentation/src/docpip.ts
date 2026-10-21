// Document Picture-in-Picture move (ADR-007 §5), loaded on the first docpip request. The whole
// player root goes into the PiP window, so custom UI, captions and danmaku stay. Moving a <video>
// to another document can pause it or reset its position, so the playback state is recorded
// first and restored after each move.

interface Snapshot {
  readonly time: number;
  readonly paused: boolean;
  readonly rate: number;
}

const snapshot = (v: HTMLVideoElement | undefined): Snapshot | undefined =>
  v === undefined ? undefined : { time: v.currentTime, paused: v.paused, rate: v.playbackRate };

function restore(v: HTMLVideoElement | undefined, s: Snapshot | undefined): void {
  if (v === undefined || s === undefined) return;
  if (v.playbackRate !== s.rate) v.playbackRate = s.rate;
  // A reset position shows up as a jump back; a small drift while moving is fine.
  if (Math.abs(v.currentTime - s.time) > 0.5) v.currentTime = s.time;
  if (!s.paused && v.paused) void v.play().catch(() => undefined);
}

/** Copies the opener's style sheets into the PiP document (link or inline, by what is readable). */
function copyStyles(from: Document, to: Document): void {
  for (const sheet of Array.from(from.styleSheets)) {
    try {
      const style = to.createElement('style');
      style.textContent = Array.from(sheet.cssRules, (r) => r.cssText).join('\n');
      to.head.append(style);
    } catch {
      // Cross-origin sheet: rules are not readable, link it instead.
      if (sheet.href === null) continue;
      const link = to.createElement('link');
      link.rel = 'stylesheet';
      link.href = sheet.href;
      to.head.append(link);
    }
  }
}

/** Moves `container` into the PiP window, and back when the window closes (then `closed()`). */
export function moveInto(container: HTMLElement, pip: Window, video: HTMLVideoElement | undefined, closed: () => void): void {
  const home = container.ownerDocument;
  const placeholder = home.createElement('div');
  placeholder.setAttribute('data-otter-placeholder', '');
  const r = container.getBoundingClientRect();
  placeholder.style.cssText = `width:${r.width}px;height:${r.height}px`;
  copyStyles(home, pip.document);
  pip.document.body.style.margin = '0';
  const before = snapshot(video);
  container.before(placeholder);
  pip.document.body.append(container);
  restore(video, before);
  pip.addEventListener(
    'pagehide',
    () => {
      const s = snapshot(video);
      placeholder.replaceWith(container);
      restore(video, s);
      closed();
    },
    { once: true },
  );
}
