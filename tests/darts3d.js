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
  const dir = norm([(rng() - 0.5) * 0.5, -0.1 + rng() * 0.55, 1]);
  const spin = rng() * Math.PI;
  const palette = [[230, 200, 40], [40, 60, 160], [200, 40, 40], [25, 25, 28], [235, 235, 235], [40, 160, 70]];
  const BLACK = [26, 26, 28], SILVER = [165, 168, 175], TIP_SILVER = [178, 180, 186];
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
export function grabCrop(img, crop, maxW = 640) {
  const W = img.width, H = img.height;
  const c = document.createElement('canvas'); c.width = W; c.height = H; c.getContext('2d').putImageData(img, 0, 0);
  const sw = crop.w * W, sh = crop.h * H, s = Math.min(1, maxW / sw);
  const o = document.createElement('canvas'); o.width = Math.max(1, Math.round(sw * s)); o.height = Math.max(1, Math.round(sh * s));
  o.getContext('2d').drawImage(c, crop.x * W, crop.y * H, sw, sh, 0, 0, o.width, o.height);
  return o.getContext('2d').getImageData(0, 0, o.width, o.height);
}

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
  const base = renderScene({ w, h, pts: cal.pointsFromH(cam.H), light, noise: 0, seed }).img;
  const bc = cal.boardCrop(cam.H);
  const crop = detectorOpts.boardCropOnly ? bc : dartCrop(cam.H, w, h);
  const detMaxW = Math.min(960, Math.round((640 * crop.w) / bc.w)); // wie im Spiel
  const Hc = cal.cropH(cam.H, crop);
  const det = new DartDetector(detectorOpts);
  let frameSeed = seed * 1000;
  let cacheKey = null, cacheImg = null; // gezeichnete Pfeile wiederverwenden, nur Rauschen neu
  const drawn = (darts) => { const key = darts.map((d) => d.x.toFixed(3) + d.y.toFixed(3)).join('|'); if (key !== cacheKey) { cacheKey = key; cacheImg = darts.length ? drawDarts(base, cam, darts, { shadow }) : base; } return cacheImg; };
  const frame = (darts) => grabCrop(addNoiseFast(drawn(darts), noise, frameSeed++), crop, detMaxW);
  const first = frame([]);
  det.setCalibration(Hc, first.width, first.height, detectorOpts.noView ? null : cropView(crop, first.width, first.height));
  det.process(first);
  for (let k = 0; k < 6; k++) det.process(frame([]));
  const res = { n: 0, correct: 0, missed: 0, lowConf: 0, errs: [], errsConf: [], wrongConfident: 0, wrong: [], along: [], perp: [] };
  for (let v = 0; v < visits; v++) {
    const darts = [];
    for (let k = 0; k < 3; k++) {
      const t = randomTarget(rng);
      darts.push(randomDart(rng, t.x, t.y, style));
      // Bewegung (Hand/Pfeil im Flug) simulieren: ein gestörtes Bild, dann ruhig
      const moving = frame(darts.slice(0, -1));
      const md = moving.data;
      for (let i = 0; i < md.length; i += 4 * 7) md[i] = 255 - md[i];
      det.process(moving);
      let evs = [];
      const still = frame(darts);
      for (let f = 0; f < 7; f++) evs = evs.concat(det.process(f % 2 ? still : frame(darts)));
      const ev = evs.find((e) => e.type === 'dart');
      const truth = scoreAt(t.x, t.y);
      res.n++;
      if (!ev) { res.missed++; res.wrong.push(`${truth.label}: nicht erkannt (${evs.map((e) => e.type).join(',') || 'kein Ereignis'})`); continue; }
      const e = Math.hypot(ev.board.x - t.x, ev.board.y - t.y);
      res.errs.push(e);
      { // Abweichung im Bild entlang (+ = Richtung Flight) und quer zur Pfeilachse, in px
        const toC = (q) => ({ x: ((q.x / w - crop.x) / crop.w) * first.width, y: ((q.y / h - crop.y) / crop.h) * first.height });
        const dt = darts[darts.length - 1];
        const p0 = toC(cam.proj(t.x, t.y, 0)), p1 = toC(cam.proj(t.x + dt.dir[0] * 50, t.y + dt.dir[1] * 50, dt.dir[2] * 50));
        let ax = p1.x - p0.x, ay = p1.y - p0.y; const an = Math.hypot(ax, ay) || 1; ax /= an; ay /= an;
        const dx = ev.tip.x * first.width - p0.x, dy = ev.tip.y * first.height - p0.y;
        res.along.push(dx * ax + dy * ay); res.perp.push(dx * ay - dy * ax);
      }
      if (ev.conf < 0.6) res.lowConf++; else res.errsConf.push(e);
      if (ev.conf >= 0.6 && ev.hit.label !== truth.label) res.wrongConfident++;
      if (ev.hit.label === truth.label) res.correct++;
      else res.wrong.push(`${truth.label} → ${ev.hit.label} (${e.toFixed(1)} mm, ${Math.round(ev.conf * 100)} %${ev.reasons.length ? ', ' + ev.reasons.join(', ') : ''})`);
      if (log) log({ v, k, t, ev, e, darts: darts.slice(), cam, crop, detMaxW });
    }
    // Pfeile ziehen
    det.awaitTakeout();
    const hand = frame([]); const hd = hand.data; for (let i = 0; i < hd.length; i += 4 * 5) hd[i] = 0;
    det.process(hand);
    for (let f = 0; f < 8; f++) det.process(frame([]));
  }
  const s = res.errs.slice().sort((a, b) => a - b);
  res.mean = s.length ? s.reduce((a, b) => a + b, 0) / s.length : NaN;
  res.p90 = s.length ? s[Math.floor(s.length * 0.9)] : NaN;
  res.max = s.length ? s[s.length - 1] : NaN;
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  res.biasAlong = avg(res.along); res.biasPerp = avg(res.perp); res.meanConf = avg(res.errsConf);
  return res;
}
