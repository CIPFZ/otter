// Derived from hls.js@b023c2908c53b8cbe25665de4df9713cd3bbfdbf src/utils/user-agent.ts, Apache-2.0
import { navigatorVendor, userAgent } from '../otter/env.js';
// Otter: read lazily (no navigator access at module load: top-level side effect, Workers).
let uaCache: string | undefined;
let vendorCache: string | undefined;
const uaString = (): string => (uaCache ??= getNavigator('userAgent'));
const vendorString = (): string => (vendorCache ??= getNavigator('vendor'));

let chromeVersion: number | undefined;
let firefoxVersion: number | undefined;
let safariVersion: number | undefined;

// Otter: navigator through otter/env (DOM-free).
function getNavigator(field: 'userAgent' | 'vendor'): string {
  return field === 'userAgent' ? userAgent() : navigatorVendor();
}

export function userAgentSafariVersion(): number {
  if (safariVersion === undefined) {
    const result = uaString().match(/Safari\/(\d+)/i);
    safariVersion = result ? parseInt(result[1]!) : 0;
  }
  return safariVersion;
}

export function userAgentChromeVersion(): number {
  if (chromeVersion === undefined) {
    const result = uaString().match(/Chrome\/(\d+)/i);
    chromeVersion = result ? parseInt(result[1]!) : 0;
  }
  return chromeVersion;
}

export function userAgentFirefoxVersion(): number {
  if (firefoxVersion === undefined) {
    const result = uaString().match(/Firefox\/(\d+)/i);
    firefoxVersion = result ? parseInt(result[1]!) : 0;
  }
  return firefoxVersion;
}

export function userAgentHevcSupportIsInaccurate(): boolean {
  return /\(Windows.+Firefox\//i.test(uaString());
}

export function userAgentIsIOSLike(): boolean {
  return vendorString().indexOf('Apple') > -1 || /iPhone|iPad|iPod/.test(uaString());
}

export function userAgentIsAndroidLike(): boolean {
  return /Android/.test(uaString());
}
