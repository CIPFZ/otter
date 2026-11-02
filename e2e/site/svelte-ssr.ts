// Server render of the Svelte example page (e2e/framework-ssr.ts loads this in Node).
import { render as renderSvelte } from 'svelte/server';
import App from './SvelteApp.svelte';
import type { ExamplePreset } from './example-presets.ts';

export const render = (preset: ExamplePreset): Promise<string> => Promise.resolve(renderSvelte(App, { props: { preset } }).body);
