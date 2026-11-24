/* AI-Paulie: the one script this site serves.
 *
 * Every page is complete without it. It does one thing: where a page carries a 3D model, it
 * draws that model on a canvas, turns it slowly, and lets the visitor turn it by hand.
 *
 * It asks the network for nothing and builds no element; the build refuses this file if it ever
 * names a way to do either (aipaulie/render.py, JS_BANNED). A model is bytes in a data attribute
 * of the page it is on, never something this file goes to get.
 *
 * Self-test: node static/assets/js/site.js
 */
(function () {
'use strict';

/* ---- the model viewer's pure parts (aipaulie/mesh.py packs the bytes and keeps the same maths) ---- */

var CGA = { 'black': [0, 0, 0], 'blue': [0, 0, 170], 'green': [0, 170, 0], 'cyan': [0, 170, 170], 'red': [170, 0, 0],
  'magenta': [170, 0, 170], 'brown': [170, 85, 0], 'light-gray': [170, 170, 170], 'dark-gray': [85, 85, 85],
  'light-blue': [85, 85, 255], 'light-green': [85, 255, 85], 'light-cyan': [85, 255, 255], 'light-red': [255, 85, 85],
  'light-magenta': [255, 85, 255], 'yellow': [255, 255, 85], 'white': [255, 255, 255] };
var RAMPS = { amber: ['brown', 'yellow'], green: ['green', 'light-green'], cyan: ['cyan', 'light-cyan'],
  red: ['red', 'light-red'], magenta: ['magenta', 'light-magenta'], gray: ['dark-gray', 'light-gray'],
  blue: ['blue', 'light-blue'] };
var BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
var LIGHT = [-0.42, 0.62, -0.66], CAMERA = 3.4, REST_YAW = -0.5, REST_PITCH = 1.05, REST_ZOOM = 1.15;
var TURN = 0.3;                  // radians a second: the slow turn of a model nobody is holding

function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
// A new tilt: never flat on, never from underneath.
function tilt(pitch, by) { return clamp(pitch + by, 0.12, 1.5); }
// 'green gray' -> one [dark, bright, white] ramp a part. Unknown names are dropped.
function rampsFrom(names) {
  var out = String(names || '').split(/\s+/).filter(function (n) { return Object.prototype.hasOwnProperty.call(RAMPS, n); })
    .map(function (n) { return [CGA[RAMPS[n][0]], CGA[RAMPS[n][1]], CGA.white]; });
  return out.length ? out : [[CGA['dark-gray'], CGA['light-gray'], CGA.white]];
}
// The page's model bytes (base64) -> typed arrays, or null when they are not a model.
function unpack(b64) {
  var raw;
  try { raw = atob(String(b64 || '')); } catch (e) { return null; }
  if (raw.length < 12 || raw.slice(0, 4) !== 'APM1') return null;
  var u16 = function (at) { return raw.charCodeAt(at) | (raw.charCodeAt(at + 1) << 8); };
  var nv = u16(4), nt = u16(6), vsplit = u16(8), tsplit = u16(10);
  if (!nv || !nt || raw.length !== 12 + 6 * nv + 6 * nt || vsplit > nv || tsplit > nt) return null;
  var v = new Float32Array(3 * nv), t = new Uint16Array(3 * nt), i, n;
  for (i = 0; i < 3 * nv; i++) { n = u16(12 + 2 * i); v[i] = (n > 32767 ? n - 65536 : n) / 32767; }
  for (i = 0; i < 3 * nt; i++) { n = u16(12 + 6 * nv + 2 * i); if (n >= nv) return null; t[i] = n; }
  return { v: v, t: t, nv: nv, nt: nt, vsplit: vsplit, tsplit: tsplit };
}
function newFrame(w, h, nv) {
  return { w: w, h: h, tone: new Float32Array(w * h), depth: new Float32Array(w * h), n: new Float32Array(3 * w * h),
    p: new Float32Array(5 * nv) };
}
// Z-buffered flat shading. view: yaw, pitch, zoom, lift (how far the second part is raised).
// frame.tone ends up -1 where nothing is, else part number + light (0 to just under 1);
// frame.n holds the unit normal of the face each pixel shows.
function render(mesh, view, frame) {
  var w = frame.w, h = frame.h, tone = frame.tone, depth = frame.depth, N = frame.n, P = frame.p, v = mesh.v, t = mesh.t;
  var cy = Math.cos(view.yaw), sy = Math.sin(view.yaw), cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
  var scale = view.zoom * CAMERA * 0.98 * Math.min(w, h) / 2, i, f;
  tone.fill(-1); depth.fill(1e9);
  for (i = 0; i < mesh.nv; i++) {
    var mx = v[3 * i], my = v[3 * i + 1], mz = v[3 * i + 2] + (i >= mesh.vsplit ? view.lift : 0);
    var x = mx * cy - my * sy, y = mx * sy + my * cy, up = mz * cp + y * sp, d = y * cp - mz * sp, k = scale / (CAMERA + d);
    P[5 * i] = x; P[5 * i + 1] = up; P[5 * i + 2] = d; P[5 * i + 3] = w / 2 + x * k; P[5 * i + 4] = h / 2 - up * k;
  }
  for (f = 0; f < mesh.nt; f++) {
    var a = 5 * t[3 * f], b = 5 * t[3 * f + 1], c = 5 * t[3 * f + 2];
    var x0 = P[a + 3], y0 = P[a + 4], x1 = P[b + 3], y1 = P[b + 4], x2 = P[c + 3], y2 = P[c + 4];
    var area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (area >= 0) continue;                              // facing away (the screen's y runs down)
    var ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    var wx = P[c] - P[a], wy = P[c + 1] - P[a + 1], wz = P[c + 2] - P[a + 2];
    var nx = uz * wy - uy * wz, ny = ux * wz - uz * wx, nz = uy * wx - ux * wy;   // w x u: out of the face, towards the camera
    var len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= len; ny /= len; nz /= len;
    var light = nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2];
    var val = (f >= mesh.tsplit ? 1 : 0) + clamp(light, 0, 0.999);
    var z0 = P[a + 2], z1 = P[b + 2], z2 = P[c + 2];
    var px0 = Math.max(0, Math.floor(Math.min(x0, x1, x2))), px1 = Math.min(w - 1, Math.floor(Math.max(x0, x1, x2)));
    var py0 = Math.max(0, Math.floor(Math.min(y0, y1, y2))), py1 = Math.min(h - 1, Math.floor(Math.max(y0, y1, y2)));
    for (var py = py0; py <= py1; py++) {
      var sy2 = py + 0.5;
      for (var px = px0; px <= px1; px++) {
        var sx = px + 0.5;
        var w0 = ((x1 - sx) * (y2 - sy2) - (x2 - sx) * (y1 - sy2)) / area;
        var w1 = ((x2 - sx) * (y0 - sy2) - (x0 - sx) * (y2 - sy2)) / area;
        var w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        var z = w0 * z0 + w1 * z1 + w2 * z2, at = py * w + px;
        if (z < depth[at]) { depth[at] = z; tone[at] = val; N[3 * at] = nx; N[3 * at + 1] = ny; N[3 * at + 2] = nz; }
      }
    }
  }
}
// tone -> RGBA, dithered between a part's dark and bright colour, with white where light is square on.
// Lines are drawn in black where a pixel sits behind a nearer surface, where the surface folds
// (a crease), and where one part meets the other: they are what make an engraving readable.
function paint(frame, ramps, out) {
  var w = frame.w, h = frame.h, tone = frame.tone, depth = frame.depth, N = frame.n, x, y, at, o, col;
  var STEP = 0.03, FOLD = 0.72;
  function behind(to) { return tone[to] >= 0 && depth[to] < depth[at] - STEP; }
  function folds(to) {
    if (tone[to] < 0 || Math.abs(depth[to] - depth[at]) > STEP) return false;
    if (Math.floor(tone[to]) !== Math.floor(tone[at])) return true;
    return N[3 * at] * N[3 * to] + N[3 * at + 1] * N[3 * to + 1] + N[3 * at + 2] * N[3 * to + 2] < FOLD;
  }
  for (y = 0; y < h; y++) {
    for (x = 0; x < w; x++) {
      at = y * w + x; o = 4 * at;
      var val = tone[at];
      if (val < 0) col = CGA.black;
      else if ((x + 1 < w && (behind(at + 1) || folds(at + 1))) || (y + 1 < h && (behind(at + w) || folds(at + w))) ||
               (x > 0 && behind(at - 1)) || (y > 0 && behind(at - w))) col = CGA.black;
      else {
        var part = Math.floor(val), ramp = ramps[part % ramps.length], lit = 0.1 + 0.9 * (val - part);
        var pos = lit < 0.84 ? lit / 0.84 : 1 + (lit - 0.84) / 0.16 * 0.5, idx = Math.floor(pos);
        if (pos - idx > (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16) idx++;
        col = ramp[Math.min(idx, 2)];
      }
      out[o] = col[0]; out[o + 1] = col[1]; out[o + 2] = col[2]; out[o + 3] = 255;
    }
  }
}

if (typeof document === 'undefined') {
  var fails = 0;
  var eq = function (name, got, want) {
    if (JSON.stringify(got) !== JSON.stringify(want)) { fails++; console.log('FAIL ' + name + ': ' + JSON.stringify(got)); }
  };
  // one triangle and its mirror image, packed the way aipaulie/mesh.py packs them
  var packOf = function (verts, tris, vsplit, tsplit) {
    var bytes = [65, 80, 77, 49], put = function (n) { n = n < 0 ? n + 65536 : n; bytes.push(n & 255, n >> 8); };
    [verts.length / 3, tris.length / 3, vsplit, tsplit].forEach(put);
    verts.forEach(function (x) { put(Math.round(x * 32767)); }); tris.forEach(put);
    return btoa(String.fromCharCode.apply(null, bytes));
  };
  var flat = [-0.8, 0, -0.6, 0.8, 0, -0.6, 0, 0, 0.8];              // stands up in the xz plane
  var front = unpack(packOf(flat, [0, 1, 2], 3, 1)), back = unpack(packOf(flat, [0, 2, 1], 3, 1));
  var side = { yaw: 0, pitch: 0, zoom: 1, lift: 0 }, fr = newFrame(16, 16, 6), mid = 8 * 16 + 8;
  eq('a model unpacks', [front.nv, front.nt, front.vsplit, front.tsplit, Math.round(front.v[8] * 10)], [3, 1, 3, 1, 8]);
  eq('junk does not', [unpack(''), unpack('!!'), unpack(btoa('APM1')), unpack(packOf(flat, [0, 1, 7], 3, 1))], [null, null, null, null]);
  render(front, side, fr);
  eq('a face towards the camera is drawn', [fr.tone[mid] >= 0, fr.tone[0]], [true, -1]);
  render(back, side, fr);
  eq('a face turned away is not', fr.tone[mid], -1);
  var two = unpack(packOf(flat.concat([-0.8, -0.5, -0.6, 0.8, -0.5, -0.6, 0, -0.5, 0.8]), [0, 1, 2, 3, 4, 5], 3, 1));
  render(two, side, fr);
  eq('the nearer part wins the pixel', Math.floor(fr.tone[mid]), 1);
  eq('a face square to the camera catches the light', fr.tone[mid] - 1 > 0.6, true);
  var lifted = newFrame(16, 16, 6);
  render(two, { yaw: 0, pitch: 0, zoom: 1, lift: 5 }, lifted);
  eq('a lifted lid uncovers the base', Math.floor(lifted.tone[mid]), 0);
  var rgba = new Uint8Array(16 * 16 * 4);
  paint(fr, rampsFrom('green amber'), rgba);
  eq('empty is black and opaque', [rgba[0], rgba[1], rgba[2], rgba[3]], [0, 0, 0, 255]);
  eq('a pixel takes its own part\'s colours', [[170, 85, 0], [255, 255, 85], [255, 255, 255]].some(function (c) {
    return c[0] === rgba[4 * mid] && c[1] === rgba[4 * mid + 1] && c[2] === rgba[4 * mid + 2]; }), true);
  var fold = newFrame(4, 1, 1);
  fold.tone.set([0.5, 0.5, 0.5, -1]); fold.depth.set([1, 1, 1, 1e9]); fold.n.set([0, 0, -1, 0, 0, -1, 1, 0, 0, 0, 0, 0]);
  var line = new Uint8Array(16);
  paint(fold, rampsFrom('green'), line);
  eq('a crease is a black line, a flat run is not', [line[0] + line[1] + line[2] > 0, line[4] + line[5] + line[6], line[8] + line[9] + line[10] > 0], [true, 0, true]);
  eq('ramps', [rampsFrom('green nope').length, rampsFrom('').length, rampsFrom('amber')[0][0]], [1, 1, [170, 85, 0]]);
  eq('clamp', [clamp(5, 0, 1), clamp(-5, 0, 1), clamp(0.5, 0, 1)], [1, 0, 0.5]);
  eq('a tilt stops at its limits', [tilt(1, 5), tilt(1, -5), tilt(0.5, 0.25)], [1.5, 0.12, 0.75]);
  console.log(fails ? fails + ' failed' : 'site.js: 13 checks ok');
  if (typeof process !== 'undefined') process.exit(fails ? 1 : 0);
  return;
}

/* ---- the page ----------------------------------------------------------- */

function reducedMotion() { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } }

// The model viewer: draws the page's own model on its canvas and lets the visitor turn it.
// The page already shows a still picture of the model; this hides that and shows the canvas.
function viewer(canvas, stagePage) {
  var mesh = unpack(canvas.getAttribute('data-mesh'));
  var ctx = mesh && canvas.getContext ? canvas.getContext('2d') : null;
  if (!ctx) return;
  var stage = canvas.parentNode, w = canvas.width, h = canvas.height;
  var frame = newFrame(w, h, mesh.nv), image = ctx.createImageData(w, h), ramps = rampsFrom(canvas.getAttribute('data-ramp'));
  var view = { yaw: REST_YAW, pitch: REST_PITCH, zoom: REST_ZOOM, lift: 0 };
  var liftTo = 0, spin = !reducedMotion(), drag = null, dirty = true, last = 0, seen = true;
  var all = function (sel, fn) { Array.prototype.forEach.call(document.querySelectorAll(sel), fn); };
  function labels() {
    if (!stagePage) return;
    all('[data-spin]', function (el) { el.textContent = spin ? 'on' : 'off'; });
    all('[data-lid]', function (el) { el.textContent = liftTo > 0 ? 'off' : 'on'; });
  }
  function turn(dyaw, dpitch) { view.yaw += dyaw; view.pitch = tilt(view.pitch, dpitch); dirty = true; }
  function act(what) {
    if (what === 'spin') spin = !spin;
    else if (what === 'lid') liftTo = liftTo > 0 ? 0 : 0.55;
    else if (what === 'in') view.zoom = clamp(view.zoom * 1.25, 0.64, 3.05);
    else if (what === 'out') view.zoom = clamp(view.zoom / 1.25, 0.64, 3.05);
    dirty = true; labels();
  }
  function tick(now) {
    var dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (seen) {
      if (spin && !drag) { view.yaw += dt * TURN; dirty = true; }
      if (view.lift !== liftTo) {
        var gap = liftTo - view.lift, go = (reducedMotion() ? 99 : dt * 1.6) * (gap > 0 ? 1 : -1);
        view.lift = Math.abs(go) >= Math.abs(gap) ? liftTo : view.lift + go; dirty = true;
      }
      if (dirty) { dirty = false; render(mesh, view, frame); paint(frame, ramps, image.data); ctx.putImageData(image, 0, 0); }
    }
    window.requestAnimationFrame(tick);
  }
  canvas.addEventListener('pointerdown', function (e) {
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY }; spin = false; labels();
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
  });
  canvas.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    var k = 4.2 / (canvas.clientWidth || w);
    turn((e.clientX - drag.x) * k, (e.clientY - drag.y) * k);
    drag.x = e.clientX; drag.y = e.clientY;
  });
  var drop = function (e) { if (drag && e.pointerId === drag.id) drag = null; };
  canvas.addEventListener('pointerup', drop); canvas.addEventListener('pointercancel', drop);
  // Left and right turn it from anywhere on a model's own page; everywhere else the arrow keys
  // belong to the canvas only while it has focus, because up and down scroll the page.
  document.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var focused = document.activeElement === canvas, k = e.key;
    if ((stagePage || focused) && (k === 'ArrowLeft' || k === 'ArrowRight')) { spin = false; labels(); turn(k === 'ArrowLeft' ? -0.14 : 0.14, 0); e.preventDefault(); }
    else if (focused && (k === 'ArrowUp' || k === 'ArrowDown')) { turn(0, k === 'ArrowUp' ? -0.1 : 0.1); e.preventDefault(); }
  });
  if (stagePage) {
    all('[data-view]', function (el) {
      el.addEventListener('click', function (e) { e.preventDefault(); act(el.getAttribute('data-view')); });
    });
    if (mesh.vsplit >= mesh.nv) all('[data-view="lid"]', function (el) { el.hidden = true; });
    all('[data-view-ui]', function (el) { el.removeAttribute('hidden'); });
    labels();
  }
  // A model that is off the screen is not drawn.
  if (typeof window.IntersectionObserver === 'function') {
    new window.IntersectionObserver(function (entries) {
      entries.forEach(function (en) { seen = en.isIntersecting; if (seen) dirty = true; });
    }).observe(canvas);
  }
  all('[data-still]', function (el) { if (el.parentNode === stage) el.hidden = true; });
  canvas.removeAttribute('hidden');
  window.requestAnimationFrame(tick);
}

function boot() {
  var found = document.querySelectorAll('canvas[data-mesh]');
  var stagePage = found.length === 1 && !!document.querySelector('[data-view-ui]');
  Array.prototype.forEach.call(found, function (c) { try { viewer(c, stagePage); } catch (e) {} });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
})();
