// After a run: the local WHEP endpoint has no session still sending (M6, 2026-11-02: sessions of
// pages that closed without a DELETE used to keep sending for the rest of the preview server's
// life, a load on the machine through the whole step). Sessions end with DELETE, on the DTLS /
// connection closing, or after 30 s without RTCP (e2e/whep.ts): allow that long to drain.
import type { FullConfig } from '@playwright/test';

export default async function teardown(config: FullConfig): Promise<void> {
  const base = config.projects[0]?.use.baseURL;
  if (base === undefined) return;
  const url = new URL('/whep/sessions', base).href;
  const count = async (): Promise<number | undefined> => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      return res.ok ? Number(await res.text()) : undefined;
    } catch {
      return undefined;
    }
  };
  // No server (a remote base URL, or it is already down): nothing to check.
  let n = await count();
  if (n === undefined) return;
  const until = Date.now() + 35_000;
  while (n !== undefined && n > 0 && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 1000));
    n = await count();
  }
  if (n !== undefined && n > 0) throw new Error(`${n} WHEP session(s) still sending 35 s after the run (e2e/whep.ts): a page left one open`);
}
