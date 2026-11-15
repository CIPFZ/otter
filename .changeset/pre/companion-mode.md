---
"@otter-player/presentation": minor
"@otter-player/ui-core": minor
"@otter-player/preferences": minor
"@otter-player/presets": minor
---

Companion mode (off by default): `presentation: { companion: true | CompanionOptions }` on `createPlayer` and the presets built on it makes the PiP button open a small Document Picture-in-Picture window for playing while working: the picture dimmed (`dim`, 0 to 0.8), a width step (`size`: 240 / 320 / 440 px), the controls shown only while the pointer or the focus is in the window, an audio strip on request (`audioOnly`; the video still decodes), danmaku and captions off in the window and back after (`quiet`), and pause or keep playing when the viewer closes it (`onClose`). New actions `toggle-companion` and `companion-set`, state `presentation.companion`, a "Floating player" settings page, `CompanionOptions` / `CompanionState` / `CompanionStrings`, `PresentationRequestOptions.docPipSize` and `disallowReturnToOpener`, the `hide-controls` player UI action, and `companion` in the viewer's preferences. Where Document Picture-in-Picture is missing (Firefox, Safari, iPhone, an iframe) nothing changes. The `tv` preset turns it off.

`PresentationSnapshot.companion` is a new required field: code that builds presentation snapshots itself has to add it. `bindActivity` now also dispatches `hide-controls`, so a hand-typed store passed to it has to accept that action.
