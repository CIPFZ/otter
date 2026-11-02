// Server rendering of the framework example pages (site/{react,vue,svelte}-*.html, <html
// data-framework data-preset>): their #root is filled with the app rendered in Node (site/<framework>-
// ssr.ts(x), each exporting render(preset)) when the page is built or served, so the browser hydrates
// real server markup. The module is loaded through a Vite SSR server with the site's config.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer, type Plugin, type ViteDevServer } from 'vite';

export function frameworkSsrPlugin(): Plugin {
  let ssr: ViteDevServer | undefined;
  const server = async (dev: ViteDevServer | undefined): Promise<ViteDevServer> => {
    if (dev !== undefined) return dev;
    // The inner server loads this config too: without this plugin (e2e/vite.config.ts).
    process.env['OTTER_SSR_INNER'] = '1';
    ssr ??= await createServer({
      configFile: fileURLToPath(new URL('./vite.config.ts', import.meta.url)),
      server: { middlewareMode: true, hmr: false, ws: false },
      appType: 'custom',
      logLevel: 'silent',
    });
    return ssr;
  };
  return {
    name: 'otter-framework-ssr',
    async transformIndexHtml(html, ctx) {
      const m = /<html data-framework="(react|vue|svelte)" data-preset="([a-z-]+)"/.exec(html);
      if (m === null || !html.includes('<!--ssr-->')) return html;
      const [, framework, preset] = m as unknown as [string, string, string];
      const base = fileURLToPath(new URL(`./site/${framework}-ssr`, import.meta.url));
      const path = existsSync(`${base}.tsx`) ? `${base}.tsx` : `${base}.ts`;
      const { render } = (await (await server(ctx.server)).ssrLoadModule(path)) as { render: (p: string) => Promise<string> };
      return html.replace('<!--ssr-->', await render(preset));
    },
    async closeBundle() {
      await ssr?.close();
      ssr = undefined;
    },
  };
}
