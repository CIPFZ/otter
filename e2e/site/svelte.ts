// Client entry of the Svelte example pages: hydrates the server-rendered app (#root). Svelte's
// production build does not report a hydration mismatch: e2e/bindings.spec.ts checks that the
// server's box is the element kept.
import { hydrate } from 'svelte';
import App from './SvelteApp.svelte';
import type { ExamplePlayer, ExamplePreset } from './example-presets.ts';

const preset = document.documentElement.dataset['preset'] as ExamplePreset;
window.hydrationErrors = [];
hydrate(App, { target: document.getElementById('root') as HTMLElement, props: { preset, onplayer: (p: ExamplePlayer | null) => (window.examplePlayer = p) } });
