// media-captions 1.0.4 ships .d.ts files with extensionless relative re-exports, which NodeNext
// resolution drops (the module looks empty), and imscJS ships none. Declared here: only what
// Otter calls, mirroring the upstream signatures.

declare module 'media-captions' {
  export interface VTTRegion {
    id: string;
    width: number;
    lines: number;
    regionAnchorX: number;
    regionAnchorY: number;
    viewportAnchorX: number;
    viewportAnchorY: number;
    scroll: '' | 'up';
  }
  export interface VTTCue {
    id: string;
    startTime: number;
    endTime: number;
    text: string;
    region: VTTRegion | null;
    vertical: '' | 'rl' | 'lr';
    snapToLines: boolean;
    line: number | 'auto';
    lineAlign: 'start' | 'center' | 'end';
    position: number | 'auto';
    positionAlign: 'line-left' | 'center' | 'line-right' | 'auto';
    size: number;
    align: 'start' | 'center' | 'end' | 'left' | 'right';
  }
  interface VTTBlock {
    tagName: string;
    class?: string;
    color?: string;
    bgColor?: string;
    children: VTTNode[];
  }
  export type VTTNode =
    | { type: 'text'; data: string }
    | (VTTBlock & { type: 'c' | 'i' | 'b' | 'u' | 'ruby' | 'rt' })
    | (VTTBlock & { type: 'v'; voice: string })
    | (VTTBlock & { type: 'lang'; lang: string })
    | (VTTBlock & { type: 'timestamp'; time: number });
  export interface ParsedCaptionsResult {
    cues: VTTCue[];
    regions: VTTRegion[];
    errors: unknown[];
  }
  export function parseText(text: string, options?: { type?: 'vtt' | 'srt' | 'ssa' | 'ass'; strict?: boolean; errors?: boolean }): Promise<ParsedCaptionsResult>;
  export function tokenizeVTTCue(cue: VTTCue): VTTNode[];
}

declare module 'imsc' {
  const imsc: unknown;
  export default imsc;
}
