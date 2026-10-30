// Server rendering of the React example pages (site/react-*.html): their #root is filled with the
// app rendered in Node (react-dom/server) when the page is built or served, so the browser hydrates
// real server markup. The app module is loaded through a Vite SSR server with the site's config.
import { fileURLToPath } from 'node:url';
import { createServer, type Plugin, type ViteDevServer } from 'vite';

export function reactSsrPlugin(): Plugin {
  let ssr: ViteDevServer | undefined;
  const load = async (dev: ViteDevServer | undefined): Promise<string> => {
    if (dev === undefined) {
      process.env['OTTER_SSR_INNER'] = '1';
      ssr ??= await createServer({
        configFile: fileURLToPath(new URL('./vite.config.ts', import.meta.url)),
        server: { middlewareMode: true, hmr: false, ws: false },
        appType: 'custom',
        logLevel: 'silent',
        plugins: [],
      });
    }
    return fileURLToPath(new URL('./site/react-app.tsx', import.meta.url));
  };
  return {
    name: 'otter-react-ssr',
    async transformIndexHtml(html, ctx) {
      const preset = /<html data-preset="([a-z-]+)"/.exec(html)?.[1];
      if (preset === undefined || !html.includes('<!--ssr-->')) return html;
      const path = await load(ctx.server);
      const server = ctx.server ?? (ssr as ViteDevServer);
      const { App } = (await server.ssrLoadModule(path)) as typeof import('./site/react-app.tsx');
      const { renderToString } = await import('react-dom/server');
      const { createElement } = await import('react');
      return html.replace('<!--ssr-->', renderToString(createElement(App, { preset: preset as 'basic' })));
    },
    async closeBundle() {
      await ssr?.close();
      ssr = undefined;
    },
  };
}
