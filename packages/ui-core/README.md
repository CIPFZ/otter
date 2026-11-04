# @otter-player/ui-core

Headless UI primitives (SPEC §14.1): `otter-*` Web Components, the player UI state (`PlayerUiState`) and the i18n string tables. Styles come from the skins (`@otter-player/ui-skin-*`, pure CSS); a primitive's shadow root holds only structure and defaults, and reads the public CSS variables below.

## Public CSS variables

Skins and hosts may set them on the player root (`[data-otter-player]`) or on `:root`; when unset, the default applies.

| Variable | Default | Purpose |
|---|---|---|
| `--otter-accent`, `--otter-accent-deep` | `#1ee9e6`, `#12c9d4` | Accent colour, focus ring |
| `--otter-fg`, `--otter-fg-muted`, `--otter-fg-dim` | white at 0.92 / 0.64 / 0.4 opacity | Text colours |
| `--otter-control-size`, `--otter-icon-size` | 40 px, 24 px | Button and icon size |
| `--otter-glass`, `--otter-glass-blur`, `--otter-glass-border` | see UI-DESIGN §4.1 | Glass material of menus and tooltips |
| `--otter-menu-width`, `--otter-thumbnail-width` / `-height` | 280 px, 160 × 90 px | Menus and preview cards |
| `--otter-cue-*` | — | The user's caption preferences (ADR-005 §4) |
| **`--otter-ui-text-scale`** | `1` | **A multiplier on every user-facing font size**: the bar's text buttons (quality, speed), the time display, the live badge, menus, preview cards, tooltips, feedback badges, the error card, the stats panel. It scales the text only, not the boxes of buttons and panels. `ui-skin-tv` uses 2.34 on the bar (13 px → 30 px), and also uses it to enlarge menus on browsers without CSS `zoom` |

The primitives' `part` names (`::part(button)`, `::part(menu)`, `::part(preview)` and so on) are public too; see the templates in `src/elements.ts`.
