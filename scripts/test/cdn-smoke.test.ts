import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { get, Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from '@playwright/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cdnSmoke, createCdnSmokeServer } from '../lib/cdn-smoke.ts';

let work: string;
let cdn: string;
let media: string;
const servers: Server[] = [];
const close = async (server: Server): Promise<void> => {
  if (server.listening) await new Promise<void>((done, reject) => server.close((error) => error === undefined ? done() : reject(error)));
};
const request = async (server: Server, path: string): Promise<{ status: number; body: string }> =>
  new Promise((done, reject) => {
    get({ hostname: '127.0.0.1', port: (server.address() as { port: number }).port, path }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body += chunk; });
      response.on('end', () => done({ status: response.statusCode ?? 0, body }));
    }).on('error', reject);
  });
const serve = async (): Promise<Server> => {
  const server = createCdnSmokeServer(cdn, media, ['otter-basic']);
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return server;
};
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'otter-cdn-server-'));
  cdn = join(work, 'cdn');
  media = join(work, 'media');
  mkdirSync(cdn); mkdirSync(media); mkdirSync(join(work, 'outside'));
  writeFileSync(join(cdn, 'entry.js'), 'export const ok = true;');
  writeFileSync(join(media, 'clip.mp4'), 'fixture');
  writeFileSync(join(work, 'outside', 'sentinel.txt'), 'OUTSIDE_SENTINEL');
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) await close(server);
  rmSync(work, { recursive: true, force: true });
});

describe('release smoke fixture server', () => {
  it('serves the selected CDN and media files', async () => {
    const server = await serve();
    expect(await request(server, '/cdn/entry.js')).toEqual({ status: 200, body: 'export const ok = true;' });
    expect(await request(server, '/clip.mp4')).toEqual({ status: 200, body: 'fixture' });
    expect((await request(server, '/otter-basic.html')).status).toBe(200);
  });

  it.each(['/../outside/sentinel.txt', '/%2e%2e/outside/sentinel.txt', '/cdn/../../outside/sentinel.txt', '/cdn/%2e%2e/%2e%2e/outside/sentinel.txt', '/..%5coutside%5csentinel.txt'])('refuses paths outside the roots: %s', async (path) => {
    const server = await serve();
    expect(await request(server, path)).toEqual({ status: 404, body: '' });
  });

  it('refuses a symbolic link or Windows junction escaping a fixture root', async () => {
    symlinkSync(join(work, 'outside'), join(media, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const server = await serve();
    expect(await request(server, '/escape/sentinel.txt')).toEqual({ status: 404, body: '' });
  });

  it('rejects malformed URL escapes without crashing', async () => {
    const server = await serve();
    expect((await request(server, '/%zz')).status).toBe(400);
    expect((await request(server, '/clip.mp4')).status).toBe(200);
  });

  it.each(['launch', 'close'] as const)('closes its loopback server when browser %s fails', async (stage) => {
    const originalListen = Server.prototype.listen;
    const listen = vi.spyOn(Server.prototype, 'listen').mockImplementation(function (this: Server, ...args: unknown[]) {
      servers.push(this);
      return Reflect.apply(originalListen, this, args) as Server;
    });
    const failure = new Error('browser fixture failure');
    if (stage === 'launch') vi.spyOn(chromium, 'launch').mockRejectedValue(failure);
    else vi.spyOn(chromium, 'launch').mockResolvedValue({ close: async () => { throw failure; } } as unknown as Browser);
    await expect(cdnSmoke(cdn, media, [])).rejects.toThrow(failure);
    expect(listen).toHaveBeenCalledWith(0, '127.0.0.1', expect.any(Function));
    expect(servers).toHaveLength(1);
    expect(servers[0]?.listening).toBe(false);
  });
});
