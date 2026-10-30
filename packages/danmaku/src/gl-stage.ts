// WebGL batch stage for danmaku (ADR-012 §4), shared by the main-thread WebGL renderer and the
// OffscreenCanvas Worker: comment pictures packed into one texture atlas (shelf rows, a row is
// reused once all its pictures are gone), every frame one buffer upload and one draw call.

const VERTEX = `#version 300 es
in vec2 a_pos;
in vec2 a_uv;
uniform vec2 u_size;
out vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = vec4(a_pos / u_size * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision mediump float;
uniform sampler2D u_atlas;
uniform sampler2D u_mask;
uniform int u_masked;
uniform highp vec2 u_size;
in vec2 v_uv;
out vec4 o;
void main() {
  o = texture(u_atlas, v_uv);
  // The mask covers the stage; its alpha is the subject: comments erased there.
  if (u_masked == 1) o *= 1.0 - texture(u_mask, vec2(gl_FragCoord.x / u_size.x, 1.0 - gl_FragCoord.y / u_size.y)).a;
}`;

interface Slot {
  readonly row: Row;
  readonly x: number;
  readonly w: number;
  readonly h: number;
  /** Size drawn on the stage (device px): the sprite's, also when it was scaled down to fit the atlas. */
  dw: number;
  dh: number;
}

interface Row {
  readonly y: number;
  readonly h: number;
  cursor: number;
  live: number;
}

/** A picture source the atlas can take (a canvas of either kind). */
export type SpriteSource = HTMLCanvasElement | OffscreenCanvas;

/** A mask picture for the stage (alpha = erase). */
export type MaskSourceImage = HTMLCanvasElement | OffscreenCanvas | ImageBitmap;

export interface GlStage {
  /** Device px. */
  resize(width: number, height: number): void;
  /** Packs `sprite` (device px) under `id`; false when the atlas is full (the comment is not drawn). */
  add(id: number, sprite: SpriteSource): boolean;
  /**
   * Rasterises `paint` into a `width` x `height` (device px) picture and packs it under `id`, like
   * `add`: painted on its own OffscreenCanvas and uploaded from it. No CPU readback
   * (getImageData): in a Worker that draws WebGL to a transferred canvas, Firefox stops the page's
   * rAF for ~10 s now and then when that Worker reads a 2D canvas back (M6 F4, RESEARCH §1).
   */
  paint(id: number, width: number, height: number, paint: (ctx: OffscreenCanvasRenderingContext2D) => void): boolean;
  remove(id: number): void;
  /** One frame: [id, x, y] triples in device px (ids not in the atlas are skipped). */
  draw(items: ArrayLike<number>, count: number): void;
  /** The mask for the next frames (uploaded once per call), or none. */
  setMask(mask: MaskSourceImage | null): void;
  readonly atlasSize: number;
  destroy(): void;
}

/** Row heights are rounded up to this, so similar comments share rows. */
const ROW_STEP = 8;

export function createGlStage(canvas: HTMLCanvasElement | OffscreenCanvas): GlStage | undefined {
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: false }) as WebGL2RenderingContext | null;
  if (gl === null) return undefined;
  const compile = (type: number, src: string): WebGLShader => {
    const s = gl.createShader(type) as WebGLShader;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };
  const program = gl.createProgram() as WebGLProgram;
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return undefined;
  gl.useProgram(program);
  const size = Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, size, size);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const pos = gl.getAttribLocation(program, 'a_pos');
  const uv = gl.getAttribLocation(program, 'a_uv');
  gl.enableVertexAttribArray(pos);
  gl.enableVertexAttribArray(uv);
  gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 16, 0);
  gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, 16, 8);
  const uSize = gl.getUniformLocation(program, 'u_size');
  gl.uniform1i(gl.getUniformLocation(program, 'u_atlas'), 0);
  gl.uniform1i(gl.getUniformLocation(program, 'u_mask'), 1);
  const uMasked = gl.getUniformLocation(program, 'u_masked');
  const maskTex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, maskTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.activeTexture(gl.TEXTURE0);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  const rows: Row[] = [];
  const slots = new Map<number, Slot>();
  let vertices = new Float32Array(6 * 4 * 256);

  const place = (w: number, h: number): Slot | undefined => {
    const rh = Math.ceil(h / ROW_STEP) * ROW_STEP;
    for (const row of rows) {
      if (row.h !== rh) continue;
      if (row.live === 0) row.cursor = 0;
      if (row.cursor + w <= size) {
        const slot = { row, x: row.cursor, w, h, dw: w, dh: h };
        row.cursor += w;
        row.live++;
        return slot;
      }
    }
    // A free row of another height can be taken over once empty.
    const top = rows.reduce((y, r) => Math.max(y, r.y + r.h), 0);
    let row = rows.find((r) => r.live === 0 && r.h >= rh && r.h < rh + ROW_STEP * 2);
    if (row === undefined) {
      if (top + rh > size || w > size) return undefined;
      row = { y: top, h: rh, cursor: 0, live: 0 };
      rows.push(row);
    }
    row.cursor = w;
    row.live = 1;
    return { row, x: 0, w, h, dw: w, dh: h };
  };

  const stage: GlStage = {
    atlasSize: size,
    resize(w, h) {
      canvas.width = Math.max(1, w);
      canvas.height = Math.max(1, h);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(uSize, canvas.width, canvas.height);
    },
    setMask(mask) {
      gl.uniform1i(uMasked, mask === null ? 0 : 1);
      if (mask === null) return;
      gl.activeTexture(gl.TEXTURE1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mask);
      gl.activeTexture(gl.TEXTURE0);
    },
    add(id, sprite) {
      // Wider than the atlas (a long comment on a high-density screen): kept at a lower
      // resolution, drawn at its full size.
      let source: SpriteSource = sprite;
      if (sprite.width > size) {
        const k = size / sprite.width;
        const small = new OffscreenCanvas(size, Math.max(1, Math.round(sprite.height * k)));
        (small.getContext('2d') as OffscreenCanvasRenderingContext2D).drawImage(sprite, 0, 0, small.width, small.height);
        source = small;
      }
      const slot = place(source.width, source.height);
      if (slot === undefined) return false;
      slot.dw = sprite.width;
      slot.dh = sprite.height;
      slots.set(id, slot);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, slot.x, slot.row.y, gl.RGBA, gl.UNSIGNED_BYTE, source);
      return true;
    },
    paint(id, width, height, paint) {
      const c = new OffscreenCanvas(width, height);
      paint(c.getContext('2d') as OffscreenCanvasRenderingContext2D);
      return stage.add(id, c);
    },
    remove(id) {
      const slot = slots.get(id);
      if (slot === undefined) return;
      slots.delete(id);
      slot.row.live--;
    },
    draw(items, count) {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (vertices.length < count * 24) vertices = new Float32Array(Math.ceil(count * 1.5) * 24);
      let n = 0;
      for (let i = 0; i < count; i++) {
        const slot = slots.get(items[i * 3] as number);
        if (slot === undefined) continue;
        const x0 = items[i * 3 + 1] as number;
        const y0 = items[i * 3 + 2] as number;
        const x1 = x0 + slot.dw;
        const y1 = y0 + slot.dh;
        const u0 = slot.x / size;
        const v0 = slot.row.y / size;
        const u1 = (slot.x + slot.w) / size;
        const v1 = (slot.row.y + slot.h) / size;
        vertices.set([x0, y0, u0, v0, x1, y0, u1, v0, x0, y1, u0, v1, x0, y1, u0, v1, x1, y0, u1, v0, x1, y1, u1, v1], n * 24);
        n++;
      }
      if (n === 0) return;
      gl.bufferData(gl.ARRAY_BUFFER, vertices.subarray(0, n * 24), gl.STREAM_DRAW);
      gl.drawArrays(gl.TRIANGLES, 0, n * 6);
    },
    destroy() {
      slots.clear();
      gl.deleteTexture(tex);
      gl.deleteTexture(maskTex);
      gl.deleteBuffer(buf);
      gl.deleteProgram(program);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
  return stage;
}
