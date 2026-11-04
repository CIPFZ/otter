# @otter-player/input

One mapping from keyboard, pointer and gestures to actions (SPEC §14.3). The main entry is `createInputController`; the TV remote is the sub-path `@otter-player/input/remote` (only TV players carry it).

## Remote: `@otter-player/input/remote`

```ts
import { bindRemote, DEFAULT_REMOTE_KEYS } from '@otter-player/input/remote';

const off = bindRemote(playerRoot, player.store, {
  // A logical key's list is replaced as a whole; the others keep the defaults.
  keys: { back: [...DEFAULT_REMOTE_KEYS.back, 8] },
  // Seconds per step while Left / Right (or fast-forward / rewind) are held: held for (ms) → seconds.
  seek: { steps: [[0, 10], [1500, 30], [4000, 60]], intervalMs: 250 },
});
```

The tv preset has it wired: pass the same options as `createTvPlayer({ ..., remote: { keys, seek } })`.

- On the picture (no control focused): Up / Down bring up the controls with the play button focused; Left / Right rewind / fast-forward, accelerating while held; OK plays / pauses.
- In the controls: the arrows move to the nearest control (spatial navigation); Back closes a menu first, then leaves the controls.
- Media keys (play / pause, fast-forward / rewind) work at any time; toggling keys do not fire again on key repeat.

### Where the defaults come from

**The defaults are taken from common implementations, not from vendor specifications, and all of them are configurable**:

| Logical key | Default |
|---|---|
| Back | `Escape`, `GoBack`, `BrowserBack`, `Backspace`; Tizen 10009; webOS 461 |
| Play / pause | `MediaPlayPause`; Tizen 10252 |
| Play, pause | `MediaPlay` / 415; `MediaPause` / 19 |
| Fast-forward, rewind | `MediaFastForward` / 417; `MediaRewind` / 412 |
| Arrows, OK | `ArrowUp` / `ArrowDown` / `ArrowLeft` / `ArrowRight`, `Enter` |

- The platform keyCodes are the values common in Tizen, webOS and HbbTV web apps; they may differ between vendors and model years.
- The hold steps (10 s, 30 s after 1.5 s held, 60 s after 4 s; at most one step per 250 ms) follow the feel of common TV players; there is no standard.
- Checks on real remotes and the webOS emulator are on the M7 list (`docs/reports/M6.md`), without waiting for the emulator.
