// Worker side. Modes:
//   webgl-clear: WebGL2, clear to a changing colour each frame.
//   webgl-text:  WebGL2, 150 textured quads from a 2048x2048 atlas; each frame two new text
//                sprites are painted on an OffscreenCanvas 2D and uploaded with texSubImage2D.
//   2d-text:     2D context, 150 fillText calls per frame.
//   webgl-readback: as webgl-text, but each sprite goes through getImageData (CPU readback) first.
let mode, canvas, gl, ctx, prog, buf, tex, scratch;
const N = 150;
onmessage = (e) => {
  const m = e.data;
  if (m.t === 'init') {
    mode = m.mode; canvas = m.canvas;
    if (mode === '2d-text') ctx = canvas.getContext('2d');
    else {
      gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false });
      if (!gl) { postMessage({ t: 'error', reason: 'no WebGL2 in the Worker' }); return; }
      if (mode === 'webgl-text' || mode === 'webgl-readback') setup();
    }
    return;
  }
  draw(m.frame);
  postMessage({ t: 'drawn' });
};
function setup() {
  const vs = `#version 300 es
  in vec2 p; in vec2 uv; out vec2 v; void main(){ v = uv; gl_Position = vec4(p, 0., 1.); }`;
  const fs = `#version 300 es
  precision mediump float; in vec2 v; uniform sampler2D t; out vec4 o; void main(){ o = texture(t, v); }`;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog); gl.useProgram(prog);
  buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  const lp = gl.getAttribLocation(prog, 'p'), lu = gl.getAttribLocation(prog, 'uv');
  gl.enableVertexAttribArray(lp); gl.vertexAttribPointer(lp, 2, gl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(lu); gl.vertexAttribPointer(lu, 2, gl.FLOAT, false, 16, 8);
  tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 2048, 2048);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
}
function sprite(i) {
  const c = new OffscreenCanvas(256, 40);
  const x = c.getContext('2d');
  x.font = '28px sans-serif'; x.lineWidth = 4; x.strokeStyle = '#000'; x.fillStyle = '#fff';
  x.strokeText('comment ' + i, 4, 30); x.fillText('comment ' + i, 4, 30);
  return c;
}
function draw(frame) {
  if (mode === 'webgl-clear') {
    gl.clearColor((frame % 60) / 60, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); return;
  }
  if (mode === '2d-text') {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = '28px sans-serif'; ctx.fillStyle = '#fff';
    for (let i = 0; i < N; i++) ctx.fillText('comment ' + i, (1280 - ((frame * 4 + i * 97) % 1536)), 30 + (i % 20) * 34);
    return;
  }
  for (let k = 0; k < 2; k++) {
    const slot = (frame * 2 + k) % 400;
    let src;
    if (mode === 'webgl-readback') {
      // One reused scratch canvas, as the danmaku Worker does: clear, draw, read back.
      scratch ??= new OffscreenCanvas(512, 64).getContext('2d');
      scratch.clearRect(0, 0, 256, 40);
      scratch.font = '28px sans-serif'; scratch.lineWidth = 4; scratch.strokeStyle = '#000'; scratch.fillStyle = '#fff';
      scratch.strokeText('comment ' + (frame * 2 + k), 4, 30); scratch.fillText('comment ' + (frame * 2 + k), 4, 30);
      src = scratch.getImageData(0, 0, 256, 40);
    } else src = sprite(frame * 2 + k);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, (slot % 8) * 256, Math.floor(slot / 8) * 40, gl.RGBA, gl.UNSIGNED_BYTE, src);
  }
  const d = new Float32Array(N * 6 * 4);
  for (let i = 0; i < N; i++) {
    const slot = (frame * 2 + i) % 400;
    const u0 = (slot % 8) * 256 / 2048, v0 = Math.floor(slot / 8) * 40 / 2048, u1 = u0 + 256 / 2048, v1 = v0 + 40 / 2048;
    const x0 = (1280 - ((frame * 4 + i * 97) % 1536)) / 640 - 1, y0 = 1 - ((i % 20) * 34) / 360, x1 = x0 + 0.4, y1 = y0 - 0.11;
    const q = [x0, y0, u0, v0, x1, y0, u1, v0, x0, y1, u0, v1, x1, y0, u1, v0, x1, y1, u1, v1, x0, y1, u0, v1];
    d.set(q, i * 24);
  }
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.bufferData(gl.ARRAY_BUFFER, d, gl.DYNAMIC_DRAW);
  gl.drawArrays(gl.TRIANGLES, 0, N * 6);
}
