// Spitze im feinen Kamerabild nachmessen. Die Erkennung selbst arbeitet mit einem verkleinerten Bild; hier wird nur ein
// schmaler Streifen entlang der Pfeilachse in voller Auflösung mit dem Bild davor verglichen.
import { applyT } from './align.js';

/** Ausschnitt lesen (gekappt am Bildrand). img: { canvas, w, h } */
function patch(img, x0, y0, x1, y1) {
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0)); x1 = Math.min(img.w, Math.ceil(x1)); y1 = Math.min(img.h, Math.ceil(y1));
  if (x1 - x0 < 8 || y1 - y0 < 8) return null;
  const d = img.canvas.getContext('2d').getImageData(x0, y0, x1 - x0, y1 - y0);
  return { x0, y0, w: d.width, h: d.height, data: d.data };
}

function sample(p, x, y, out) {
  x -= p.x0; y -= p.y0;
  const ix = Math.floor(x), iy = Math.floor(y);
  if (ix < 0 || iy < 0 || ix + 1 >= p.w || iy + 1 >= p.h) return false;
  const a = x - ix, b = y - iy, i = (iy * p.w + ix) * 4, j = i + p.w * 4, d = p.data;
  for (let c = 0; c < 3; c++) out[c] = (d[i + c] * (1 - a) + d[i + 4 + c] * a) * (1 - b) + (d[j + c] * (1 - a) + d[j + 4 + c] * a) * b;
  return true;
}

const median = (l) => { const s = Float32Array.from(l).sort(); return s.length ? s[s.length >> 1] : 0; };

/**
 * cur/ref: feine Bilder { canvas, w, h } (jetzt, davor); w: Breite des groben Bilds; T: grob jetzt → grob davor;
 * tip, dir: gefundene Spitze (grobe Pixel) und Richtung zur Spitze; L: Pfeillänge (grobe px); pxPerMm: grobe px je mm.
 * Liefert { tip (grobe px), m (mm Spitze vor dem Barrel), strength, … } oder null.
 */
export function fineTip({ cur, ref, w, T, tip, dir, L, pxPerMm }) {
  const k = cur.w / w;
  if (!(k > 1.15) || ref.w !== cur.w || ref.h !== cur.h) return null;
  const f = pxPerMm * k; // feine px je mm
  const tx = (tip.x + 0.5) * k - 0.5, ty = (tip.y + 0.5) * k - 0.5; // Spitze im feinen Bild
  const sMin = -Math.round(0.36 * L * k), sMax = Math.round(16 * f), O = Math.round(8 * f);
  const S = sMax - sMin + 1, N = 2 * O + 1;
  const P = (s, o) => [tx + dir.x * s - dir.y * o, ty + dir.y * s + dir.x * o];
  const toRef = (x, y) => { const q = applyT(T, (x + 0.5) / k - 0.5, (y + 0.5) / k - 0.5); return [(q.x + 0.5) * k - 0.5, (q.y + 0.5) * k - 0.5]; };
  const box = (map) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of [sMin, sMax]) for (const o of [-O, O]) { const [x, y] = map(...P(s, o)); x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return [x0 - 5, y0 - 5, x1 + 6, y1 + 6];
  };
  const pc = patch(cur, ...box((x, y) => [x, y])), pr = patch(ref, ...box(toRef));
  if (!pc || !pr) return null;
  const C = new Float32Array(S * N * 3), V = new Uint8Array(S * N), v = [0, 0, 0];
  const rx = new Float32Array(S * N), ry = new Float32Array(S * N);
  for (let i = 0; i < S; i++) for (let j = 0; j < N; j++) {
    const [x, y] = P(i + sMin, j - O), n = i * N + j;
    if (!sample(pc, x, y, v)) continue;
    C[n * 3] = v[0]; C[n * 3 + 1] = v[1]; C[n * 3 + 2] = v[2];
    const [a, b] = toRef(x, y); rx[n] = a; ry[n] = b; V[n] = 1;
  }
  // Ausrichtung auf Bruchteile eines feinen Pixels: Umgebung ohne Pfeil (seitlich und vor der Spitze)
  const bg = [];
  for (let i = 0; i < S; i++) for (let j = 0; j < N; j++) if (V[i * N + j] && (Math.abs(j - O) > 4.5 * f || i + sMin > 8 * f) && (i + j) % 2 === 0) bg.push(i * N + j);
  if (bg.length < 200) return null;
  const cost = (dx, dy) => {
    const r = new Float32Array(Math.ceil(bg.length / 2));
    let s = 0, n = 0, mc = 0, mr = 0;
    for (let q = 0, e = 0; q < bg.length; q += 2, e++) {
      const m = bg[q];
      if (!sample(pr, rx[m] + dx, ry[m] + dy, v)) { r[e] = -1; continue; }
      r[e] = v[1]; mc += C[m * 3 + 1]; mr += v[1]; n++;
    }
    if (n < 80) return { c: Infinity };
    const g = (mc - mr) / n;
    for (let q = 0, e = 0; q < bg.length; q += 2, e++) if (r[e] >= 0) s += Math.min(40, Math.abs(C[bg[q] * 3 + 1] - r[e] - g));
    return { c: s / n };
  };
  let best = { dx: 0, dy: 0, ...cost(0, 0) };
  for (const st of [1, 0.5, 0.25]) for (let moved = true, n = 0; moved && n < 5; n++) {
    moved = false;
    const b0 = best;
    for (const [ax, ay] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const dx = b0.dx + ax * st, dy = b0.dy + ay * st;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) continue;
      const q = cost(dx, dy);
      if (q.c < best.c) { best = { dx, dy, ...q }; moved = true; }
    }
  }
  // Differenz im Streifen; Kanten des Untergrunds zählen nur abgeschwächt (Restfehler der Ausrichtung)
  const R = new Float32Array(S * N * 3);
  for (let n = 0; n < S * N; n++) if (V[n]) { if (sample(pr, rx[n] + best.dx, ry[n] + best.dy, v)) { R[n * 3] = v[0]; R[n * 3 + 1] = v[1]; R[n * 3 + 2] = v[2]; } else V[n] = 0; }
  const gain = [0, 1, 2].map((c) => { let a = 0, b = 0; for (const n of bg) if (V[n]) { a += C[n * 3 + c]; b += R[n * 3 + c]; } return b ? Math.max(0.8, Math.min(1.25, a / b)) : 1; });
  const D = new Float32Array(S * N);
  for (let i = 1; i < S - 1; i++) for (let j = 1; j < N - 1; j++) {
    const n = i * N + j;
    if (!V[n] || !V[n - 1] || !V[n + 1] || !V[n - N] || !V[n + N]) continue;
    let sum = 0, max = 0, grad = 0;
    for (let c = 0; c < 3; c++) {
      // längs etwas glätten: die Spitze ist lang und dünn
      const a = (2 * C[n * 3 + c] + C[(n - N) * 3 + c] + C[(n + N) * 3 + c]) / 4, b = (gain[c] * (2 * R[n * 3 + c] + R[(n - N) * 3 + c] + R[(n + N) * 3 + c])) / 4;
      const e = Math.abs(a - b); sum += e; if (e > max) max = e;
      grad = Math.max(grad, Math.abs(R[(n + 1) * 3 + c] - R[(n - 1) * 3 + c]), Math.abs(R[(n + N) * 3 + c] - R[(n - N) * 3 + c]));
    }
    D[n] = Math.max(0, (sum / 3 + max) / 2 - 0.2 * grad);
  }
  // Mittellinie aus dem Barrel
  const sig = 1.48 * median(bg.map((n) => D[n])) + 1;
  const thr = Math.max(14, 3.5 * sig);
  const run = (i, c0) => { // größte zusammenhängende Breite um c0
    let br = null, r = null;
    if (i < 1 || i > S - 2) return null;
    for (let j = Math.max(1, Math.round(c0 - 5 * f)); j <= Math.min(N - 2, Math.round(c0 + 5 * f)); j++) {
      if (D[i * N + j] > thr) { if (!r) r = { a: j, b: j }; r.b = j; } else if (r) { if (!br || r.b - r.a > br.b - br.a) br = r; r = null; }
    }
    if (r && (!br || r.b - r.a > br.b - br.a)) br = r;
    return br;
  };
  const cen = [];
  for (let i = 2; i < S - 2; i++) {
    const s = i + sMin;
    if (s < -0.34 * L * k || s > -0.13 * L * k) continue;
    const r = run(i, O);
    if (r && r.b - r.a + 1 >= 3 * f && r.b - r.a + 1 <= 11 * f) cen.push({ s, c: (r.a + r.b) / 2, w: r.b - r.a + 1 });
  }
  if (cen.length < 0.1 * L * k) return null;
  const Wb = median(cen.map((e) => e.w));
  let pts = cen.filter((e) => Math.abs(e.w - Wb) <= 0.35 * Wb), a = 0, b = 0;
  if (pts.length < 8) return null;
  for (let it = 0; it < 3; it++) {
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const e of pts) { n++; sx += e.s; sy += e.c; sxx += e.s * e.s; sxy += e.s * e.c; }
    const den = n * sxx - sx * sx;
    if (Math.abs(den) < 1e-6) return null;
    b = (n * sxy - sx * sy) / den; a = (sy - b * sx) / n;
    const keep = pts.filter((e) => Math.abs(e.c - a - b * e.s) <= Math.max(1, 0.12 * Wb));
    if (keep.length < 8 || keep.length === pts.length) break;
    pts = keep;
  }
  if (Math.abs(b) > 0.12) return null;
  if (Math.abs(a - O) > 3.5 * f) return null;
  // Quer zählt die Achse der Erkennung (über den ganzen Pfeil gemessen, genauer als das oft nur teilweise sichtbare Barrel)
  const mid = () => O;
  // Barrelende: letzte Stelle, die noch deutlich breit ist
  let front = null, miss = 0;
  for (let s = Math.round(-0.2 * L * k); s <= sMax - 2; s++) {
    const r = run(s - sMin, mid(s));
    const wide = r && r.b - r.a + 1 >= 0.62 * Wb && Math.abs((r.a + r.b) / 2 - mid(s)) < 0.4 * Wb;
    if (wide) { front = s; miss = 0; } else if (front !== null && ++miss > 1.2 * f) break;
  }
  if (front === null) return null;
  // Stahlspitze: Signal in einem schmalen Band auf der Mittellinie gegen gleich breite Bänder daneben
  const hw = Math.max(1, Math.round(1.1 * f));
  const band = (s, c) => {
    const i = s - sMin;
    let m = 0, n = 0;
    for (let j = Math.round(c) - hw; j <= Math.round(c) + hw; j++) if (j > 0 && j < N - 1 && i > 0 && i < S - 1) { m += D[i * N + j]; n++; }
    return n ? m / n : 0;
  };
  const side = [];
  for (let s = front; s <= sMax - 2; s++) for (const o of [-5.6, -4, 4, 5.6]) side.push(band(s, mid(s) + o * f));
  const mu = median(side), sd = Math.max(1.2, 1.48 * median(side.map((e) => Math.abs(e - mu))));
  let end = front, cum = 0, top = 0;
  const lim = Math.min(sMax - 2, front + Math.round(0.28 * L * k));
  for (let s = front + 1; s <= lim; s++) {
    const z = Math.max(band(s, mid(s)), 0.9 * band(s, mid(s) - 0.7 * f), 0.9 * band(s, mid(s) + 0.7 * f));
    cum += Math.min(8, (z - mu) / sd) - 2.2;
    if (cum > top) { top = cum; end = s; }
    if (cum < top - 22) break; // deutlich vorbei
  }
  const at = (s) => { const [x, y] = P(s, mid(s) - O); return { x: (x + 0.5) / k - 0.5, y: (y + 0.5) / k - 0.5 }; };
  // das sichtbare Ende reicht um den Spitzenradius über die Mitte des Einstichs hinaus
  return { tip: at(end - 1.5 * f), m: (end - front) / f, strength: top / Math.sqrt(Math.max(1, end - front)), front: front / f, atMm: (mm) => at(front + mm * f), Wb: Wb / f, k, shift: { dx: best.dx, dy: best.dy }, noise: sd };
}
