// Remote control input for TV players (SPEC §14.3, ADR-013 batch 4): a configurable key map from
// remote keys (key names or platform key codes) to remote actions, spatial navigation between the
// player's focusable controls, Back, and accelerated seeking while Left / Right are held on the
// picture. A sub-path (@otter-player/input/remote): only TV players carry it.
//
// The store is structural: the remote dispatches the chrome's `show-controls` / `escape` and the
// media's `toggle-paused` / `seek-by` by name, so input keeps depending on core only.

/** Logical remote keys. */
export type RemoteKey = 'up' | 'down' | 'left' | 'right' | 'ok' | 'back' | 'playPause' | 'play' | 'pause' | 'fastForward' | 'rewind';

/** Per logical key: the KeyboardEvent `key` names and legacy `keyCode`s that mean it. */
export type RemoteKeyMap = Readonly<Record<RemoteKey, readonly (string | number)[]>>;

/**
 * Default map: browser key names, plus the codes of TV platforms whose remotes send no key name
 * (Tizen: Back 10009, Play/Pause 10252; webOS: Back 461; HbbTV / both: Play 415, Pause 19,
 * Fast-forward 417, Rewind 412).
 */
export const DEFAULT_REMOTE_KEYS: RemoteKeyMap = {
  up: ['ArrowUp'],
  down: ['ArrowDown'],
  left: ['ArrowLeft'],
  right: ['ArrowRight'],
  ok: ['Enter'],
  back: ['Escape', 'GoBack', 'BrowserBack', 'Backspace', 10009, 461],
  playPause: ['MediaPlayPause', 10252],
  play: ['MediaPlay', 415],
  pause: ['MediaPause', 19],
  fastForward: ['MediaFastForward', 417],
  rewind: ['MediaRewind', 412],
};

/** Seeking while Left / Right are held on the picture: the step grows with the time held. */
export interface RemoteSeek {
  /**
   * Seconds per step, by how long the key has been held (ms, ascending).
   * @defaultValue `[[0, 10], [1500, 30], [4000, 60]]`
   */
  readonly steps?: readonly (readonly [heldMs: number, seconds: number])[];
  /**
   * At most one step per this many ms while held (key repeat is faster).
   * @defaultValue `250`
   */
  readonly intervalMs?: number;
}

/** Options of bindRemote (and of the tv preset's `remote`). */
export interface RemoteOptions {
  /**
   * Keys per logical key, merged over DEFAULT_REMOTE_KEYS (a key given replaces its list).
   * @defaultValue `{}`
   */
  readonly keys?: Partial<RemoteKeyMap>;
  /**
   * Seeking while Left / Right (or fast-forward / rewind) are held.
   * @defaultValue `{}` (the steps and interval above)
   */
  readonly seek?: RemoteSeek;
}

/** What the remote needs of the player's store. */
export interface RemoteStore {
  /** The state; only `menu` is read (Back closes it first). */
  getState(): { readonly menu?: unknown };
  /** Dispatches the playback, navigation and control actions the remote uses. */
  dispatch(type: 'show-controls' | 'escape' | 'toggle-paused' | 'play' | 'pause' | 'seek-by', payload: Record<string, unknown>): boolean;
}

const DEFAULT_STEPS: readonly (readonly [number, number])[] = [
  [0, 10],
  [1500, 30],
  [4000, 60],
];

/** Seconds of one seek step after the key has been held `heldMs` (the last step at or below it). */
export function holdStep(heldMs: number, steps: readonly (readonly [number, number])[] = DEFAULT_STEPS): number {
  let s = steps[0]?.[1] ?? 10;
  for (const [at, seconds] of steps) if (heldMs >= at) s = seconds;
  return s;
}

/** The logical key an event means under `map`, if any. */
export function remoteKeyOf(e: Pick<KeyboardEvent, 'key' | 'keyCode'>, map: RemoteKeyMap): RemoteKey | undefined {
  for (const [name, list] of Object.entries(map) as [RemoteKey, readonly (string | number)[]][]) {
    if (list.some((k) => (typeof k === 'number' ? e.keyCode === k : e.key === k))) return name;
  }
  return undefined;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
/** Elements that use the arrows themselves (sliders, menus): Left / Right stay theirs. */
const OWN_ARROWS = '[role="slider"], input[type="range"], [role="menu"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';
const ARROW: Record<'up' | 'down' | 'left' | 'right', string> = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };

/** Visible focusable controls inside `root`, open shadow roots included. */
export function focusables(root: Element): HTMLElement[] {
  const out: HTMLElement[] = [];
  const visit = (node: Element | ShadowRoot): void => {
    for (const child of Array.from(node.children)) {
      if (child instanceof HTMLElement && child.matches(FOCUSABLE) && child.getAttribute('aria-hidden') !== 'true') {
        const r = child.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && child.closest('[hidden]') === null) out.push(child);
      }
      if (child.shadowRoot !== null) visit(child.shadowRoot);
      visit(child);
    }
  };
  visit(root);
  return out;
}

/** The focused element, through open shadow roots. */
function deepActive(doc: Document): Element | null {
  let a = doc.activeElement;
  while (a?.shadowRoot?.activeElement != null) a = a.shadowRoot.activeElement;
  return a;
}

/** The nearest control from `from` in a direction: along the axis first, sideways offset weighs double. */
export function nearest(from: Element, list: readonly HTMLElement[], key: string): HTMLElement | undefined {
  const a = from.getBoundingClientRect();
  const ax = a.left + a.width / 2;
  const ay = a.top + a.height / 2;
  let best: HTMLElement | undefined;
  let score = Number.POSITIVE_INFINITY;
  for (const el of list) {
    if (el === from) continue;
    const b = el.getBoundingClientRect();
    const dx = b.left + b.width / 2 - ax;
    const dy = b.top + b.height / 2 - ay;
    const [main, side] = key === 'ArrowLeft' ? [-dx, dy] : key === 'ArrowRight' ? [dx, dy] : key === 'ArrowUp' ? [-dy, dx] : [dy, dx];
    if (main <= 1) continue;
    const s = main + 2 * Math.abs(side);
    if (s < score) {
      score = s;
      best = el;
    }
  }
  return best;
}

/**
 * Remote navigation on the player root. Runs before the InputController (capture), which skips
 * keys already handled (defaultPrevented). On the picture (no control focused): Up / Down bring the
 * controls up with the play button focused, Left / Right seek (accelerating while held). In the
 * controls: the arrows move the focus to the nearest control; Back closes a menu, else leaves the
 * controls. Media keys play, pause and seek anywhere.
 */
export function bindRemote(root: HTMLElement, store: RemoteStore, options: RemoteOptions = {}): () => void {
  const doc = root.ownerDocument;
  const map: RemoteKeyMap = { ...DEFAULT_REMOTE_KEYS, ...options.keys };
  const steps = options.seek?.steps ?? DEFAULT_STEPS;
  const interval = options.seek?.intervalMs ?? 250;
  /** The Left / Right hold in progress on the picture. */
  let hold: { key: 'left' | 'right'; since: number; last: number } | undefined;

  const seek = (key: 'left' | 'right', repeat: boolean): void => {
    const now = performance.now();
    if (!repeat || hold === undefined || hold.key !== key) {
      hold = { key, since: now, last: now };
      store.dispatch('seek-by', { seconds: key === 'right' ? holdStep(0, steps) : -holdStep(0, steps) });
      return;
    }
    if (now - hold.last < interval) return;
    hold.last = now;
    const s = holdStep(now - hold.since, steps);
    store.dispatch('seek-by', { seconds: key === 'right' ? s : -s });
  };

  const onKeyUp = (e: KeyboardEvent): void => {
    const k = remoteKeyOf(e, map);
    if (k === 'left' || k === 'right') hold = undefined;
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const key = remoteKeyOf(e, map);
    if (key === undefined) return;
    const active = deepActive(doc);
    const inside = active !== null && active !== root && root.contains(active instanceof Element && active.getRootNode() instanceof ShadowRoot ? (active.getRootNode() as ShadowRoot).host : active);
    switch (key) {
      case 'back': {
        if (e.key === 'Backspace' && active instanceof HTMLInputElement && active.type === 'text') return;
        e.preventDefault();
        // A menu closes first (the chrome's escape); with none open, the focus leaves the controls.
        const menu = store.getState().menu;
        store.dispatch('escape', {});
        if (menu == null && inside) root.focus();
        return;
      }
      case 'playPause':
      case 'play':
      case 'pause':
        // Held keys repeat; repeating a toggle would flicker.
        e.preventDefault();
        if (!e.repeat) store.dispatch(key === 'playPause' ? 'toggle-paused' : key, {});
        return;
      case 'fastForward':
      case 'rewind':
        e.preventDefault();
        seek(key === 'fastForward' ? 'right' : 'left', e.repeat);
        return;
      case 'ok':
        // The focused control's own activation (Enter on a button); on the picture, play / pause.
        if (inside) return;
        e.preventDefault();
        if (!e.repeat) store.dispatch('toggle-paused', {});
        return;
      default:
        break;
    }
    const arrow = ARROW[key];
    if (!inside) {
      e.preventDefault();
      if (key === 'left' || key === 'right') return seek(key, e.repeat);
      // Up / Down bring the controls and focus the play button (the time slider before it keeps
      // Left / Right for seeking).
      store.dispatch('show-controls', {});
      const list = focusables(root);
      const host = (el: HTMLElement): Element => (el.getRootNode() instanceof ShadowRoot ? (el.getRootNode() as ShadowRoot).host : el);
      const inBar = list.filter((el) => host(el).closest('[data-otter-controls]') !== null);
      (inBar.find((el) => host(el).tagName === 'OTTER-PLAY-BUTTON') ?? inBar[0])?.focus();
      return;
    }
    if ((key === 'left' || key === 'right') && active instanceof Element && active.closest(OWN_ARROWS) !== null) return;
    if (active instanceof Element && active.closest('[role="menu"], [role^="menuitem"]') !== null) return;
    e.preventDefault();
    store.dispatch('show-controls', {});
    const next = nearest(active as Element, focusables(root), arrow);
    if (next !== undefined) next.focus();
    else if (key === 'up') root.focus();
  };
  root.addEventListener('keydown', onKey, true);
  root.addEventListener('keyup', onKeyUp, true);
  return () => {
    root.removeEventListener('keydown', onKey, true);
    root.removeEventListener('keyup', onKeyUp, true);
  };
}
