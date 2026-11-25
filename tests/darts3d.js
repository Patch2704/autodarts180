// Realistische Pfeil-Szenen: Lochkamera seitlich/höher/tiefer, echte 3D-Pfeile (Spitze, Barrel,
// Schaft, X-förmiger Flight) mit Verdeckung, Schatten und Bildrauschen pro Frame.
// Misst, wie genau die Pfeilerkennung die Einstichstelle auf der Scheibe trifft.
import * as cal from '../js/vision/calibration.js';
import { renderScene } from './scene.js';
import { DartDetector, cropView, dartCrop } from '../js/vision/detector.js';
import { scoreAt, R } from '../js/core/board.js';
import { mulberry32, gaussian } from '../js/core/rng.js';

/** Lochkamera auf das Bull gerichtet; deg seitlich (+ = von rechts), tilt (+ = Kamera höher) */
export function sideCamera(deg, w, h, { dist = 650, fill = 0.8, tilt = 0, roll = 0 } = {}) {
  const t = (deg * Math.PI) / 180, tl = (tilt * Math.PI) / 180;
  const C = [Math.sin(t) * dist * Math.cos(tl), Math.sin(tl) * dist, Math.cos(t) * dist * Math.cos(tl)];
  const n = Math.hypot(...C);
  const fwd = C.map((v) => -v / n);
  const up = [0, 1, 0];
  let right = [fwd[1] * up[2] - fwd[2] * up[1], fwd[2] * up[0] - fwd[0] * up[2], fwd[0] * up[1] - fwd[1] * up[0]];
  const rn = Math.hypot(...right); right = right.map((v) => v / rn);
  let cup = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
  if (roll) {
    const r = (roll * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
    const r2 = right.map((v, i) => c * v + s * cup[i]); const u2 = cup.map((v, i) => -s * right[i] + c * v);
    right = r2; cup = u2;
  }
  const f = (fill * Math.min(w, h)) / (450 / dist);
  /** 3D-Punkt (mm, Scheibe in z=0, +z zum Werfer) → Pixel + Tiefe */
  const proj = (X, Y, Z = 0) => {
    const p = [X - C[0], Y - C[1], Z - C[2]];
    const xc = p[0] * right[0] + p[1] * right[1] + p[2] * right[2];
    const yc = p[0] * cup[0] + p[1] * cup[1] + p[2] * cup[2];
    const zc = p[0] * fwd[0] + p[1] * fwd[1] + p[2] * fwd[2];
    return { x: w / 2 + (f * xc) / zc, y: h / 2 - (f * yc) / zc, z: zc };
  };
  const H = cal.homographyFromPoints(cal.calBoardPoints().map((p) => { const q = proj(p.x, p.y); return { x: q.x / w, y: q.y / h }; }));
  return { proj, H, f, w, h };
}

const norm = (v) => { const n = Math.hypot(...v); return v.map((x) => x / n); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Zufälliger Pfeil: Einstich (x,y), Achse leicht schräg (Flight meist etwas höher) */
export function randomDart(rng, x, y, style = {}) {
  let dir = norm([(rng() - 0.5) * 0.5, -0.1 + rng() * 0.55, 1]);
  if (style.up) {
    // wie auf den echten Bildern: alle Pfeile zeigen mit dem Flight deutlich nach oben
    const el = ((style.up + gaussian(rng) * 8) * Math.PI) / 180, az = (gaussian(rng) * 8 * Math.PI) / 180;
    dir = norm([Math.tan(az), Math.tan(el), 1]);
  }
  if (style.maxTilt) {
    // jeder Pfeil steckt anders: Neigung bis maxTilt Grad in beliebige Richtung
    // (Flight öfter nach oben als nach unten, wie bei Würfen im Bogen)
    const th = (Math.sqrt(rng()) * style.maxTilt * Math.PI) / 180;
    const phi = rng() < 0.6 ? Math.PI / 2 + (rng() - 0.5) * Math.PI : rng() * 2 * Math.PI;
    dir = [Math.sin(th) * Math.cos(phi), Math.sin(th) * Math.sin(phi), Math.cos(th)];
  }
  const spin = rng() * Math.PI;
  const palette = [[230, 200, 40], [40, 60, 160], [200, 40, 40], [25, 25, 28], [235, 235, 235], [40, 160, 70]];
  const BLACK = [26, 26, 28], SILVER = [165, 168, 175], TIP_SILVER = [178, 180, 186];
  if (style.preset === 'user') return { x, y, dir, spin, tip: [92, 92, 97], barrel: [138, 141, 148], shaft: [30, 30, 34], flight: [28, 28, 34] };
  if (style.preset) {
    // typische Steeldarts: Spitze und Barrel schwarz oder silber; Schaft/Flight farbig oder gleichfarbig
    const metal = style.preset === 'black' ? BLACK : style.preset === 'silver' ? SILVER : (rng() < 0.5 ? BLACK : SILVER);
    const same = style.preset === 'mixed' ? rng() < 0.5 : true;
    const col = palette[Math.floor(rng() * palette.length)];
    return {
      x, y, dir, spin,
      tip: metal === BLACK && rng() < 0.5 ? BLACK : TIP_SILVER,
      barrel: metal,
      shaft: same ? metal : col,
      flight: same ? (metal === SILVER ? [200, 202, 208] : BLACK) : col,
    };
  }
  return {
    x, y, dir, spin,
    flight: style.flight || palette[Math.floor(rng() * palette.length)],
    shaft: style.shaft || (rng() < 0.5 ? [28, 28, 32] : [190, 190, 195]),
    barrel: style.barrel || (rng() < 0.7 ? [112, 114, 120] : [70, 72, 78]),
  };
}

/**
 * Zeichnet Pfeile in ein (rauschfreies) Grundbild. Liefert neues ImageData.
 * opts.shadow: Lichtrichtung (zur Lampe), z. B. [0.2, 0.6, 1] für Deckenlicht von vorne oben
 */
export function drawDarts(base, cam, darts, { shadow = null, shadowStrength = 0.35 } = {}) {
  const { w, h } = cam;
  const img = new ImageData(new Uint8ClampedArray(base.data), w, h);
  const d = img.data;
  const zbuf = new Float32Array(w * h).fill(Infinity);
  const disk = (cx, cy, rpx, z, col, alphaMul = 1, isShadow = false) => {
    const R0 = rpx + 1;
    const x0 = Math.max(0, Math.floor(cx - R0)), x1 = Math.min(w - 1, Math.ceil(cx + R0));
    const y0 = Math.max(0, Math.floor(cy - R0)), y1 = Math.min(h - 1, Math.ceil(cy + R0));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      // dünne Teile (unter 1 px) decken anteilig ab
      const cov = Math.min(1, rpx * 2) * Math.max(0, Math.min(1, rpx + 0.5 - dist + (rpx < 0.5 ? 0.5 - rpx : 0))) * alphaMul;
      if (cov <= 0) continue;
      const p = y * w + x;
      if (isShadow) {
        if (zbuf[p] !== Infinity) continue;
        const i = p * 4, k = 1 - shadowStrength * cov;
        if (shadowMask[p] >= cov) continue;
        const prev = shadowMask[p]; shadowMask[p] = cov;
        const kk = (1 - shadowStrength * cov) / (1 - shadowStrength * prev);
        d[i] *= kk; d[i + 1] *= kk; d[i + 2] *= kk;
        continue;
      }
      if (z > zbuf[p]) continue;
      const i = p * 4;
      d[i] += (col[0] - d[i]) * cov; d[i + 1] += (col[1] - d[i + 1]) * cov; d[i + 2] += (col[2] - d[i + 2]) * cov;
      if (cov > 0.5) zbuf[p] = z;
    }
  };
  const shadowMask = new Float32Array(w * h);
  const parts = (dart) => {
    const a = dart.dir;
    // Querachsen für den Flight
    let e1 = norm(cross(a, [0, 1, 0])); let e2 = cross(a, e1);
    const c = Math.cos(dart.spin), s = Math.sin(dart.spin);
    [e1, e2] = [e1.map((v, i) => c * v + s * e2[i]), e2.map((v, i) => -s * e1[i] + c * v)];
    return { a, e1, e2 };
  };
  const cyl = [
    // [t0, t1, Radius mm, Farbe]
    (dt) => [0, 20, 1.15, dt.tip || [178, 180, 186]], // Spitze (sichtbarer Teil)
    (dt) => [20, 68, 3.4, dt.barrel], // Barrel
    (dt) => [68, 104, 2.6, dt.shaft], // Schaft
  ];
  const pt = (dt, t, u = 0, v = 0, ax) => [dt.x + ax.a[0] * t + ax.e1[0] * u + ax.e2[0] * v, dt.y + ax.a[1] * t + ax.e1[1] * u + ax.e2[1] * v, ax.a[2] * t + ax.e1[2] * u + ax.e2[2] * v];
  const flightHalf = (u) => (u < 0.45 ? 4 + (13 * u) / 0.45 : 17);
  const forEachSample = (dt, ax, fn) => {
    for (const mk of cyl) {
      const [t0, t1, rad, col] = mk(dt);
      for (let t = t0; t <= t1; t += 0.35) {
        // Rändelung des Barrels: leichte Helligkeitsstreifen
        const k = t >= 20 && t < 68 ? (Math.floor(t / 1.5) % 2 ? 1.12 : 0.88) : 1;
        fn(pt(dt, t, 0, 0, ax), rad, col.map((v) => Math.min(255, v * k)));
      }
    }
    for (let t = 100; t <= 138; t += 0.6) {
      const uu = (t - 100) / 38, hw = flightHalf(uu);
      for (const e of [1, 2]) for (let s = -hw; s <= hw; s += 0.8) {
        fn(e === 1 ? pt(dt, t, s, 0, ax) : pt(dt, t, 0, s, ax), 0.7, dt.flight);
      }
    }
  };
  for (const dt of darts) {
    const ax = parts(dt);
    if (shadow) {
      const L = norm(shadow);
      forEachSample(dt, ax, (P, rad) => {
        const k = P[2] / L[2];
        const S = [P[0] - L[0] * k, P[1] - L[1] * k];
        const q = cam.proj(S[0], S[1], 0);
        // weicher Schatten: breiter je weiter weg vom Objekt
        disk(q.x, q.y, (cam.f * (rad + 0.02 * P[2])) / q.z, 0, null, 0.8, true);
      });
    }
  }
  for (const dt of darts) {
    const ax = parts(dt);
    forEachSample(dt, ax, (P, rad, col) => {
      const q = cam.proj(P[0], P[1], P[2]);
      disk(q.x, q.y, (cam.f * rad) / q.z, q.z, col);
    });
  }
  return img;
}

export function addNoise(img, sigma, seed) {
  const rng = mulberry32(seed);
  const out = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  const o = out.data;
  for (let i = 0; i < o.length; i += 4) { const n = gaussian(rng) * sigma; o[i] += n; o[i + 1] += n + gaussian(rng) * sigma * 0.4; o[i + 2] += n; }
  return out;
}

// schnelles Rauschen: einmal erzeugte Normalverteilung, pro Bild zufällig versetzt gelesen
const NOISE = (() => { const r = mulberry32(99); const a = new Float32Array(1 << 20); for (let i = 0; i < a.length; i++) a[i] = gaussian(r); return a; })();
export function addNoiseFast(img, sigma, seed) {
  const out = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  const o = out.data, M = NOISE.length - 1;
  let k = (seed * 104729) & M;
  const step = 1 + ((seed * 7) % 5) * 2;
  for (let i = 0; i < o.length; i += 4) {
    const n = NOISE[k] * sigma; k = (k + step) & M;
    o[i] += n; o[i + 1] += n + NOISE[k] * sigma * 0.4; o[i + 2] += n; k = (k + 1) & M;
  }
  return out;
}

/** Ausschnitt wie camera.grab({crop, maxW}) */
export function grabCrop(img, crop, maxW = 640, ox = 0, oy = 0) {
  const W = img.width, H = img.height;
  const c = document.createElement('canvas'); c.width = W; c.height = H; c.getContext('2d').putImageData(img, 0, 0);
  const sw = crop.w * W, sh = crop.h * H, s = Math.min(1, maxW / sw);
  const o = document.createElement('canvas'); o.width = Math.max(1, Math.round(sw * s)); o.height = Math.max(1, Math.round(sh * s));
  o.getContext('2d').drawImage(c, crop.x * W + ox, crop.y * H + oy, sw, sh, 0, 0, o.width, o.height);
  return o.getContext('2d').getImageData(0, 0, o.width, o.height);
}

/** 3x3-Gauß (Optik einer Kamera) */
function soften(img) {
  const { width: w, height: h } = img, out = new ImageData(new Uint8ClampedArray(img.data), w, h), s = img.data, d = out.data, W4 = w * 4;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) for (let c = 0; c < 3; c++) {
    const i = (y * w + x) * 4 + c;
    d[i] = (4 * s[i] + 2 * (s[i - 4] + s[i + 4] + s[i - W4] + s[i + W4]) + s[i - W4 - 4] + s[i - W4 + 4] + s[i + W4 - 4] + s[i + W4 + 4]) / 16;
  }
  return out;
}

/**
 * Störungen echter Handyvideos, die keine Verschiebung des ganzen Bilds sind: örtliche Verzerrung um
 * Bruchteile eines Pixels (Rolling Shutter, Bildstabilisator) und schwankende Schärfe (Autofokus,
 * Rauschminderung). st = { warp: px, sharp: ±Anteil }
 */
function disturbField(rng, st) {
  const G = 5, fx = [], fy = [];
  for (let k = 0; k < (G + 1) * (G + 1); k++) { fx.push((rng() - 0.5) * 2 * st.warp); fy.push((rng() - 0.5) * 2 * st.warp); }
  return { G, fx, fy, k: (rng() - 0.5) * 2 * st.sharp }; // k > 0 schärfer, < 0 weicher
}
function disturb(img, f) {
  const { width: w, height: h } = img, s = img.data, out = new ImageData(w, h), d = out.data;
  const { G, fx, fy, k } = f;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4; d[i + 3] = 255;
    if (x < 3 || y < 3 || x >= w - 4 || y >= h - 4) { d[i] = s[i]; d[i + 1] = s[i + 1]; d[i + 2] = s[i + 2]; continue; }
    const gx = (x / w) * G, gy = (y / h) * G, x0 = gx | 0, y0 = gy | 0, u = gx - x0, v = gy - y0, q = y0 * (G + 1) + x0;
    const lerp = (f) => (f[q] * (1 - u) + f[q + 1] * u) * (1 - v) + (f[q + G + 1] * (1 - u) + f[q + G + 2] * u) * v;
    const px = x + lerp(fx), py = y + lerp(fy), ix = px | 0, iy = py | 0, a = px - ix, b = py - iy, j = (iy * w + ix) * 4, W4 = w * 4;
    for (let c = 0; c < 3; c++) {
      const val = (s[j + c] * (1 - a) + s[j + 4 + c] * a) * (1 - b) + (s[j + W4 + c] * (1 - a) + s[j + W4 + 4 + c] * a) * b;
      const m = (s[j + c - 4] + s[j + c + 4] + s[j + c - W4] + s[j + c + W4]) / 4;
      d[i + c] = val + k * (val - m);
    }
  }
  return out;
}

const REAL_COLORS = { red: [205, 52, 48], green: [38, 205, 55], black: [44, 44, 48], cream: [212, 207, 192], surround: [40, 40, 46], wall: [62, 10, 34], wire: [190, 190, 188] };

/** Zufällige Einstichstelle: gemischt aus Triple/Double/Single/Bull, gleichmäßig über die Scheibe */
function randomTarget(rng) {
  const u = rng();
  const a = rng() * 2 * Math.PI;
  let r;
  if (u < 0.08) r = rng() * R.SBULL;
  else if (u < 0.3) r = R.TRIPLE_IN + rng() * (R.TRIPLE_OUT - R.TRIPLE_IN);
  else if (u < 0.5) r = R.DOUBLE_IN + rng() * (R.DOUBLE_OUT - R.DOUBLE_IN);
  else r = R.SBULL + rng() * (R.DOUBLE_IN - R.SBULL);
  return { x: r * Math.cos(a), y: r * Math.sin(a) };
}

/**
 * Simuliert Aufnahmen à 3 Pfeile mit dem echten Detektor (inkl. Ausschnitt wie im Spiel).
 * Liefert Statistik: richtig erkannte Felder, Fehler in mm, verpasste Pfeile.
 */
export function simulate({ deg = 0, tilt = 0, w = 720, h = 1280, fill = 0.7, visits = 6, seed = 1, shadow = null, light = 0.9, noise = 4, style = {}, detectorOpts = {}, roll = 0, log = null }) {
  const rng = mulberry32(seed * 7919 + Math.round(deg * 13 + tilt * 3));
  const cam = sideCamera(deg, w, h, { fill, tilt, roll });
  // echte Optik bildet Kanten weich ab (ohne Glättung wären verschobene Bilder unrealistisch verschieden)
  const base = style.real ? soften(renderScene({ w, h, pts: cal.pointsFromH(cam.H), light, noise: 0, seed, ...(style.real ? { colors: REAL_COLORS, texture: style.texture || 9, warm: false, light: 1 } : {}) }).img) : renderScene({ w, h, pts: cal.pointsFromH(cam.H), light, noise: 0, seed, ...(style.real ? { colors: REAL_COLORS, texture: style.texture || 9, warm: false, light: 1 } : {}) }).img;
  const bc = cal.boardCrop(cam.H);
  const crop = detectorOpts.boardCropOnly ? bc : dartCrop(cam.H, w, h);
  const detMaxW = Math.min(960, Math.round((640 * crop.w) / bc.w)); // wie im Spiel
  const Hc = cal.cropH(cam.H, crop);
  const det = new DartDetector(detectorOpts);
  let frameSeed = seed * 1000;
  let cacheKey = null, cacheImg = null; // gezeichnete Pfeile wiederverwenden, nur Rauschen neu
  const drawn = (darts) => { const key = darts.map((d) => d.x.toFixed(3) + d.y.toFixed(3) + d.dir.map((v) => v.toFixed(4)).join(',')).join('|'); if (key !== cacheKey) { cacheKey = key; cacheImg = darts.length ? drawDarts(base, cam, darts, { shadow }) : base; } return cacheImg; };
  // Wackeln pro Bild (style.jitter) und bleibendes Verrutschen nach Treffern/Ziehen (style.slip), in Vollbild-px
  let sx0 = 0, sy0 = 0;
  const slip = () => { if (style.disturb) field = disturbField(rng, style.disturb); if (style.slip) { sx0 = (rng() - 0.5) * 2 * style.slip; sy0 = (rng() - 0.5) * 2 * style.slip; } };
  let fineNow = null;
  const grab = (darts) => {
    const img = addNoiseFast(drawn(darts), style.noise || noise, frameSeed++), z = style.fine ? w / 720 : 1; // Wackeln in px des Standardbilds
    const ox = (sx0 + (style.jitter ? gaussian(rng) * style.jitter : 0)) * z, oy = (sy0 + (style.jitter ? gaussian(rng) * style.jitter : 0)) * z;
    if (style.fine) fineNow = () => grabCrop(img, crop, 1e9, ox, oy);
    return grabCrop(img, crop, detMaxW, ox, oy);
  };

  // die Störung ändert sich mit jedem Ereignis (Treffer, Ziehen), nicht mit jedem Bild
  let field = style.disturb ? disturbField(rng, style.disturb) : null;
  // Autofokus beim Start noch nicht fertig: erste Bilder weicher (mehrfach geglättet), danach scharf
  let softStart = style.softStart || 0;
  const focus = (img) => { let o = img; for (let k = 0; k < softStart; k++) o = soften(o); return o; };
  const frame = (darts) => focus(field ? disturb(grab(darts), field) : grab(darts));
  // feines Bild wie im Spiel (volle Kameraauflösung), nur wenn das Bild größer ist als die Auswertung
  const finePool = [];
  if (style.fine && !style.fineOff) {
    det.fineGrab = (used) => {
      if (!fineNow) return null;
      let c = finePool.find((q) => !used.includes(q));
      if (!c) finePool.push((c = { canvas: document.createElement('canvas') }));
      const g = fineNow();
      c.w = c.canvas.width = g.width; c.h = c.canvas.height = g.height;
      c.canvas.getContext('2d', { willReadFrequently: true }).putImageData(g, 0, 0);
      return c;
    };
  }
  const first = frame([]);
  det.setCalibration(Hc, first.width, first.height, detectorOpts.noView ? null : cropView(crop, first.width, first.height));
  let startPhantom = 0;
  det.process(first);
  for (let k = 0; k < 6; k++) det.process(frame([]));
  if (softStart) { softStart = 0; for (let k = 0; k < 24; k++) for (const ev of det.process(frame([]))) if (ev.type === 'dart') startPhantom++; }
  const res = { n: 0, correct: 0, auto: 0, askOk: 0, askWrong: 0, phantom: 0, missed: 0, lowConf: 0, errs: [], errsConf: [], wrongConfident: 0, wrong: [], along: [], perp: [] };
  res.phantom += startPhantom;
  for (let v = 0; v < visits; v++) {
    const darts = [];
    // eng gruppiert: alle drei Pfeile um einen gemeinsamen Zielpunkt (Streuung style.cluster mm)
    const center = style.cluster ? randomTarget(rng) : null;
    const truths = [], found = [];
    for (let k = 0; k < 3; k++) {
      let t = randomTarget(rng);
      if (center) { t = { x: center.x + gaussian(rng) * style.cluster, y: center.y + gaussian(rng) * style.cluster }; if (Math.hypot(t.x, t.y) > 168) t = center; }
      // Anstoßen: ein naher neuer Pfeil verschiebt die Neigung eines steckenden Pfeils leicht
      if (style.bump) for (const o of darts) {
        if (Math.hypot(o.x - t.x, o.y - t.y) < 20) {
          const a = ((3 + rng() * 6) * Math.PI) / 180, ph = rng() * 2 * Math.PI;
          o.dir = norm([o.dir[0] + Math.sin(a) * Math.cos(ph), o.dir[1] + Math.sin(a) * Math.sin(ph), o.dir[2]]);
        }
      }
      darts.push(randomDart(rng, t.x, t.y, style));
      // ein Spieler wirft drei gleiche Pfeile
      if (style.sameSet && darts.length > 1) { const f = darts[0], d = darts[darts.length - 1]; for (const key of ["tip", "barrel", "shaft", "flight"]) d[key] = f[key]; }
      slip();
      // Bewegung (Hand/Pfeil im Flug) simulieren: ein gestörtes Bild, dann ruhig
      const moving = frame(darts.slice(0, -1));
      const md = moving.data;
      for (let i = 0; i < md.length; i += 4 * 7) md[i] = 255 - md[i];
      det.process(moving);
      let evs = [];
      const still = frame(darts);
      for (let f = 0; f < 7; f++) evs = evs.concat(det.process(f % 2 ? still : frame(darts)));
      const truth = scoreAt(t.x, t.y);
      truths.push({ t, truth, k, dart: { ...darts[darts.length - 1] } });
      res.n++;
      for (const ev of evs) {
        if (ev.type !== 'dart') continue;
        found.push(ev);
        // wie im Spiel: Der Nutzer bestätigt einen richtigen Vorschlag, die Erkennung lernt daraus die Richtung
        if (ev.conf < 0.6 && truths.some((q) => q.truth.label === ev.hit.label && Math.hypot(ev.board.x - q.t.x, ev.board.y - q.t.y) < 15)) det.learnDirection({ ...ev, conf: 1 });
      }
    }
    // Zuordnung: jeweils das nächste Paar aus wahrem und erkanntem Pfeil
    const pairs = [];
    truths.forEach((q, i) => found.forEach((ev, j) => pairs.push({ i, j, d: Math.hypot(ev.board.x - q.t.x, ev.board.y - q.t.y) })));
    pairs.sort((a, b) => a.d - b.d);
    const ui = new Set(), uj = new Set();
    for (const { i, j, d: e } of pairs) {
      if (ui.has(i) || uj.has(j)) continue;
      ui.add(i); uj.add(j);
      const { t, truth, k, dart } = truths[i], ev = found[j];
      res.errs.push(e);
      {
        const toC = (q) => ({ x: ((q.x / w - crop.x) / crop.w) * first.width, y: ((q.y / h - crop.y) / crop.h) * first.height });
        const p0 = toC(cam.proj(t.x, t.y, 0)), p1 = toC(cam.proj(t.x + dart.dir[0] * 50, t.y + dart.dir[1] * 50, dart.dir[2] * 50));
        let ax = p1.x - p0.x, ay = p1.y - p0.y; const an = Math.hypot(ax, ay) || 1; ax /= an; ay /= an;
        const dx = ev.tip.x * first.width - p0.x, dy = ev.tip.y * first.height - p0.y;
        res.along.push(dx * ax + dy * ay); res.perp.push(dx * ay - dy * ax);
      }
      const good = ev.hit.label === truth.label;
      if (ev.conf < 0.6) res.lowConf++; else res.errsConf.push(e);
      if (ev.conf >= 0.6) { if (good) res.auto++; else res.wrongConfident++; } else if (good) res.askOk++; else res.askWrong++;
      if (good) res.correct++;
      else res.wrong.push(`${truth.label} → ${ev.hit.label} (${e.toFixed(1)} mm, ${Math.round(ev.conf * 100)} %${ev.reasons.length ? ', ' + ev.reasons.join(', ') : ''})`);
      if (log) log({ v, k, t, ev, e, darts: darts.map((d) => ({ ...d })), cam, crop, detMaxW, det, base });
    }
    truths.forEach((q, i) => { if (!ui.has(i)) { res.missed++; res.wrong.push(`${q.truth.label}: nicht erkannt`); } });
    res.phantom += found.length - uj.size;
    // Pfeile ziehen
    slip();
    det.awaitTakeout();
    const hand = frame([]); const hd = hand.data; for (let i = 0; i < hd.length; i += 4 * 5) hd[i] = 0;
    // die Entnahme darf schon erkannt werden, während noch Bewegung im Bild ist
    let tk = det.process(hand);
    for (let f = 0; f < 8; f++) tk = tk.concat(det.process(frame([])));
    res.phantom += tk.filter((e) => e.type === 'dart').length;
    if (!tk.some((e) => e.type === 'takeout')) res.noTakeout = (res.noTakeout || 0) + 1;
  }
  const s = res.errs.slice().sort((a, b) => a - b);
  res.mean = s.length ? s.reduce((a, b) => a + b, 0) / s.length : NaN;
  res.p90 = s.length ? s[Math.floor(s.length * 0.9)] : NaN;
  res.max = s.length ? s[s.length - 1] : NaN;
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  res.biasAlong = avg(res.along); res.biasPerp = avg(res.perp); res.meanConf = avg(res.errsConf);
  return res;
}

/** Feste Messreihe über alle Pfeilarten; seed frei wählbar (zum Gegenprüfen frische Werte nehmen) */
export const SCENARIOS = [
  ['bunt, normal', {}], ['schwarz/silber gemischt', { preset: 'mixed' }], ['komplett schwarz', { preset: 'black' }], ['komplett silber', { preset: 'silver' }],
  ['bunt, bis 40° schräg', { maxTilt: 40 }], ['schwarz/silber, bis 40° schräg', { maxTilt: 40, preset: 'mixed' }],
  ['enge Gruppe, bunt, gleiche Pfeile', { cluster: 8, bump: true, sameSet: true }],
  ['enge Gruppe, schwarz/silber, gleich, schräg', { cluster: 8, bump: true, sameSet: true, preset: 'mixed', maxTilt: 30 }],
];
// Bedingungen wie auf den echten Bildern des Nutzers (fast frontal, neutral weiße Felder, Wackeln)
export const REAL = { real: true, preset: 'user', up: 20, jitter: 0.15, slip: 1.2, sameSet: true };
export const REAL_SCENARIOS = [['echt: verteilt', REAL], ['echt: ohne Wackeln', { ...REAL, jitter: 0, slip: 0 }], ['echt: enge Gruppe', { ...REAL, cluster: 8, bump: true }], ['echt: starkes Wackeln', { ...REAL, jitter: 0.4, slip: 2 }], ['echt: unruhiges Bild', { ...REAL, texture: 18, noise: 7, disturb: { warp: 0.35, sharp: 0.5 } }], ['echt: Autofokus beim Start', { ...REAL, texture: 18, noise: 5, softStart: 5 }]];
export const REAL_CAMERAS = [[-23, -8], [-20, 0], [25, -5], [-30, 5], [23, 8]];
export const CAMERAS = [[30, 0], [-30, 0], [45, 0], [-45, 0], [55, 0], [-55, 0], [45, 15], [-45, -15]];

export async function benchmark(seed, onRow = () => {}, { scenarios = SCENARIOS, cameras = CAMERAS, visits = 4, size = null } = {}) {
  const rows = [];
  for (const [label, style] of scenarios) {
    const r = { label, seed, n: 0, auto: 0, askOk: 0, askWrong: 0, wrongConfident: 0, missed: 0, phantom: 0, noTakeout: 0, errs: [], bad: [] };
    for (const [deg, tilt] of cameras) {
      await new Promise((res) => { const c = new MessageChannel(); c.port1.onmessage = res; c.port2.postMessage(0); });
      const s = simulate({ deg, tilt, visits, seed, style, ...(size || {}), log: ({ t, ev, e, k }) => { if (ev.conf >= 0.6 && ev.hit.label !== scoreAt(t.x, t.y).label) r.bad.push(`${deg}/${tilt} P${k + 1} ${scoreAt(t.x, t.y).label}→${ev.hit.label} e=${e.toFixed(1)} c${Math.round(ev.conf * 100)} [${ev.reasons}]`); } });
      for (const key of ['n', 'auto', 'askOk', 'askWrong', 'wrongConfident', 'missed', 'phantom']) r[key] += s[key];
      r.noTakeout += s.noTakeout || 0; r.errs.push(...s.errsConf);
    }
    r.mean = r.errs.reduce((a, b) => a + b, 0) / r.errs.length; delete r.errs;
    rows.push(r); onRow(r);
  }
  return rows;
}

/** Leere Scheibe in Farben/Optik wie auf den echten Bildern */
export function realScene(cam, w, h, seed = 1) {
  return soften(renderScene({ w, h, pts: cal.pointsFromH(cam.H), light: 1, noise: 0, seed, colors: REAL_COLORS, texture: 9, warm: false }).img);
}
