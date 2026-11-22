// Belastungstest der Kalibrierung: erzeugt aus einem echten Kamerabild viele Bedingungen
// mit bekannter Wahrheit und misst den Fehler in Millimetern auf der Scheibe.
import * as cal from '../js/vision/calibration.js';
import { applyH, invertH, mulH } from '../js/vision/homography.js';
import { solveHomography } from '../js/vision/homography.js';
import { mulberry32, gaussian } from '../js/core/rng.js';
import { targetPoint } from '../js/core/board.js';

export function loadImage(src) {
  return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; });
}

function canvasOf(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

/** Pixel-Homographie (Bild→Bild) aus 4 Eckverschiebungen */
function warpH(w, h, corners) {
  const src = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  return solveHomography(src, corners);
}

/** Projektive Verzerrung mit bilinearer Abtastung; T: Quelle(px) → Ziel(px) */
function warpImage(img, T, outW, outH, fill = [20, 18, 24]) {
  const Ti = invertH(T);
  const out = new ImageData(outW, outH);
  const s = img.data, d = out.data, w = img.width, h = img.height;
  for (let y = 0; y < outH; y++) for (let x = 0; x < outW; x++) {
    const p = applyH(Ti, x + 0.5, y + 0.5);
    const sx = p.x - 0.5, sy = p.y - 0.5;
    const i = (y * outW + x) * 4;
    if (sx < 0 || sy < 0 || sx >= w - 1 || sy >= h - 1) { d[i] = fill[0]; d[i + 1] = fill[1]; d[i + 2] = fill[2]; d[i + 3] = 255; continue; }
    const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
    for (let c = 0; c < 3; c++) {
      const a = s[(y0 * w + x0) * 4 + c], b = s[(y0 * w + x0 + 1) * 4 + c];
      const e = s[((y0 + 1) * w + x0) * 4 + c], f = s[((y0 + 1) * w + x0 + 1) * 4 + c];
      d[i + c] = (a * (1 - fx) + b * fx) * (1 - fy) + (e * (1 - fx) + f * fx) * fy;
    }
    d[i + 3] = 255;
  }
  return out;
}

function toCanvas(img) { const c = canvasOf(img.width, img.height); c.getContext('2d').putImageData(img, 0, 0); return c; }
function fromCanvas(c) { return c.getContext('2d').getImageData(0, 0, c.width, c.height); }

function filtered(img, filter) {
  const c = canvasOf(img.width, img.height);
  const g = c.getContext('2d'); g.filter = filter; g.drawImage(toCanvas(img), 0, 0);
  return fromCanvas(c);
}

function addNoise(img, sigma, seed = 1) {
  const rng = mulberry32(seed);
  const out = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  for (let i = 0; i < out.data.length; i += 4) for (let c = 0; c < 3; c++) out.data[i + c] += gaussian(rng) * sigma;
  return out;
}

function tint(img, [r, g, b]) {
  const out = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  for (let i = 0; i < out.data.length; i += 4) { out.data[i] *= r; out.data[i + 1] *= g; out.data[i + 2] *= b; }
  return out;
}

async function jpeg(img, q) {
  const im = await loadImage(toCanvas(img).toDataURL('image/jpeg', q));
  const c = canvasOf(img.width, img.height); c.getContext('2d').drawImage(im, 0, 0);
  return fromCanvas(c);
}

function paint(img, fn) {
  const c = toCanvas(img); fn(c.getContext('2d'), c.width, c.height); return fromCanvas(c);
}

/**
 * Kamera seitlich neben der Scheibe auf Bull-Höhe: Blickwinkel deg (0 = frontal, + = von rechts).
 * Liefert H (Board mm → Bild normiert) für ein Bild w×h, Lochkamera auf das Bull gerichtet.
 */
export function sideViewH(deg, w, h, { dist = 650, fill = 0.8, tilt = 0 } = {}) {
  const t = (deg * Math.PI) / 180, tl = (tilt * Math.PI) / 180;
  const C = [Math.sin(t) * dist * Math.cos(tl), Math.sin(tl) * dist, Math.cos(t) * dist * Math.cos(tl)];
  const n = Math.hypot(...C);
  const fwd = C.map((v) => -v / n);
  const up = [0, 1, 0];
  let right = [fwd[1] * up[2] - fwd[2] * up[1], fwd[2] * up[0] - fwd[0] * up[2], fwd[0] * up[1] - fwd[1] * up[0]];
  const rn = Math.hypot(...right); right = right.map((v) => v / rn);
  const cup = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
  // Brennweite so, dass die Scheibe (Ø 450 mm) frontal fill × min(w,h) füllt
  const f = (fill * Math.min(w, h)) / (450 / dist);
  const proj = (X, Y) => {
    const p = [X - C[0], Y - C[1], -C[2]];
    const xc = p[0] * right[0] + p[1] * right[1] + p[2] * right[2];
    const yc = p[0] * cup[0] + p[1] * cup[1] + p[2] * cup[2];
    const zc = p[0] * fwd[0] + p[1] * fwd[1] + p[2] * fwd[2];
    return { x: (w / 2 + (f * xc) / zc) / w, y: (h / 2 - (f * yc) / zc) / h };
  };
  return cal.homographyFromPoints(cal.calBoardPoints().map((p) => proj(p.x, p.y)));
}

/** Echtes Foto in eine andere Kameraposition umrechnen (exakt für alles auf der Scheibenebene) */
export function reproject(img, Hsrc, Hdst, outW = img.width, outH = img.height) {
  const toPx = (H, w, h) => [H[0] * w, H[1] * w, H[2] * w, H[3] * h, H[4] * h, H[5] * h, H[6], H[7], H[8]];
  const T = mulH(toPx(Hdst, outW, outH), invertH(toPx(Hsrc, img.width, img.height)));
  return warpImage(img, T, outW, outH);
}

/** Fehler (mm) der geschätzten Kalibrierung Hp gegenüber Wahrheit Ht, gemessen auf der Scheibe */
export function errorMm(Hp, Ht, w, h) {
  // beide: Board(mm) → normiert; Fehlerpunkt: Board-Punkt → Bild (geschätzt) → Board (wahr)
  const Hti = invertH(Ht);
  let max = 0, sum = 0, n = 0;
  for (const r of [16, 103, 166]) for (let k = 0; k < 36; k++) {
    const t = (k * 10 * Math.PI) / 180;
    const bx = r * Math.cos(t), by = r * Math.sin(t);
    const q = applyH(Hp, bx, by);
    const b = applyH(Hti, q.x, q.y);
    const e = Math.hypot(b.x - bx, b.y - by);
    max = Math.max(max, e); sum += e; n++;
  }
  return { max, mean: sum / n };
}

/** Wahrheit nach Pixel-Transformation T (alt→neu) */
function transformH(Hn, T, w0, h0, w1, h1) {
  const Hpx = [Hn[0] * w0, Hn[1] * w0, Hn[2] * w0, Hn[3] * h0, Hn[4] * h0, Hn[5] * h0, Hn[6], Hn[7], Hn[8]];
  const H2 = mulH(T, Hpx);
  return [H2[0] / w1, H2[1] / w1, H2[2] / w1, H2[3] / h1, H2[4] / h1, H2[5] / h1, H2[6], H2[7], H2[8]];
}

/** Liste der Bedingungen: jede liefert { img, H } */
export async function conditions(base, H0) {
  const w = base.width, h = base.height;
  const id = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const list = [];
  const same = (name, img) => list.push({ name, img, H: H0 });
  const geo = (name, corners, outW = w, outH = h) => {
    const T = warpH(w, h, corners);
    list.push({ name, img: warpImage(base, T, outW, outH), H: transformH(H0, T, w, h, outW, outH) });
  };
  same('Original', base);
  same('Dunkel (30 %)', filtered(base, 'brightness(0.3)'));
  same('Sehr dunkel (15 %) + Rauschen', addNoise(filtered(base, 'brightness(0.15)'), 6));
  same('Überbelichtet', filtered(base, 'brightness(1.7)'));
  same('Kontrastarm', filtered(base, 'contrast(0.45)'));
  same('Blasse Farben', filtered(base, 'saturate(0.35)'));
  same('Warmes Licht', tint(base, [1.15, 0.95, 0.65]));
  same('Kaltes Licht', tint(base, [0.75, 0.95, 1.2]));
  same('Unscharf (leicht)', filtered(base, 'blur(2px)'));
  same('Unscharf (stark)', filtered(base, 'blur(4px)'));
  same('Starkes Rauschen', addNoise(base, 18));
  same('JPEG stark komprimiert', await jpeg(base, 0.25));
  same('Spiegelung/Lichtfleck', paint(base, (g, W, Hh) => {
    const gr = g.createRadialGradient(W * 0.62, Hh * 0.4, 5, W * 0.62, Hh * 0.4, W * 0.18);
    gr.addColorStop(0, 'rgba(255,255,255,0.95)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, W, Hh);
  }));
  same('Schatten über halber Scheibe', paint(base, (g, W, Hh) => {
    const gr = g.createLinearGradient(0, 0, W, 0);
    gr.addColorStop(0, 'rgba(0,0,0,0.65)'); gr.addColorStop(0.5, 'rgba(0,0,0,0.5)'); gr.addColorStop(0.6, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, W, Hh);
  }));
  // Pfeile in der Scheibe
  same('3 Pfeile in der Scheibe', paint(base, (g) => {
    for (const [seg, m] of [[20, 3], [20, 1], [19, 3]]) {
      const p = applyH(H0, targetPoint(seg, m).x, targetPoint(seg, m).y);
      const x = p.x * w, y = p.y * h;
      g.strokeStyle = '#2a2a33'; g.lineWidth = 5; g.beginPath(); g.moveTo(x, y); g.lineTo(x + 60, y - 50); g.stroke();
      g.fillStyle = '#e8c020'; g.beginPath(); g.moveTo(x + 55, y - 45); g.lineTo(x + 100, y - 70); g.lineTo(x + 85, y - 30); g.fill();
    }
  }));
  same('Hand verdeckt Teil der Scheibe', paint(base, (g, W, Hh) => {
    g.fillStyle = '#c99a7c'; g.beginPath(); g.ellipse(W * 0.78, Hh * 0.55, W * 0.16, Hh * 0.09, -0.4, 0, Math.PI * 2); g.fill();
  }));
  // Geometrie
  const d = (fx, fy) => ({ x: fx * w, y: fy * h });
  geo('Kleiner im Bild (60 %)', [d(0.2, 0.2), d(0.8, 0.2), d(0.8, 0.8), d(0.2, 0.8)]);
  geo('Sehr klein im Bild (40 %)', [d(0.3, 0.3), d(0.7, 0.3), d(0.7, 0.7), d(0.3, 0.7)]);
  geo('Handy um 10° verdreht', (() => { const c = Math.cos(0.1745), s = Math.sin(0.1745); return [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => ({ x: w / 2 + (x - w / 2) * c - (y - h / 2) * s, y: h / 2 + (x - w / 2) * s + (y - h / 2) * c })); })());
  geo('Handy um 25° verdreht', (() => { const c = Math.cos(0.436), s = Math.sin(0.436); return [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => ({ x: w / 2 + ((x - w / 2) * c - (y - h / 2) * s) * 0.8, y: h / 2 + ((x - w / 2) * s + (y - h / 2) * c) * 0.8 })); })());
  geo('Von links (schräg)', [d(0.05, -0.05), d(0.9, 0.12), d(0.9, 0.88), d(0.05, 1.05)]);
  geo('Von rechts (stark schräg)', [d(0.2, 0.15), d(0.95, -0.12), d(0.95, 1.12), d(0.2, 0.85)]);
  geo('Von unten', [d(0.12, 0.05), d(0.88, 0.05), d(1.05, 0.95), d(-0.05, 0.95)]);
  geo('Von oben', [d(-0.05, 0.05), d(1.05, 0.05), d(0.88, 0.95), d(0.12, 0.95)]);
  geo('Querformat-Ausschnitt', [d(0, -0.2), d(1, -0.2), d(1, 0.8), d(0, 0.8)], w, Math.round(h * 0.56));
  // Kombination
  const combo = (() => { const T = warpH(w, h, [d(0.15, 0.12), d(0.9, 0.02), d(0.92, 0.98), d(0.12, 0.88)]); return { T, img: warpImage(base, T, w, h) }; })();
  list.push({ name: 'Kombi: schräg + dunkel + unscharf + Rauschen', img: addNoise(filtered(combo.img, 'brightness(0.45) blur(1.5px)'), 10), H: transformH(H0, combo.T, w, h, w, h) });
  void id;
  return list;
}

/** Präzision auf synthetischen Szenen mit exakt bekannter Lage (Fehler in mm) */
export async function runPrecision() {
  const scene = await import('./scene.js');
  const out = [];
  const cases = [
    ['Seitlich, groß', scene.SIDE_VIEW, 1, 4],
    ['Seitlich, klein', scene.SIDE_VIEW.map((p) => ({ x: 0.5 + (p.x - 0.5) * 0.5, y: 0.5 + (p.y - 0.5) * 0.5 })), 0.8, 6],
    ['Hochformat frontal', [{ x: 0.52, y: 0.14 }, { x: 0.92, y: 0.36 }, { x: 0.5, y: 0.57 }, { x: 0.09, y: 0.35 }], 0.9, 4, 540, 960],
    ['Hochformat, dunkel, Rauschen', [{ x: 0.5, y: 0.16 }, { x: 0.9, y: 0.37 }, { x: 0.49, y: 0.58 }, { x: 0.1, y: 0.36 }], 0.45, 12, 540, 960],
  ];
  for (const [name, pts, light, noise, w = 1280, h = 720] of cases) {
    const { img, H } = scene.renderScene({ w, h, pts, light, noise, seed: 7 });
    const t0 = performance.now();
    const r = cal.autoCalibrate(img);
    const ms = Math.round(performance.now() - t0);
    const e = r ? errorMm(r.H, H) : null;
    out.push(`${name}: ${e ? `max ${e.max.toFixed(1)} mm, Ø ${e.mean.toFixed(1)} mm` : 'nicht gefunden'} (${ms} ms)`);
  }
  return out;
}

export async function runStress(base, H0, { verbose = false } = {}) {
  const rows = [];
  for (const c of await conditions(base, H0)) {
    const t0 = performance.now();
    const r = cal.autoCalibrate(c.img);
    const ms = Math.round(performance.now() - t0);
    if (!r) { rows.push({ name: c.name, ok: false, err: 'nicht gefunden', ms }); continue; }
    const e = errorMm(r.H, c.H, c.img.width, c.img.height);
    const q = cal.calibrationQuality(c.img, r.H);
    rows.push({ name: c.name, ok: e.max < 3, maxMm: +e.max.toFixed(1), meanMm: +e.mean.toFixed(1), q: Math.round(q.score * 100), ms, img: verbose ? c.img : undefined, H: r.H, Htrue: c.H });
  }
  return rows;
}

/**
 * Freihand-Kalibrierung nachstellen: Bildfolge mit Zittern (±30 px), Drehen (±3°), Zoom und
 * verwackelten Bildern. Wählt das schärfste Bild, kalibriert automatisch und führt die Kontur
 * über alle folgenden Bilder mit. Liefert die Fehler (mm) auf den scharfen Bildern.
 */
export async function runHandheld(real, H0, seeds = [1, 2, 3, 4], n = 25) {
  const { mulberry32: rngOf, gaussian: gauss } = await import('../js/core/rng.js');
  const W = real.width, Hh = real.height;
  const Hpx = [H0[0] * W, H0[1] * W, H0[2] * W, H0[3] * Hh, H0[4] * Hh, H0[5] * Hh, H0[6], H0[7], H0[8]];
  const out = [];
  for (const seed of seeds) {
    const rng = rngOf(seed);
    let tx = 0, ty = 0, rot = 0, sc = 1;
    const frames = [];
    for (let k = 0; k < n; k++) {
      tx += gauss(rng) * 6; ty += gauss(rng) * 6; rot += gauss(rng) * 0.4; sc *= 1 + gauss(rng) * 0.006;
      tx = Math.max(-30, Math.min(30, tx)); ty = Math.max(-30, Math.min(30, ty)); rot = Math.max(-3, Math.min(3, rot));
      const a = (rot * Math.PI) / 180, c = Math.cos(a) * sc, s = Math.sin(a) * sc;
      const T = [c, -s, W / 2 - (c * W) / 2 + (s * Hh) / 2 + tx, s, c, Hh / 2 - (s * W) / 2 - (c * Hh) / 2 + ty, 0, 0, 1];
      const H2 = mulH(T, Hpx);
      const Hk = [H2[0] / W, H2[1] / W, H2[2] / W, H2[3] / Hh, H2[4] / Hh, H2[5] / Hh, H2[6], H2[7], H2[8]];
      let img = reproject(real, H0, Hk);
      if (k % 3 === 1) img = filtered(img, 'blur(3px)');
      frames.push({ img, H: Hk, sharp: cal.sharpness(img) });
    }
    let bi = 0;
    for (let k = 0; k < 10; k++) if (frames[k].sharp > frames[bi].sharp) bi = k;
    let H = cal.autoCalibrate(frames[bi].img).H;
    let peak = frames[bi].sharp, worst = errorMm(H, frames[bi].H).max, sum = 0, cnt = 0;
    for (let k = bi + 1; k < n; k++) {
      peak = Math.max(peak * 0.97, frames[k].sharp);
      const fine = frames[k].sharp >= 0.6 * peak;
      H = cal.trackFrame(frames[k - 1].img, frames[k].img, H, { fine });
      if (fine) { const e = errorMm(H, frames[k].H); worst = Math.max(worst, e.max); sum += e.mean; cnt++; }
    }
    out.push({ seed, start: bi, worst, mean: cnt ? sum / cnt : 0, end: errorMm(H, frames[n - 1].H).max });
  }
  return out;
}
