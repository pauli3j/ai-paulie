/* AI-Paulie: the one script this site serves.
 *
 * Every page is complete without it. It adds four things: the dial-in reveal (the page paints
 * at modem speed, once a visit), hotkeys for the links already on the page, the speed picker,
 * and the model viewer (a 3D model already in the page, drawn on a canvas you can turn).
 *
 * It asks the network for nothing and builds no element except the reveal's cursor; the build
 * refuses this file if it ever names a way to do either (aipaulie/render.py, JS_BANNED). A model
 * is bytes in a data attribute of the page it is on, never something this file goes to get.
 *
 * The reveal is 1337's modem utility, by way of knockknock's port of it.
 * Self-test: node static/assets/js/site.js
 */
(function () {
'use strict';

var SPEEDS = [2400, 9600, 28800, 0];
var DEFAULT = 28800, RUN_COST = 4;

/* ---- pure parts (self-tested under node) -------------------------------- */

function speedLabel(b) { return b > 0 ? String(b) : 'DIRECT'; }
function nextSpeed(b) { return SPEEDS[(SPEEDS.indexOf(b) + 1) % SPEEDS.length]; }
// ?baud=N in a query string, else the fallback. 0 means DIRECT.
function baudFrom(search, fallback) {
  var m = /[?&]baud=(\d{1,6})(?:&|$)/.exec(String(search || ''));
  return m ? parseInt(m[1], 10) : fallback;
}
// What a stored speed means: one of SPEEDS, or null.
function pickedFrom(stored) {
  var n = parseInt(stored, 10);
  return SPEEDS.indexOf(n) >= 0 ? n : null;
}
// The speed this page paints at. picked: the visitor's own choice this visit, or null.
// seen: a page has already painted this visit.
function planReveal(search, picked, seen, reduced) {
  if (reduced) return 0;
  var q = baudFrom(search, null);
  if (q != null) return q;
  if (picked != null) return picked;
  return seen ? 0 : DEFAULT;
}
// The key a keydown means, or null when it is not ours to take.
function keyOf(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  var k = String(e.key || '');
  return k.length === 1 ? k.toLowerCase() : null;
}
// What `budget` bytes buy of one run: a run costs `cost` before its first character.
function buy(budget, cost, left, fresh) {
  if (fresh) {
    if (budget < cost + 1) return { take: 0, budget: budget, wait: true };
    budget -= cost;
  }
  var take = Math.min(Math.floor(budget), left);
  return { take: take, budget: budget - take, wait: false };
}
// Where the selection bar goes next: wraps at both ends, starts at the top (or bottom).
function step(count, at, dir) {
  if (count < 1) return -1;
  if (at < 0) return dir > 0 ? 0 : count - 1;
  return (at + dir + count) % count;
}

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

function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
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
  eq('label', [speedLabel(28800), speedLabel(0)], ['28800', 'DIRECT']);
  eq('cycle', [nextSpeed(2400), nextSpeed(9600), nextSpeed(28800), nextSpeed(0), nextSpeed(7)], [9600, 28800, 0, 2400, 2400]);
  eq('baud', [baudFrom('?baud=2400', 1), baudFrom('?x=1&baud=0', 1), baudFrom('', 1), baudFrom('?baud=-5', 1), baudFrom('?baud=fast', null)], [2400, 0, 1, 1, null]);
  eq('picked', [pickedFrom('9600'), pickedFrom('0'), pickedFrom('123'), pickedFrom(null), pickedFrom('x')], [9600, 0, null, null, null]);
  eq('first page of a visit paints', planReveal('', null, false, false), 28800);
  eq('later pages do not', planReveal('', null, true, false), 0);
  eq('a picked speed paints every page', planReveal('', 2400, true, false), 2400);
  eq('DIRECT stays direct', planReveal('', 0, false, false), 0);
  eq('the query wins', planReveal('?baud=9600', 0, true, false), 9600);
  eq('reduced motion never paints', [planReveal('?baud=9600', 2400, false, true)], [0]);
  eq('keys', [keyOf({ key: 'A' }), keyOf({ key: '1' }), keyOf({ key: 'Enter' }), keyOf({ key: 'a', ctrlKey: true }), keyOf({})], ['a', '1', null, null, null]);
  eq('a run waits for its cost', buy(4, 4, 10, true), { take: 0, budget: 4, wait: true });
  eq('then pays it once', buy(10, 4, 10, true), { take: 6, budget: 0, wait: false });
  eq('and not again', buy(5.5, 4, 2, false), { take: 2, budget: 3.5, wait: false });
  eq('bar', [step(3, -1, 1), step(3, -1, -1), step(3, 2, 1), step(3, 0, -1), step(0, -1, 1)], [0, 2, 0, 2, -1]);

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
  console.log(fails ? fails + ' failed' : 'site.js: 27 checks ok');
  if (typeof process !== 'undefined') process.exit(fails ? 1 : 0);
  return;
}

/* ---- the page ----------------------------------------------------------- */

var html = document.documentElement, started = false, running = null;

function reducedMotion() { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } }
function recall(key) { try { return window.sessionStorage.getItem(key); } catch (e) { return null; } }
function remember(key, value) { try { window.sessionStorage.setItem(key, value); } catch (e) {} }
function show() { html.removeAttribute('data-modem'); }

var picked = pickedFrom(recall('ap-baud'));
var baud = planReveal(window.location.search, picked, recall('ap-seen') === '1', reducedMotion());
remember('ap-seen', '1');
if (baud > 0) {
  // Hide the screen before it paints, so the reveal does not start with a flash of the whole
  // page. If the reveal has not begun in three seconds, show the page as it is.
  html.setAttribute('data-modem', '');
  window.setTimeout(function () { if (!started) show(); }, 3000);
}

// Modem reveal: paints the text under `root` at baud / 10 characters a second (8N1), charging
// RUN_COST bytes per colour change. Any key or tap finishes it.
function modem(root, speed, done) {
  var doc = root.ownerDocument, revealing = false, nodes = [];
  var ctl = { finish: finish };
  if (!(speed > 0) || reducedMotion()) { show(); if (done) done(); return ctl; }
  function visible(el) {
    var viaSummary = false;
    for (; el && el !== doc.body; el = el.parentNode) {
      if (el.nodeType !== 1) continue;
      if (el.tagName === 'SUMMARY') viaSummary = true;
      if (el.tagName === 'DETAILS' && !el.open && !viaSummary) return false;
      if (window.getComputedStyle(el).display === 'none') return false;
    }
    return true;
  }
  var walker = doc.createTreeWalker(root, 5 /* elements and text */, null), n;
  while ((n = walker.nextNode())) {
    if (n.nodeType === 1) {
      // the prompt's block cursor is a sized box that shows even when empty, so it waits its turn
      if (n.classList.contains('lt-cursor') && visible(n)) { n.classList.add('ap-wait'); nodes.push({ el: n, text: '' }); }
      continue;
    }
    // the line breaks between tags in the page source are not on the screen
    if (!n.nodeValue.length || (!/\S/.test(n.nodeValue) && n.nodeValue.indexOf('\n') >= 0) || !visible(n.parentNode)) continue;
    nodes.push({ node: n, text: n.nodeValue });
    n.nodeValue = '';
  }
  revealing = true;
  show();
  var cps = speed / 10, cursor = doc.createElement('span');
  cursor.className = 'lt-cursor';
  var i = 0, pos = 0, budget = 0, last = window.performance.now();
  function finish() {
    if (!revealing) return;
    revealing = false;
    nodes.forEach(function (r) { if (r.el) r.el.classList.remove('ap-wait'); else r.node.nodeValue = r.text; });
    if (cursor.parentNode) cursor.parentNode.removeChild(cursor);
    doc.removeEventListener('keydown', skip, true); doc.removeEventListener('pointerdown', skip, true);
    if (done) done();
  }
  function skip(e) {
    if (!revealing) return;
    if (e.type === 'keydown' && (e.metaKey || e.ctrlKey || e.altKey)) return;
    e.preventDefault(); e.stopImmediatePropagation(); finish();
  }
  function frame(now) {
    if (!revealing) return;
    budget += (now - last) / 1000 * cps; last = now;
    while (budget >= 1 && i < nodes.length) {
      var r = nodes[i];
      if (r.el) {
        if (budget < RUN_COST + 1) break;
        budget -= RUN_COST; r.el.classList.remove('ap-wait'); i++; continue;
      }
      var got = buy(budget, RUN_COST, r.text.length - pos, pos === 0);
      if (got.wait) break;
      budget = got.budget;
      r.node.nodeValue += r.text.substr(pos, got.take);
      pos += got.take;
      if (r.node.parentNode) r.node.parentNode.insertBefore(cursor, r.node.nextSibling);
      if (pos >= r.text.length) { i++; pos = 0; }
    }
    if (i >= nodes.length) return finish();
    window.requestAnimationFrame(frame);
  }
  doc.addEventListener('keydown', skip, true); doc.addEventListener('pointerdown', skip, true);
  window.requestAnimationFrame(frame);
  return ctl;
}

// The model viewer: draws the page's own model on its canvas and lets the visitor turn it.
// The page already shows a still picture of the model; this hides that and shows the canvas.
function viewer(canvas) {
  var mesh = unpack(canvas.getAttribute('data-mesh'));
  var ctx = mesh && canvas.getContext ? canvas.getContext('2d') : null;
  if (!ctx) return;
  var stage = canvas.parentNode, w = canvas.width, h = canvas.height;
  var frame = newFrame(w, h, mesh.nv), image = ctx.createImageData(w, h), ramps = rampsFrom(canvas.getAttribute('data-ramp'));
  var view = { yaw: REST_YAW, pitch: REST_PITCH, zoom: REST_ZOOM, lift: 0 };
  var liftTo = 0, spin = !reducedMotion(), drag = null, dirty = true, last = 0;
  var all = function (sel, fn) { Array.prototype.forEach.call(document.querySelectorAll(sel), fn); };
  var solo = document.querySelectorAll('canvas[data-mesh]').length === 1;
  function labels() {
    if (!solo) return;
    all('[data-spin]', function (el) { el.textContent = spin ? 'on' : 'off'; });
    all('[data-lid]', function (el) { el.textContent = liftTo > 0 ? 'off' : 'on'; });
  }
  function turn(dyaw, dpitch) {
    view.yaw += dyaw; view.pitch = clamp(view.pitch + dpitch, 0.12, 1.5); dirty = true;
  }
  function act(what) {
    if (what === 'spin') spin = !spin;
    else if (what === 'lid') liftTo = liftTo > 0 ? 0 : 0.55;
    else if (what === 'in') view.zoom = clamp(view.zoom * 1.25, 0.64, 3.05);
    else if (what === 'out') view.zoom = clamp(view.zoom / 1.25, 0.64, 3.05);
    dirty = true; labels();
  }
  function tick(now) {
    var dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (spin && !drag) { view.yaw += dt * 0.45; dirty = true; }
    if (view.lift !== liftTo) {
      var gap = liftTo - view.lift, go = (reducedMotion() ? 99 : dt * 1.6) * (gap > 0 ? 1 : -1);
      view.lift = Math.abs(go) >= Math.abs(gap) ? liftTo : view.lift + go; dirty = true;
    }
    if (dirty) { dirty = false; render(mesh, view, frame); paint(frame, ramps, image.data); ctx.putImageData(image, 0, 0); }
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
  // Left and right turn it from anywhere on a page with one model; up and down tilt it only
  // while the canvas has focus, because everywhere else they scroll.
  document.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var focused = document.activeElement === canvas, k = e.key;
    if ((solo || focused) && (k === 'ArrowLeft' || k === 'ArrowRight')) { spin = false; labels(); turn(k === 'ArrowLeft' ? -0.14 : 0.14, 0); e.preventDefault(); }
    else if (focused && (k === 'ArrowUp' || k === 'ArrowDown')) { turn(0, k === 'ArrowUp' ? -0.1 : 0.1); e.preventDefault(); }
  });
  if (solo) {
    all('[data-view]', function (el) {
      el.addEventListener('click', function (e) { e.preventDefault(); act(el.getAttribute('data-view')); });
    });
    if (mesh.vsplit >= mesh.nv) all('[data-view="lid"]', function (el) { el.hidden = true; });
    all('[data-view-ui]', function (el) { el.removeAttribute('hidden'); });
    labels();
  }
  all('[data-still]', function (el) { if (el.parentNode === stage) el.hidden = true; });
  canvas.removeAttribute('hidden');
  window.requestAnimationFrame(tick);
}

function boot() {
  var screen = document.querySelector('.lt-screen');
  if (!screen) { show(); return; }
  var each = function (sel, fn) { Array.prototype.forEach.call(screen.querySelectorAll(sel), fn); };
  var current = function () { return reducedMotion() ? 0 : (picked != null ? picked : DEFAULT); };
  function labels() {
    each('[data-speed]', function (el) { el.textContent = speedLabel(current()); });
    each('[data-connect]', function (el) { el.textContent = current() > 0 ? 'CONNECT ' + current() : 'DIRECT'; });
  }
  function paint(speed) {
    if (running) running.finish();
    running = modem(screen, speed, function () { running = null; });
  }
  function cycle() {
    picked = nextSpeed(current());
    remember('ap-baud', String(picked));
    labels();
    paint(picked);
  }
  function move(dir) {
    var links = Array.prototype.filter.call(screen.querySelectorAll('a[href]'), function (a) { return a.offsetParent !== null; });
    var to = step(links.length, links.indexOf(document.activeElement), dir);
    if (to >= 0) links[to].focus();
  }
  each('[data-js]', function (el) { el.removeAttribute('hidden'); });
  labels();
  each('[data-key="s"]', function (el) { el.addEventListener('click', function (e) { e.preventDefault(); cycle(); }); });
  document.addEventListener('keydown', function (e) {
    var key = keyOf(e);
    if (!key) return;
    if (key === 'j' || key === 'k') { e.preventDefault(); move(key === 'j' ? 1 : -1); return; }
    var link = screen.querySelector('a[data-key="' + key.replace(/[^a-z0-9]/g, '') + '"]');
    if (!link || link.offsetParent === null) return;
    e.preventDefault();
    each('[data-echo]', function (el) { el.textContent = key.toUpperCase(); });
    link.click();
  });
  // before the reveal starts, so it paints the page as the viewer leaves it
  Array.prototype.forEach.call(document.querySelectorAll('canvas[data-mesh]'), function (c) { try { viewer(c); } catch (e) {} });
  started = true;
  paint(baud);
}

function safely() { try { boot(); } catch (e) { started = true; show(); } }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', safely);
else safely();
})();
