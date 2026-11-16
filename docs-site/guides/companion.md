# Companion mode

Play while working: the player goes into a small always-on-top window, the picture dimmed, the controls out of the way until the pointer comes in, or just an audio strip. Companion mode is built on Document Picture-in-Picture: it is the `docpip` presentation mode with its own settings, not a new mode.

## Turning it on

Pass `presentation.companion` to `createPlayer` or a preset that is built on it (vod, live, lowlatency, ott-drm, danmaku): `true` for the defaults, or a `CompanionOptions` object. Then the PiP button opens the companion window where the browser has Document Picture-in-Picture.

{{example:companion}}

## Options

| Option | Default | What it does |
|---|---|---|
| `dim` | `0.4` | Dims the picture in the window, 0 to 0.8. Over the player's own brightness, never under it; back in the page the dimming goes away. Danmaku, captions, watermarks and the controls are not dimmed. |
| `size` | `'m'` | Width of the window when it first opens: 240 / 320 / 440 px (`'s'` / `'m'` / `'l'`); the height follows the picture. The viewer resizes it by dragging its edge, and the browser opens it at that size next time. Edge opens at least 248 px wide. |
| `audioOnly` | `false` | An audio strip instead of the picture: play / pause, mute, progress and time, back to the page. The video still decodes; hiding the picture lowers the compositing and presenting CPU, not the decoding. |
| `quiet` | `true` | Danmaku and captions off in the window, back as they were when it closes. Not written to the viewer's preferences. |
| `onClose` | `'pause'` | When the viewer closes the window with the browser's close button: pause, or keep playing in the page. The window's own "Back to the page" button never pauses. |
| `remember` | `true` | Keeps `dim` and `audioOnly` in the viewer's preferences (`@otter-player/preferences`). The window's size and position are left to the browser. |

## Controls in the window

- The control bar is slim: play / pause, mute, progress and time, back to the page. There is no settings menu in the window; the full settings stay in the page.
- At the top right, a small **dimming slider** with five steps (0 / 20 / 40 / 60 / 80 %: drag or click to the nearest step, arrow keys, Home / End or the mouse wheel step by one) and an **audio strip** switch. In the audio strip a **show picture** button brings the picture back.
- The controls show while the pointer is in the window or the keyboard focus is on one of them, and hide as soon as both leave. Starting playback or other media events do not show them.
- In the page, the settings menu has a **Floating player** page (dimming in five steps, audio strip) where companion mode is supported.

## Actions and state

- `toggle-pip` opens the companion window where Document Picture-in-Picture exists; `toggle-companion` does the same, and is refused (`presentation-denied`, reason `unsupported`) where it does not.
- `companion-set` changes `dim` or `audioOnly`. In an open window the audio strip resizes it at once (keeping its width, and giving back the size it had when the picture returns), which the browser allows only inside a user gesture (a click is one). Without one the window keeps its size and a `presentation-denied` event with reason `noUserGesture` says so.
- `store.getState().presentation.companion` holds `supported`, `active`, `dim`, `audioOnly`, `remember` and `quieted`.

## Where it works

- Browsers with Document Picture-in-Picture, at the top level of a page served from a secure origin (HTTPS or localhost): desktop Chrome and Edge, and Firefox (checked with Firefox 160). Support is detected from the API, never from the browser's name.
- Safari, iPhone and an iframe have no Document Picture-in-Picture: `supported` is false, the settings page is not shown and the PiP button keeps its old rules (video Picture-in-Picture, the picture only). No error is reported.
- Not on TVs: the `tv` preset turns it off. `basic`, `shorts`, `surveillance` and `background` do not offer it.
- Browsers cannot make the window transparent or let clicks through; that needs a desktop shell.
