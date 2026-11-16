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

/**
 * In the window the player fills it. The page's style sheets come along (copyStyles), and with
 * them the host's body margin / padding and the player's own size (width, aspect-ratio): without
 * this the player sat 16 px in and kept its page shape (e2e/presentation.spec.ts). overflow: clip,
 * not hidden: a tooltip past the edge would let focus scroll the player sideways.
 */
const FILL = `html, body { margin: 0 !important; padding: 0 !important; height: 100%; overflow: hidden; background: #000; }
[data-otter-presentation="docpip"] { position: fixed !important; inset: 0 !important; width: auto !important; height: auto !important; max-width: none !important; max-height: none !important; aspect-ratio: auto !important; overflow: clip !important; }`;

/** Moves `container` into the PiP window, and back when the window closes (then `closed()`). */
export function moveInto(container: HTMLElement, pip: Window, video: HTMLVideoElement | undefined, closed: () => void): void {
  const home = container.ownerDocument;
  const placeholder = home.createElement('div');
  placeholder.setAttribute('data-otter-placeholder', '');
  const r = container.getBoundingClientRect();
  placeholder.style.cssText = `width:${r.width}px;height:${r.height}px`;
  copyStyles(home, pip.document);
  // The window's document starts empty: without a title and a language it fails axe's
  // document-title and html-has-lang (serious), and screen readers have no name for it.
  pip.document.title = home.title;
  const lang = home.documentElement.lang;
  if (lang !== '') pip.document.documentElement.lang = lang;
  const fill = pip.document.createElement('style');
  fill.textContent = FILL;
  pip.document.head.append(fill);
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
