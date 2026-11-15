---
"@otter-player/ui-core": patch
"@otter-player/input": patch
"@otter-player/presentation": patch
---

Document Picture-in-Picture fixes. In the PiP window the player's elements belong to that window, which the menus, the UI language lookup and the input controller did not expect: menu rows could not be chosen, the player's `lang` was ignored, and keys on a control (arrows on a slider) went to the player's hotkeys. The PiP window's document now also gets the page's title and language (it had none, an accessibility failure).
