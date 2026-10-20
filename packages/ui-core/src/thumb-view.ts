// Preview card pictures (ADR-007 §7), an on-demand chunk the progress bar loads with its first
// thumbnail source: a sprite tile scaled into the card, or a decoded frame on a canvas.

import type { Thumbnail } from '@otter-player/media';

const CSS = `.thumb > i, .thumb > canvas { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.thumb > canvas { width: 100%; height: 100%; }
.thumb > [hidden] { display: none; }`;

/** Returns the function that shows `t` in `card` (null: the card shows the time only). */
export function createThumbView(card: HTMLElement): (t: Thumbnail | null) => void {
  const doc = card.ownerDocument;
  const box = card.querySelector('.thumb') as HTMLElement;
  const style = doc.createElement('style');
  style.textContent = CSS;
  card.before(style);
  const tile = box.insertBefore(doc.createElement('i'), box.firstChild);
  const canvas = box.insertBefore(doc.createElement('canvas'), box.firstChild);
  return (t) => {
    card.toggleAttribute('data-thumb', t !== null);
    if (t === null) return;
    tile.hidden = !('url' in t);
    canvas.hidden = 'url' in t;
    if ('bitmap' in t) {
      canvas.width = t.bitmap.width;
      canvas.height = t.bitmap.height;
      canvas.getContext('2d')?.drawImage(t.bitmap, 0, 0);
      return;
    }
    const s = tile.style;
    const W = box.clientWidth;
    const H = box.clientHeight;
    // Escaped for a quoted CSS url(): provider URLs come from untrusted track files.
    s.backgroundImage = `url("${t.url.replace(/["\\\n\r]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)}")`;
    s.backgroundRepeat = 'no-repeat';
    s.width = `${t.w || W}px`;
    s.height = `${t.h || H}px`;
    s.backgroundPosition = `${-t.x}px ${-t.y}px`;
    s.backgroundSize = t.w > 0 ? '' : 'cover';
    s.transform = t.w > 0 ? `scale(${W / t.w}, ${H / t.h})` : '';
  };
}
