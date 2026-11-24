// Feinausrichtung zweier Bilder derselben Scheibe (Stativ wackelt, Scheibe verrutscht minimal): zuerst
// Verschiebung, Drehung und Maßstab, dann Scherung und Perspektive, auf Bruchteile eines Pixels genau, dazu ein Helligkeitsabgleich.
// Pfeile, Hände usw. zählen als Ausreißer und beeinflussen das Ergebnis kaum.

const lumCache = new WeakMap();

/** Helligkeitsbild (Float32) eines RGBA-Puffers, zwischengespeichert */
export function luminance(data) {
  let l = lumCache.get(data);
  if (l) return l;
  const n = data.length >> 2;
  l = new Float32Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) l[p] = (data[i] + 2 * data[i + 1] + data[i + 2]) / 4;
  lumCache.set(data, l);
  return l;
}

export const IDENTITY = { a: 0, b: 0, tx: 0, ty: 0, cx: 0, cy: 0 };

/** Bildpunkt (x, y) des aktuellen Bilds → Bildpunkt in der Referenz */
export function applyT(T, x, y) {
  const X = x - T.cx, Y = y - T.cy;
  const q = T.g ? T.g[0] * X + T.g[1] * Y : 0;
  return T.s
    ? { x: x + T.a * X - T.b * Y + T.s[0] * X + T.s[1] * Y + X * q + T.tx, y: y + T.b * X + T.a * Y + T.s[1] * X - T.s[0] * Y + Y * q + T.ty }
    : { x: x + T.a * X - T.b * Y + T.tx, y: y + T.b * X + T.a * Y + T.ty };
}

/** Größte Verschiebung (px), die T innerhalb eines Radius r um die Mitte bewirkt */
export function transformSize(T, r) {
  return Math.hypot(T.tx, T.ty) + Math.hypot(T.a, T.b) * r;
}

/**
 * Schätzt T mit cur(p) ≈ ref(T(p)). idx: Pixelindizes der Auswertungsfläche; init: Startwert.
 * Lucas-Kanade mit Ausreißer-Dämpfung. ok = false, wenn zu wenig Struktur vorhanden ist.
 */
export function estimateTransform(cur, ref, w, h, idx, init = null, maxSamples = 8000) {
  const lc = luminance(cur), lr = luminance(ref);
  const cx = w / 2, cy = h / 2;
  const T = { a: 0, b: 0, tx: 0, ty: 0, cx, cy, ...(init ? { a: init.a || 0, b: init.b || 0, tx: init.tx || 0, ty: init.ty || 0 } : {}) };
  // nur Punkte mit Kanten tragen Information
  const step = Math.max(1, Math.floor(idx.length / (maxSamples * 4)));
  const pts = [];
  for (let k = 0; k < idx.length; k += step) {
    const p = idx[k], x = p % w, y = (p / w) | 0;
    if (x < 6 || y < 6 || x >= w - 6 || y >= h - 6) continue;
    const gx = lr[p + 1] - lr[p - 1], gy = lr[p + w] - lr[p - w];
    if (gx * gx + gy * gy > 400) pts.push(p);
  }
  if (pts.length < 200) return { ...T, ok: false };
  const keep = Math.max(1, Math.floor(pts.length / maxSamples));
  const bil = (l, x, y) => {
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, q = y0 * w + x0;
    return (l[q] * (1 - fx) + l[q + 1] * fx) * (1 - fy) + (l[q + w] * (1 - fx) + l[q + w + 1] * fx) * fy;
  };
  let gain = 1;
  for (let it = 0; it < 8; it++) {
    const N = new Float64Array(16), v = new Float64Array(4);
    let used = 0, sc = 0, sr = 0;
    const scale = it < 2 ? 40 : 18; // zuerst tolerant, dann Ausreißer stärker dämpfen
    for (let k = 0; k < pts.length; k += keep) {
      const p = pts[k], x = p % w, y = (p / w) | 0, X = x - cx, Y = y - cy;
      const rx = x + T.a * X - T.b * Y + T.tx, ry = y + T.b * X + T.a * Y + T.ty;
      if (rx < 3 || ry < 3 || rx >= w - 4 || ry >= h - 4) continue;
      const val = bil(lr, rx, ry);
      const e = lc[p] / gain - val;
      const gx = (bil(lr, rx + 1, ry) - bil(lr, rx - 1, ry)) / 2, gy = (bil(lr, rx, ry + 1) - bil(lr, rx, ry - 1)) / 2;
      const wt = 1 / (1 + (e / scale) * (e / scale));
      const wt2 = wt * wt;
      const J0 = gx * X + gy * Y, J1 = -gx * Y + gy * X;
      N[0] += wt2 * J0 * J0; N[1] += wt2 * J0 * J1; N[2] += wt2 * J0 * gx; N[3] += wt2 * J0 * gy;
      N[5] += wt2 * J1 * J1; N[6] += wt2 * J1 * gx; N[7] += wt2 * J1 * gy;
      N[10] += wt2 * gx * gx; N[11] += wt2 * gx * gy; N[15] += wt2 * gy * gy;
      v[0] += wt2 * J0 * e; v[1] += wt2 * J1 * e; v[2] += wt2 * gx * e; v[3] += wt2 * gy * e;
      if (wt > 0.6) { sc += lc[p]; sr += val; }
      used++;
    }
    if (used < 100) return { ...T, ok: false };
    N[4] = N[1]; N[8] = N[2]; N[9] = N[6]; N[12] = N[3]; N[13] = N[7]; N[14] = N[11];
    const d = solve4(N, v);
    if (!d) return { ...T, ok: false };
    T.a += d[0]; T.b += d[1]; T.tx += d[2]; T.ty += d[3];
    if (sr > 0) gain = Math.min(1.5, Math.max(0.65, sc / sr));
    if (Math.abs(d[2]) + Math.abs(d[3]) + (Math.abs(d[0]) + Math.abs(d[1])) * cx < 0.01) break;
  }
  const ok = Math.hypot(T.tx, T.ty) < 14 && Math.hypot(T.a, T.b) < 0.03;
  if (ok) {
    // Feinstufe mit 8 Parametern: eine leicht gedrehte oder gekippte Kamera verändert auch Scherung und
    // Perspektive. Parameter: a, b, s0, s1 (Scherung), g0, g1 (Perspektive), tx, ty; auf Bildgröße normiert.
    const R = Math.max(w, h) / 2, F = { ...T, s: [0, 0], g: [0, 0] };
    let fine = true;
    for (let it = 0; it < 4; it++) {
      const N = Array.from({ length: 8 }, () => new Float64Array(9)), J = new Float64Array(8);
      let used = 0;
      for (let k = 0; k < pts.length; k += keep) {
        const p = pts[k], x = p % w, y = (p / w) | 0, X = x - cx, Y = y - cy, t = applyT(F, x, y);
        if (t.x < 3 || t.y < 3 || t.x >= w - 4 || t.y >= h - 4) continue;
        const e = lc[p] / gain - bil(lr, t.x, t.y);
        const gx = (bil(lr, t.x + 1, t.y) - bil(lr, t.x - 1, t.y)) / 2, gy = (bil(lr, t.x, t.y + 1) - bil(lr, t.x, t.y - 1)) / 2;
        const wt = 1 / (1 + (e / 18) * (e / 18)), w2 = wt * wt, u = X / R, v = Y / R, d = gx * u + gy * v;
        J[0] = d; J[1] = -gx * v + gy * u; J[2] = gx * u - gy * v; J[3] = gx * v + gy * u; J[4] = d * u; J[5] = d * v; J[6] = gx; J[7] = gy;
        for (let r = 0; r < 8; r++) { const q = w2 * J[r], row = N[r]; for (let c = r; c < 8; c++) row[c] += q * J[c]; row[8] += q * e; }
        used++;
      }
      if (used < 400) { fine = false; break; }
      for (let r = 0; r < 8; r++) { for (let c = 0; c < r; c++) N[r][c] = N[c][r]; N[r][r] *= 1.0005; }
      const D = solveN(N, 8);
      if (!D) { fine = false; break; }
      F.a += D[0] / R; F.b += D[1] / R; F.s[0] += D[2] / R; F.s[1] += D[3] / R; F.g[0] += D[4] / (R * R); F.g[1] += D[5] / (R * R); F.tx += D[6]; F.ty += D[7];
      if (Math.max(...D.map(Math.abs)) < 0.01) break;
    }
    // nur übernehmen, wenn die Zusatzanteile klein bleiben (sonst hat sich die Schätzung verrannt)
    if (fine && Math.hypot(...F.s) < 0.012 && Math.hypot(...F.g) * R < 0.012 && Math.hypot(F.tx - T.tx, F.ty - T.ty) < 3) Object.assign(T, F);
  }
  return { ...T, gain, ok };
}

function solve4(N, v) {
  return solveN([0, 1, 2, 3].map((r) => [N[r * 4], N[r * 4 + 1], N[r * 4 + 2], N[r * 4 + 3], v[r]]), 4);
}

/** Lineares Gleichungssystem n×(n+1) (wird verändert) */
function solveN(M, n) {
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-9) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return Array.from({ length: n }, (_, r) => M[r][n] / M[r][r]);
}

/** Referenz auf das aktuelle Bild ausgerichtet (inkl. Helligkeit): Ergebnis(p) = ref(T(p)) · gain je Kanal */
export function warpRef(cur, ref, T, w, h, idx) {
  const gains = channelGains(cur, ref, T, w, h, idx);
  const flat = gains.every((g) => Math.abs(g - 1) < 0.006);
  if (flat && transformSize(T, Math.max(w, h) / 2) < 0.02) return ref;
  const out = new Uint8ClampedArray(ref.length);
  const [g0, g1, g2] = gains, s = w * 4, mx = w - 1.001, my = h - 1.001;
  for (let y = 0, i = 0; y < h; y++) {
    const Y = y - T.cy;
    // entlang der Zeile ändert sich die Quellposition gleichmäßig
    let sx = -T.a * T.cx - T.b * Y + T.tx, sy = y - T.b * T.cx + T.a * Y + T.ty;
    const ax = 1 + T.a, bx = T.b;
    const s0 = T.s ? T.s[0] : 0, s1 = T.s ? T.s[1] : 0, g0p = T.g ? T.g[0] : 0, g1p = T.g ? T.g[1] : 0;
    for (let x = 0; x < w; x++, i += 4, sx += ax, sy += bx) {
      const X = x - T.cx, q0 = g0p * X + g1p * Y, px = sx + s0 * X + s1 * Y + X * q0, py = sy + s1 * X - s0 * Y + Y * q0;
      const rx = px < 0 ? 0 : px > mx ? mx : px, ry = py < 0 ? 0 : py > my ? my : py;
      const x0 = rx | 0, y0 = ry | 0, fx = rx - x0, fy = ry - y0;
      const q = (y0 * w + x0) * 4, q2 = q + s;
      const w11 = fx * fy, w10 = fx - w11, w01 = fy - w11, w00 = 1 - fx - w01;
      out[i] = (ref[q] * w00 + ref[q + 4] * w10 + ref[q2] * w01 + ref[q2 + 4] * w11) * g0;
      out[i + 1] = (ref[q + 1] * w00 + ref[q + 5] * w10 + ref[q2 + 1] * w01 + ref[q2 + 5] * w11) * g1;
      out[i + 2] = (ref[q + 2] * w00 + ref[q + 6] * w10 + ref[q2 + 2] * w01 + ref[q2 + 6] * w11) * g2;
      out[i + 3] = 255;
    }
  }
  return out;
}

/** Helligkeitsverhältnis je Farbkanal (Median, unempfindlich gegen Pfeile) */
function channelGains(cur, ref, T, w, h, idx) {
  const step = Math.max(1, Math.floor(idx.length / 4000));
  const hist = [0, 1, 2].map(() => new Uint32Array(400));
  const n = [0, 0, 0];
  for (let k = 0; k < idx.length; k += step) {
    const p = idx[k], t = applyT(T, p % w, (p / w) | 0);
    const x = Math.round(t.x), y = Math.round(t.y);
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    for (let c = 0; c < 3; c++) {
      const r = ref[(y * w + x) * 4 + c], v = cur[p * 4 + c];
      if (r < 60 || r > 245 || v > 250) continue;
      hist[c][Math.min(399, Math.round((v / r) * 200))]++; n[c]++;
    }
  }
  return hist.map((hh, c) => {
    if (n[c] < 200) return 1;
    let acc = 0, i = 0;
    for (; i < 399; i++) { acc += hh[i]; if (acc >= n[c] / 2) break; }
    return Math.min(1.4, Math.max(0.7, i / 200));
  });
}
