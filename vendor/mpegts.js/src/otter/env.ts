// Otter: the few host APIs the vendored code needs, read through globalThis so the package compiles
// without DOM types and runs in Workers and Node (ADR-007 §2: the pipeline is DOM-free).

interface Env {
  navigator?: { userAgent?: string; vendor?: string };
  TextDecoder?: new (label?: string) => { decode(data: Uint8Array): string };
  atob?: (data: string) => string;
}
const env = globalThis as unknown as Env;

export const userAgent = (): string => env.navigator?.userAgent ?? '';
export const navigatorVendor = (): string => env.navigator?.vendor ?? '';

let decoder: { decode(data: Uint8Array): string } | undefined;
export function utf8Decode(data: Uint8Array): string {
  if (decoder === undefined) {
    const Ctor = env.TextDecoder;
    if (Ctor === undefined) throw new Error('TextDecoder is not available');
    decoder = new Ctor('utf-8');
  }
  return decoder.decode(data);
}

export function base64ToBinary(data: string): string {
  if (env.atob === undefined) throw new Error('atob is not available');
  return env.atob(data);
}
