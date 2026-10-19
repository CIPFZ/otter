// media-captions 1.0.4 ships .d.ts files with extensionless relative re-exports, which NodeNext
// resolution drops (the module looks empty). Declared here: only what Otter calls, mirroring the
// upstream signatures (the same declaration as in @otter-player/text).

declare module 'media-captions' {
  export interface VTTCue {
    id: string;
    startTime: number;
    endTime: number;
    text: string;
  }
  export interface ParsedCaptionsResult {
    cues: VTTCue[];
    errors: unknown[];
  }
  export function parseText(text: string, options?: { type?: 'vtt' | 'srt' | 'ssa' | 'ass'; strict?: boolean; errors?: boolean }): Promise<ParsedCaptionsResult>;
}
