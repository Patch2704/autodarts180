// Kalibrierung: Homographie zwischen Scheibenebene (mm) und Kamerabild (normierte Koordinaten 0..1),
// automatische Erkennung über die roten/grünen Ringe, Feinjustierung, Qualitätsmessung und Kamerakontrolle.
import { solveHomography, applyH, mulH, invertH } from './homography.js';
import { R, SEGMENTS, ringColorOf, segmentCenterAngle } from '../core/board.js';

// Kalibrierpunkte: Schnittpunkte der Segmentdrähte mit dem äußeren Doppelring
export const CAL_ANGLES = [81, -9, 261, 171];
export const CAL_LABELS = ['20|1', '6|10', '3|19', '11|14'];

export function calBoardPoints() {
  return CAL_ANGLES.map((a) => {
    const t = (a * Math.PI) / 180;
    return { x: R.DOUBLE_OUT * Math.cos(t), y: R.DOUBLE_OUT * Math.sin(t) };
  });
}

/** Board(mm) → Bild(normiert) */
export function homographyFromPoints(imgPts) {
  return solveHomography(calBoardPoints(), imgPts);
}

export function pointsFromH(H) {
  return calBoardPoints().map((p) => applyH(H, p.x, p.y));
}

export function rotateH(H, deg) {
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  return mulH(H, [c, -s, 0, s, c, 0, 0, 0, 1]);
}

export function scaleH(H, f) {
  return mulH(H, [f, 0, 0, 0, f, 0, 0, 0, 1]);
}

// ---------- Farbe ----------

export function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max ? d / max : 0, max / 255, d];
}

// Rot eng um 0°, damit Magenta/Lila (≈300–330°, z. B. Wände) nicht als Ring zählt
const isRedHue = (h) => h < 22 || h >= 338;
const isGreenHue = (h) => h >= 70 && h < 180;

/** Farbklasse über Farbton und Sättigung – robust gegenüber Helligkeit und Weißabgleich */
export function classifyColor(r, g, b) {
  const [h, s, v, d] = rgbToHsv(r, g, b);
  // sehr dunkle Pixel nie als farbig werten: dort erzeugt Bildrauschen zufällige Farbtöne
  if (s < 0.3 || d < 22 || v < 0.27) return 'neutral';
  if (isRedHue(h)) return 'red';
  if (isGreenHue(h)) return 'green';
  return 'neutral';
}

// ---------- Farbnormalisierung ----------
// „Auto-Tonwert“ je Farbkanal: 1.–99. Perzentil auf 0..255 strecken. Gleicht Farbstich (warmes/kaltes
// Licht), Unter-/Überbelichtung und flauen Kontrast aus, bevor Farben bewertet werden.
const prepared = new WeakSet();
const prepCache = new WeakMap();

function boxBlur(img, r) {
  const { width: w, height: h, data } = img;
  const tmp = new Float32Array(w * h * 3), out = new ImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0, b = 0, c = 0, n = 0;
    for (let k = -r; k <= r; k++) { const xx = Math.min(w - 1, Math.max(0, x + k)); const i = (y * w + xx) * 4; a += data[i]; b += data[i + 1]; c += data[i + 2]; n++; }
    const j = (y * w + x) * 3; tmp[j] = a / n; tmp[j + 1] = b / n; tmp[j + 2] = c / n;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0, b = 0, c = 0, n = 0;
    for (let k = -r; k <= r; k++) { const yy = Math.min(h - 1, Math.max(0, y + k)); const j = (yy * w + x) * 3; a += tmp[j]; b += tmp[j + 1]; c += tmp[j + 2]; n++; }
    const i = (y * w + x) * 4; out.data[i] = a / n; out.data[i + 1] = b / n; out.data[i + 2] = c / n; out.data[i + 3] = 255;
  }
  return out;
}

let normalizeEnabled = true;
export function setNormalize(on) { normalizeEnabled = !!on; }

export function normalizeColors(img) {
  if (!normalizeEnabled || prepared.has(img)) return img;
  if (prepCache.has(img)) return prepCache.get(img);
  const { width: w, height: h, data } = img;
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  const step = Math.max(1, Math.floor((w * h) / 60000));
  let n = 0;
  for (let p = 0; p < w * h; p += step) {
    const i = p * 4;
    hist[0][data[i]]++; hist[1][data[i + 1]]++; hist[2][data[i + 2]]++; n++;
  }
  const pct = (hst, q) => { let acc = 0; const lim = n * q; for (let v = 0; v < 256; v++) { acc += hst[v]; if (acc >= lim) return v; } return 255; };
  // Sehr dunkles/flaues Bild: vor dem Strecken weichzeichnen, sonst wird Rauschen mitverstärkt
  const range = Math.max(pct(hist[0], 0.99) - pct(hist[0], 0.01), pct(hist[1], 0.99) - pct(hist[1], 0.01));
  if (range < 70 && !img.__smoothed) {
    const sm = boxBlur(img, range < 40 ? 2 : 1);
    sm.__smoothed = true;
    const res = normalizeColors(sm);
    prepCache.set(img, res);
    return res;
  }
  const lut = hist.map((hst) => {
    const lo = pct(hst, 0.01), hi = Math.max(pct(hst, 0.99), lo + 24);
    const t = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) t[v] = ((v - lo) * 255) / (hi - lo);
    return t;
  });
  const out = new ImageData(w, h);
  const o = out.data;
  for (let i = 0; i < data.length; i += 4) {
    o[i] = lut[0][data[i]]; o[i + 1] = lut[1][data[i + 1]]; o[i + 2] = lut[2][data[i + 2]]; o[i + 3] = 255;
  }
  // Farbarme Bilder (blasse Kamera, Gegenlicht): Sättigung anheben, bis die kräftigsten
  // Farben (95. Perzentil) wieder deutlich gesättigt sind
  const sats = [];
  for (let p = 0; p < w * h; p += step * 2) {
    const i = p * 4, mx = Math.max(o[i], o[i + 1], o[i + 2]), mn = Math.min(o[i], o[i + 1], o[i + 2]);
    if (mx > 30) sats.push((mx - mn) / mx);
  }
  sats.sort((a, b) => a - b);
  const p95 = sats.length ? sats[Math.floor(sats.length * 0.95)] : 1;
  if (p95 > 0.05 && p95 < 0.6) {
    const k = Math.min(3, 0.65 / p95);
    for (let i = 0; i < o.length; i += 4) {
      const m = (o[i] + o[i + 1] + o[i + 2]) / 3;
      o[i] = m + (o[i] - m) * k; o[i + 1] = m + (o[i + 1] - m) * k; o[i + 2] = m + (o[i + 2] - m) * k;
    }
  }
  prepared.add(out);
  prepCache.set(img, out);
  return out;
}

/** Wie stark ist die Farbe ein gesättigtes Rot/Grün? 0..1 (kontinuierlich, für die Feinjustierung) */
function colorEvidence(rgb, want) {
  const [h, s, v, d] = rgbToHsv(rgb[0], rgb[1], rgb[2]);
  const sat = Math.min(1, Math.max(0, (s - 0.18) / 0.3)) * Math.min(1, Math.max(0, (d - 10) / 25))
    * Math.min(1, Math.max(0, (v * 255 - 45) / 40));
  if (want === 'red') return isRedHue(h) ? sat : 0;
  if (want === 'green') return isGreenHue(h) ? sat : 0;
  return isRedHue(h) || isGreenHue(h) ? sat : 0;
}

function sampleRGB(img, nx, ny, radius = 1) {
  const { width: w, height: h, data } = img;
  const cx = Math.round(nx * w - 0.5), cy = Math.round(ny * h - 0.5);
  let r = 0, g = 0, b = 0, n = 0;
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
    const x = cx + dx, y = cy + dy;
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const i = (y * w + x) * 4;
    r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
  }
  return n ? [r / n, g / n, b / n] : null;
}

// Prüfpunkte: je Segment 3 Winkel; Ringmitten (farbig), Single-Felder und Ränder (ungefärbt)
const PROBES = (() => {
  const out = [];
  for (const seg of SEGMENTS) {
    const want = ringColorOf(seg);
    for (const off of [-5, 0, 5]) {
      const a = ((segmentCenterAngle(seg) + off) * Math.PI) / 180;
      const c = Math.cos(a), s = Math.sin(a);
      for (const r of [103, 166]) out.push({ x: r * c, y: r * s, want, kind: 'ring' });
      for (const r of [40, 75, 94, 112, 135, 157]) out.push({ x: r * c, y: r * s, want: 'neutral', kind: 'single' });
      out.push({ x: 178 * c, y: 178 * s, want: 'neutral', kind: 'outside' });
    }
    // nahe an den Drähten (±7° von der Segmentmitte = 2° vom Draht): legt die Drehung genau fest
    for (const off of [-7, 7]) {
      const a = ((segmentCenterAngle(seg) + off) * Math.PI) / 180;
      for (const r of [103, 166]) out.push({ x: r * Math.cos(a), y: r * Math.sin(a), want, kind: 'ring-edge' });
    }
  }
  for (let k = 0; k < 8; k++) {
    const a = (k * 45 * Math.PI) / 180;
    out.push({ x: 11.1 * Math.cos(a), y: 11.1 * Math.sin(a), want: 'green', kind: 'bull' });
  }
  return out;
})();

// Kantenpunkte knapp innerhalb/außerhalb der Ringkanten (±1,5 mm): machen die Feinjustierung
// millimetergenau (die Ringmitten allein lassen ±4 mm Spielraum). Nur für fitScore.
const EDGE_PROBES = (() => {
  const out = [];
  for (const seg of SEGMENTS) {
    const want = ringColorOf(seg);
    for (const off of [-4, 4]) {
      const a = ((segmentCenterAngle(seg) + off) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
      for (const r of [100.5, 105.5, 163.5, 168.5]) out.push({ x: r * c, y: r * s, want });
      for (const r of [97, 109, 160, 172]) out.push({ x: r * c, y: r * s, want: 'neutral' });
    }
  }
  return out;
})();

// Reduzierte Prüfpunkte (nur Segmentmitten) für die schnelle Grobsuche
const COARSE_PROBES = PROBES.filter((p, i) => p.kind !== 'ring-edge' && (p.kind === 'bull' || i % 3 === 1));

// anyColor = true: Ringe müssen nur farbig sein (rot ODER grün) – unabhängig von der Drehung
function fitScoreCoarse(img, H, radius, anyColor = false) {
  let ring = 0, nRing = 0, neutral = 0, nNeutral = 0;
  for (const p of COARSE_PROBES) {
    const q = applyH(H, p.x, p.y);
    const rgb = sampleRGB(img, q.x, q.y, radius);
    if (p.want === 'neutral') { nNeutral++; if (rgb) neutral += 1 - colorEvidence(rgb, 'any'); }
    else { nRing++; if (rgb) ring += colorEvidence(rgb, anyColor ? 'any' : p.want); }
  }
  return (0.6 * ring) / nRing + (0.4 * neutral) / nNeutral;
}

/**
 * Globale Suche nach dem Ringmuster auf einem verkleinerten Bild: prüft alle Positionen,
 * Größen und Ellipsenformen (seitlicher Blick) auf „Doppel-, Triple-Ring und Bull farbig,
 * Single-Felder und Rand ungefärbt“. Liefert die besten, deutlich verschiedenen Kandidaten als H.
 */
export function globalRingSearch(img, maxCandidates = 4) {
  img = normalizeColors(img);
  const W = img.width, Hh = img.height;
  const sw = 160, scale = sw / W, sh = Math.round(Hh * scale);
  // Farbmaske in kleiner Auflösung (Blockmittel)
  const mask = new Uint8Array(sw * sh);
  const bs = 1 / scale;
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    let r = 0, g = 0, b = 0, n = 0;
    const x0 = Math.floor(x * bs), x1 = Math.min(W, Math.floor((x + 1) * bs)), y0 = Math.floor(y * bs), y1 = Math.min(Hh, Math.floor((y + 1) * bs));
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const i = (yy * W + xx) * 4; r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++; }
    if (!n) continue;
    // tolerant: in kleinen Blöcken mischen sich dünne Ringe mit den Nachbarfeldern
    const [hu, s, vv, dd] = rgbToHsv(r / n, g / n, b / n);
    if (s >= 0.2 && dd >= 14 && vv >= 0.24) mask[y * sw + x] = isRedHue(hu) ? 1 : isGreenHue(hu) ? 2 : 0;
  }
  // Schablone (Einheitskreis, Radius 1 = Doppelring-Außenkante 170 mm).
  // Art: 0 = Doppelring, 1 = Triple-Ring (müssen rot UND grün enthalten), 2 = Bull, -1 = ungefärbt
  const tpl = [];
  for (let k = 0; k < 30; k++) {
    const a = (k * 12 + 3) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    tpl.push([c * 166 / 170, s * 166 / 170, 0], [c * 103 / 170, s * 103 / 170, 1]);
    if (k % 2 === 0) tpl.push([c * 60 / 170, s * 60 / 170, -1], [c * 135 / 170, s * 135 / 170, -1], [c * 190 / 170, s * 190 / 170, -1]);
  }
  for (let k = 0; k < 6; k++) { const a = k * 60 * Math.PI / 180; tpl.push([Math.cos(a) * 11 / 170, Math.sin(a) * 11 / 170, 2]); }
  // flach gespeicherte Schablone (schneller als Objekte/Destrukturierung)
  const TN = tpl.length, TU = new Float32Array(TN), TV = new Float32Array(TN), TK = new Int8Array(TN);
  tpl.forEach(([u, v, k], i) => { TU[i] = u; TV[i] = v; TK[i] = k; });
  const evalAt = (cx, cy, rx, ry) => {
    let r0 = 0, g0 = 0, r1 = 0, g1 = 0, sc = 0;
    for (let i = 0; i < TN; i++) {
      const x = (cx + TU[i] * rx + 0.5) | 0, y = (cy + TV[i] * ry + 0.5) | 0;
      const k = TK[i];
      if (x < 0 || y < 0 || x >= sw || y >= sh) { if (k >= 0) sc -= 0.3; continue; }
      const m = mask[y * sw + x];
      if (!m) continue;
      if (k === -1) sc -= 1;
      else if (k === 2) sc += 1;
      else if (k === 0) { if (m === 1) r0++; else g0++; }
      else if (m === 1) r1++; else g1++;
    }
    // Ringe zählen nur ausgewogen rot/grün (Segmente wechseln ab) – einfarbige Wände punkten nicht
    return sc + 2 * Math.min(r0, g0) + 2 * Math.min(r1, g1);
  };
  const minR = 8, maxR = Math.min(sw, sh) * 0.7;
  // Ellipsenformen: frontal bis stark seitlich (Kamera neben der Scheibe bis ~70° → Breite ≈ cos 70° ≈ 0,34)
  const shapes = [[1, 1], [0.78, 1], [1, 0.78], [0.6, 1], [1, 0.6], [0.46, 1], [0.35, 1]];
  // Kandidaten getrennt nach Formgruppe sammeln (breit/normal und schmal/steil seitlich),
  // damit schmale Fehltreffer die richtigen runden Kandidaten nicht verdrängen und umgekehrt
  const TOP = 40;
  const groups = [{ cands: [], min: 4 }, { cands: [], min: 4 }];
  // Stufe 1: grobes Raster (Schrittweite ≈ r/4)
  for (let r = minR; r <= maxR; r *= 1.1) {
    const st = Math.max(3, Math.round(r / 4));
    for (const [fx, fy] of shapes) {
      const grp = groups[Math.min(fx, fy) < 0.55 ? 1 : 0];
      const rx = r * fx, ry = r * fy;
      for (let cy = Math.round(ry * 0.5); cy < sh - ry * 0.5; cy += st) for (let cx = Math.round(rx * 0.5); cx < sw - rx * 0.5; cx += st) {
        const sc = evalAt(cx, cy, rx, ry);
        if (sc <= grp.min) continue;
        grp.cands.push({ cx, cy, rx, ry, sc, st });
        if (grp.cands.length > TOP * 2) {
          grp.cands.sort((a, b) => b.sc - a.sc);
          grp.cands.length = TOP;
          grp.min = grp.cands[TOP - 1].sc;
        }
      }
    }
  }
  // Stufe 2: um die besten Treffer jeder Gruppe fein nachsuchen (Lage ±Rasterweite, Größe ±5 %)
  for (const grp of groups) {
    grp.cands.sort((a, b) => b.sc - a.sc);
    grp.cands = grp.cands.slice(0, 16).map((c) => {
      let best = c;
      const d = Math.max(1, Math.round(c.st / 3));
      for (let dy = -c.st; dy <= c.st; dy += d) for (let dx = -c.st; dx <= c.st; dx += d) for (const k of [0.95, 1, 1.05]) {
        const rx = c.rx * k, ry = c.ry * k;
        const sc = evalAt(c.cx + dx, c.cy + dy, rx, ry);
        if (sc > best.sc) best = { cx: c.cx + dx, cy: c.cy + dy, rx, ry, sc, st: c.st };
      }
      return best;
    });
  }
  // deutlich verschiedene Kandidaten auswählen: maxCandidates aus der normalen, 2 aus der schmalen Gruppe
  const picked = [];
  const pick = (list, n) => {
    list.sort((a, b) => b.sc - a.sc);
    let k = 0;
    for (const c of list) {
      if (picked.some((p) => Math.hypot(p.cx - c.cx, p.cy - c.cy) < Math.max(p.rx, p.ry) * 0.3 && Math.abs(Math.log(p.rx / c.rx)) < 0.25 && Math.abs(Math.log(p.ry / c.ry)) < 0.25)) continue;
      picked.push(c);
      if (++k >= n) break;
    }
  };
  pick(groups[0].cands, maxCandidates);
  pick(groups[1].cands, 2);
  return picked.map((c) => {
    const pts = CAL_ANGLES.map((deg) => {
      const t = (deg * Math.PI) / 180;
      return { x: (c.cx + Math.cos(t) * c.rx) / sw, y: (c.cy - Math.sin(t) * c.ry) / sh };
    });
    return homographyFromPoints(pts);
  }).filter(Boolean);
}

/** Drehung über den vollen Bereich (Farbmuster wiederholt sich alle 36°) absuchen */
export function rotationSearch(img, H0) {
  img = normalizeColors(img);
  const W = img.width, Hh = img.height;
  const c = applyH(H0, 0, 0), e = applyH(H0, R.DOUBLE_OUT, 0);
  const blur = Math.max(1, Math.min(3, Math.round(Math.hypot((e.x - c.x) * W, (e.y - c.y) * Hh) / 80)));
  let best = H0, bestSc = -1;
  for (let a = 0; a < 36; a += 1.5) {
    const H = rotateH(H0, a);
    const sc = fitScoreCoarse(img, H, blur);
    if (sc > bestSc) { bestSc = sc; best = H; }
  }
  return best;
}

/**
 * Grobsuche: verschiebt und skaliert die geschätzte Scheibe in einem weiten Bereich
 * (±20 % Lage, 75–130 % Größe) und nimmt die beste Übereinstimmung. Damit ist die
 * Feinjustierung nicht mehr auf eine sehr gute Erstschätzung angewiesen.
 */
export function coarseSearch(img, H0, withAniso = false) {
  img = normalizeColors(img);
  const W = img.width, Hh = img.height;
  const c = applyH(H0, 0, 0);
  const e = applyH(H0, R.DOUBLE_OUT, 0);
  const rad = Math.hypot((e.x - c.x) * W, (e.y - c.y) * Hh); // Doppelring-Radius in px
  const blur = Math.max(1, Math.min(4, Math.round(rad / 60)));
  const transform = (tx, ty, s, ax = 1) => mulH([
    s * ax, 0, c.x * (1 - s * ax) + tx,
    0, s, c.y * (1 - s) + ty,
    0, 0, 1,
  ], H0);
  let best = { H: H0, score: fitScoreCoarse(img, H0, blur, true) };
  const span = 0.2 * rad;
  // zweistufig: grob (7×7×5), dann um das beste Ergebnis enger (5×5×3)
  // Größen bis 0,6× / 1,7×: Triple- und Doppelring haben dasselbe Farbmuster (Radien 103/166 mm),
  // eine Verwechslung muss deshalb immer mitgeprüft werden.
  const passes = [[span, 3, [0.6, 0.68, 0.77, 0.87, 1, 1.15, 1.3, 1.48, 1.68]], [span / 3, 2, [0.94, 1, 1.06]]];
  let base = { tx: 0, ty: 0, s: 1 };
  for (const [sp, n, scales] of passes) {
    let localBest = null;
    for (let iy = -n; iy <= n; iy++) for (let ix = -n; ix <= n; ix++) for (const sf of scales) {
      const tx = base.tx + (ix * sp) / n / W, ty = base.ty + (iy * sp) / n / Hh, s = base.s * sf;
      const H = transform(tx, ty, s);
      const sc = fitScoreCoarse(img, H, blur, true);
      if (!localBest || sc > localBest.score) localBest = { H, score: sc, tx, ty, s };
    }
    if (localBest.score > best.score) best = localBest;
    base = { tx: localBest.tx, ty: localBest.ty, s: localBest.s };
  }
  const iso = best.H;
  if (!withAniso) return iso;
  // Breite getrennt anpassen (seitlicher Blick: Scheibe im Bild schmaler als hoch), dann Lage nachziehen
  let ax = 1;
  for (const [sp, n, axes] of [[span / 4, 1, [0.6, 0.72, 0.85, 1, 1.18, 1.4, 1.65]], [span / 8, 1, [0.93, 1, 1.07]]]) {
    let localBest = null;
    for (let iy = -n; iy <= n; iy++) for (let ix = -n; ix <= n; ix++) for (const af of axes) {
      const tx = base.tx + (ix * sp) / W, ty = base.ty + (iy * sp) / Hh, a = ax * af;
      const H = transform(tx, ty, base.s, a);
      const sc = fitScoreCoarse(img, H, blur, true);
      if (!localBest || sc > localBest.score) localBest = { H, score: sc, tx, ty, a };
    }
    if (localBest.score > best.score) best = localBest;
    base = { tx: localBest.tx, ty: localBest.ty, s: base.s };
    ax = localBest.a;
  }
  // Beide Varianten zurückgeben – welche besser ist, entscheidet die farbgenaue Bewertung danach
  return best.H === iso ? [iso] : [iso, best.H];
}

/** Kontinuierliche Übereinstimmung (0..1) zwischen Bild und projizierter Scheibe */
export function fitScore(img, H, radius = 0) {
  img = normalizeColors(img);
  let ring = 0, nRing = 0, neutral = 0, nNeutral = 0;
  for (const p of PROBES) {
    const q = applyH(H, p.x, p.y);
    const rgb = sampleRGB(img, q.x, q.y, radius);
    if (!rgb) { if (p.want === 'neutral') nNeutral++; else nRing++; continue; }
    if (p.want === 'neutral') { neutral += 1 - colorEvidence(rgb, 'any'); nNeutral++; }
    else { ring += colorEvidence(rgb, p.want); nRing++; }
  }
  let edge = 0;
  for (const p of EDGE_PROBES) {
    const q = applyH(H, p.x, p.y);
    const rgb = sampleRGB(img, q.x, q.y, radius);
    if (!rgb) continue;
    edge += p.want === 'neutral' ? 1 - colorEvidence(rgb, 'any') : colorEvidence(rgb, p.want);
  }
  // Ringe legen Lage, Größe und Drehung fest; Kantenpunkte machen es millimetergenau
  return (0.45 * ring) / nRing + (0.3 * neutral) / nNeutral + (0.25 * edge) / EDGE_PROBES.length;
}

/**
 * Qualität (0..1): Anteil der Prüfpunkte, deren Farbklasse zur Kalibrierung passt.
 * ringScore = Anteil korrekt farbiger Ringpunkte, singleScore = Anteil ungefärbter Single-Punkte.
 */
export function calibrationQuality(img, H) {
  img = normalizeColors(img);
  let ok = 0, total = 0, ringOk = 0, ringN = 0, singleOk = 0, singleN = 0;
  for (const p of PROBES) {
    const q = applyH(H, p.x, p.y);
    const rgb = sampleRGB(img, q.x, q.y, 1);
    total++;
    if (p.want === 'neutral') singleN++; else ringN++;
    if (!rgb) continue;
    const c = classifyColor(rgb[0], rgb[1], rgb[2]);
    if (c === p.want) {
      ok++;
      if (p.want === 'neutral') singleOk++; else ringOk++;
    }
  }
  return { score: ok / total, ringScore: ringOk / ringN, singleScore: singleOk / singleN };
}

// ---------- Automatische Erkennung ----------

/**
 * Erstschätzung: Schwerpunkt und Kovarianz aller roten/grünen Pixel ergeben eine Ellipse.
 * Die Drehung wird mit „20 oben“ angenommen. Liefert 4 normierte Punkte oder null.
 */
export function autoGuess(img) {
  img = normalizeColors(img);
  const { width: w, height: h, data } = img;
  // 1) Blockmittelwerte (reduziert Rauschen), Farbklasse pro Block: 1 = rot, 2 = grün
  const step = Math.max(1, Math.round(w / 320));
  const bw = Math.floor(w / step), bh = Math.floor(h / step);
  const colored = new Uint8Array(bw * bh);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    let r = 0, g = 0, b = 0;
    for (let y = by * step; y < (by + 1) * step; y++) for (let x = bx * step; x < (bx + 1) * step; x++) {
      const i = (y * w + x) * 4; r += data[i]; g += data[i + 1]; b += data[i + 2];
    }
    const n = step * step;
    const c = classifyColor(r / n, g / n, b / n);
    if (c !== 'neutral') colored[by * bw + bx] = c === 'red' ? 1 : 2;
  }
  // 2) Grobes Raster: Zellen mit dichter Färbung zu Clustern verbinden
  const C = 8, cw = Math.ceil(bw / C), ch = Math.ceil(bh / C);
  const fracR = new Float32Array(cw * ch), fracG = new Float32Array(cw * ch);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    const v = colored[by * bw + bx];
    if (!v) continue;
    const ci = ((by / C) | 0) * cw + ((bx / C) | 0);
    if (v === 1) fracR[ci] += 1 / (C * C); else fracG[ci] += 1 / (C * C);
  }
  const frac = (i) => fracR[i] + fracG[i];
  const label = new Int32Array(cw * ch).fill(-1);
  const comps = [];
  for (let i = 0; i < cw * ch; i++) {
    if (frac(i) < 0.1 || label[i] >= 0) continue;
    const comp = { id: comps.length, red: 0, green: 0, x0: cw, y0: ch, x1: -1, y1: -1 };
    const stack = [i]; label[i] = comp.id;
    while (stack.length) {
      const c = stack.pop();
      comp.red += fracR[c]; comp.green += fracG[c];
      const cx = c % cw, cy = (c / cw) | 0;
      comp.x0 = Math.min(comp.x0, cx); comp.x1 = Math.max(comp.x1, cx); comp.y0 = Math.min(comp.y0, cy); comp.y1 = Math.max(comp.y1, cy);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= cw || y >= ch) continue;
        const q = y * cw + x;
        if (frac(q) >= 0.1 && label[q] < 0) { label[q] = comp.id; stack.push(q); }
      }
    }
    comps.push(comp);
  }
  // Die Scheibe hat rote UND grüne Ringe – einfarbige Flächen (Wand, Kleidung, Licht) scheiden aus.
  // Bewertet wird die kleinere der beiden Farbmengen, zusammen mit allen Clustern innerhalb des Rahmens.
  const inside = (a, b) => a.x0 >= b.x0 - 1 && a.x1 <= b.x1 + 1 && a.y0 >= b.y0 - 1 && a.y1 <= b.y1 + 1;
  let best = null, bestScore = 0;
  for (const c of comps) {
    let red = 0, green = 0;
    for (const o of comps) if (o === c || inside(o, c)) { red += o.red; green += o.green; }
    // Ringsegmente wechseln rot/grün ab → ausgewogene Mengen. Eine rote Wand (mit der Scheibe darin)
    // hätte viel mehr Rot als Grün und wird dadurch abgewertet.
    const lo = Math.min(red, green), hi = Math.max(red, green);
    const sc = hi ? lo * (lo / hi) : 0;
    if (sc > bestScore) { bestScore = sc; best = c; }
  }
  if (!best) return null;
  // Liegt der gewählte Bereich in einem größeren, ebenfalls ausgewogenen Bereich (Triple-Ring im
  // Doppelring), den äußeren nehmen – er bestimmt die Größe der Scheibe.
  for (let guard = 0; guard < 4; guard++) {
    const outer = comps.find((o) => o !== best && inside(best, o) && (o.x1 - o.x0) > (best.x1 - best.x0));
    if (!outer) break;
    let red = 0, green = 0;
    for (const o of comps) if (o === outer || inside(o, outer)) { red += o.red; green += o.green; }
    if (Math.min(red, green) / Math.max(red, green) < 0.4) break;
    best = outer;
  }
  const keepComp = new Set(comps.filter((o) => o === best || inside(o, best)).map((o) => o.id));
  const keep = new Uint8Array(cw * ch);
  for (let i = 0; i < cw * ch; i++) {
    if (!keepComp.has(label[i])) continue;
    const cx = i % cw, cy = (i / cw) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x >= 0 && y >= 0 && x < cw && y < ch) keep[y * cw + x] = 1;
    }
  }
  let pts = [];
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    if (colored[by * bw + bx] && keep[((by / C) | 0) * cw + ((bx / C) | 0)]) pts.push((bx + 0.5) * step, (by + 0.5) * step);
  }
  const minPts = 40;
  if (pts.length / 2 < minPts) return null;
  let stats = null;
  for (let iter = 0; iter < 4; iter++) {
    stats = moments(pts);
    if (!stats) return null;
    const { mx, my, inv } = stats;
    const kept = [];
    for (let k = 0; k < pts.length; k += 2) {
      const dx = pts[k] - mx, dy = pts[k + 1] - my;
      const d2 = dx * (inv[0] * dx + inv[1] * dy) + dy * (inv[2] * dx + inv[3] * dy);
      if (d2 < 4.5) kept.push(pts[k], pts[k + 1]);
    }
    if (kept.length / 2 < minPts) break;
    pts = kept;
  }
  const { mx, my, cxx, cxy, cyy } = stats;
  const RMS = 141.2; // effektiver RMS-Radius der farbigen Flächen in mm
  const tr = cxx + cyy, det = cxx * cyy - cxy * cxy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
  if (l2 <= 0) return null;
  let v1 = Math.abs(cxy) > 1e-9 ? [l1 - cyy, cxy] : (cxx >= cyy ? [1, 0] : [0, 1]);
  const n1 = Math.hypot(v1[0], v1[1]);
  v1 = [v1[0] / n1, v1[1] / n1];
  const v2 = [-v1[1], v1[0]];
  const s1 = Math.sqrt(2 * l1) / RMS, s2 = Math.sqrt(2 * l2) / RMS;
  const S = [
    s1 * v1[0] * v1[0] + s2 * v2[0] * v2[0], s1 * v1[0] * v1[1] + s2 * v2[0] * v2[1],
    s1 * v1[1] * v1[0] + s2 * v2[1] * v2[0], s1 * v1[1] * v1[1] + s2 * v2[1] * v2[1],
  ];
  return calBoardPoints().map((p) => {
    const bx = p.x, by = -p.y;
    return { x: (mx + S[0] * bx + S[1] * by) / w, y: (my + S[2] * bx + S[3] * by) / h };
  });
}

function moments(pts) {
  const n = pts.length / 2;
  if (n < 10) return null;
  let mx = 0, my = 0;
  for (let k = 0; k < pts.length; k += 2) { mx += pts[k]; my += pts[k + 1]; }
  mx /= n; my /= n;
  let cxx = 0, cxy = 0, cyy = 0;
  for (let k = 0; k < pts.length; k += 2) {
    const dx = pts[k] - mx, dy = pts[k + 1] - my;
    cxx += dx * dx; cxy += dx * dy; cyy += dy * dy;
  }
  cxx /= n; cxy /= n; cyy /= n;
  const det = cxx * cyy - cxy * cxy;
  if (det <= 0) return null;
  return { mx, my, cxx, cxy, cyy, inv: [cyy / det, -cxy / det, -cxy / det, cxx / det] };
}

/**
 * Feinjustierung: verschiebt die 4 Kalibrierpunkte (und global Lage/Größe/Drehung),
 * bis die projizierte Scheibe bestmöglich zu den Farben im Bild passt.
 * points: normierte Punkte; liefert { points, H, score }.
 */
export function refine(img, points, { maxMs = 1500, rotationScan = 12 } = {}) {
  img = normalizeColors(img);
  const t0 = performance.now();
  const W = img.width, Hh = img.height;
  let pts = points.map((p) => ({ x: p.x * W, y: p.y * Hh }));
  const toH = (pp) => homographyFromPoints(pp.map((p) => ({ x: p.x / W, y: p.y / Hh })));
  // Abtastradius: grob = große Mittelungsfläche (glatte Zielfunktion), fein = 3x3
  let rad = 1;
  const score = (pp) => { const H = toH(pp); return H ? fitScore(img, H, rad) : -1; };
  // Drehung in der Scheibenebene (um das Bull) – verschiebt die Segmentgrenzen, ohne Ringe zu verändern
  const rotPts = (pp, deg) => {
    const H = toH(pp);
    if (!H) return pp;
    return pointsFromH(rotateH(H, deg)).map((p) => ({ x: p.x * W, y: p.y * Hh }));
  };
  let best = score(pts);
  if (rotationScan) {
    let bestRot = pts;
    for (let a = -rotationScan; a <= rotationScan; a += 1) {
      if (!a) continue;
      const cand = rotPts(pts, a);
      const sc = score(cand);
      if (sc > best + 0.01) { best = sc; bestRot = cand; }
    }
    pts = bestRot;
    best = score(pts);
  }
  const span = Math.hypot(pts[0].x - pts[2].x, pts[0].y - pts[2].y);
  const steps = [span * 0.04, span * 0.02, span * 0.01, span * 0.005, span * 0.0025, span * 0.00125].filter((s) => s >= 0.2);
  const cx = () => pts.reduce((a, p) => a + p.x, 0) / 4, cy = () => pts.reduce((a, p) => a + p.y, 0) / 4;
  const moves = (st) => {
    const out = [];
    for (let i = 0; i < 4; i++) for (const [dx, dy] of [[st, 0], [-st, 0], [0, st], [0, -st]]) {
      out.push(pts.map((p, k) => (k === i ? { x: p.x + dx, y: p.y + dy } : p)));
    }
    for (const [dx, dy] of [[st, 0], [-st, 0], [0, st], [0, -st]]) out.push(pts.map((p) => ({ x: p.x + dx, y: p.y + dy })));
    const mx = cx(), my = cy(), f = st / span;
    for (const s of [1 + f, 1 - f]) out.push(pts.map((p) => ({ x: mx + (p.x - mx) * s, y: my + (p.y - my) * s })));
    for (const a of [f, -f]) {
      const c = Math.cos(a), s = Math.sin(a);
      out.push(pts.map((p) => ({ x: mx + (p.x - mx) * c - (p.y - my) * s, y: my + (p.x - mx) * s + (p.y - my) * c })));
    }
    // Drehung in der Scheibenebene, Schrittweite passend zur Pixel-Schrittweite
    const deg = Math.max(0.15, (f * 180) / Math.PI);
    out.push(rotPts(pts, deg), rotPts(pts, -deg));
    // Streckung entlang der Bildachsen (falls die Ellipse in einer Richtung nicht passt)
    for (const [sx, sy] of [[1 + f, 1], [1 - f, 1], [1, 1 + f], [1, 1 - f]]) {
      out.push(pts.map((p) => ({ x: mx + (p.x - mx) * sx, y: my + (p.y - my) * sy })));
    }
    return out;
  };
  for (const st of steps) {
    const newRad = Math.max(1, Math.min(4, Math.round(st / 2)));
    if (newRad !== rad) { rad = newRad; best = score(pts); }
    let improved = true, guard = 0;
    while (improved && guard++ < 40) {
      improved = false;
      for (const cand of moves(st)) {
        const sc = score(cand);
        if (sc > best + 1e-6) { best = sc; pts = cand; improved = true; }
      }
      if (performance.now() - t0 > maxMs) break;
    }
    if (performance.now() - t0 > maxMs) break;
  }
  const out = pts.map((p) => ({ x: p.x / W, y: p.y / Hh }));
  const Hout = homographyFromPoints(out);
  return { points: out, H: Hout, score: Hout ? fitScore(img, Hout, 1) : -1 };
}

/**
 * Vollautomatisch: Erstschätzung (Farbcluster) → Grobsuche Lage/Größe (farbunabhängig) →
 * Drehungssuche (volle 36°) → Feinjustierung → Wahl der 36°-Variante mit der 20 oben.
 */
export function autoCalibrate(img) {
  img = normalizeColors(img);
  // Startkandidaten: globale Ringsuche + Farbschwerpunkt
  const starts = globalRingSearch(img, 3);
  const g = autoGuess(img);
  if (g) { const Hg = homographyFromPoints(g); if (Hg) starts.push(Hg); }
  if (!starts.length) return null;
  // Jeden Kandidaten grob ausrichten (schnell), nur den besten fein justieren
  const W = img.width, Hh = img.height;
  const coarse = starts.flatMap((Hs) => coarseSearch(img, Hs, true)).map((Hc) => {
    const H0 = rotationSearch(img, Hc);
    const c = applyH(H0, 0, 0), e = applyH(H0, R.DOUBLE_OUT, 0);
    const blur = Math.max(1, Math.min(3, Math.round(Math.hypot((e.x - c.x) * W, (e.y - c.y) * Hh) / 80)));
    return { H0, score: fitScoreCoarse(img, H0, blur) };
  }).sort((a, b) => b.score - a.score);
  let best = null;
  for (const { H0 } of coarse.slice(0, 3)) {
    let r = refine(img, pointsFromH(H0), { maxMs: 600, rotationScan: 3 });
    if (r.score < 0.85) {
      const alt = refine(img, pointsFromH(rotateH(H0, 18)), { maxMs: 300, rotationScan: 3 });
      if (alt.score > r.score) r = alt;
    }
    if (r?.H && (!best || r.score > best.score)) best = r;
    if (best && calibrationQuality(img, best.H).score > 0.93) break; // eindeutig gefunden
  }
  if (!best?.H) return null;
  // Gegenprobe Ring-Verwechslung: Triple- und Doppelring haben dasselbe Farbmuster.
  if (calibrationQuality(img, best.H).score < 0.9) {
    for (const f of [103 / 166, 166 / 103]) {
      const r = refine(img, pointsFromH(scaleH(best.H, f)), { maxMs: 500, rotationScan: 3 });
      if (r?.H && r.score > best.score) best = r;
    }
  }
  // Farben wiederholen sich alle 36° → unter den gleichwertigen Drehungen die nehmen,
  // bei der die 20 im Bild senkrecht über dem Bull liegt (Handy steht aufrecht).
  let bestH = best.H, bestDev = Infinity;
  for (let k = 0; k < 10; k++) {
    const Hk = rotateH(best.H, k * 36);
    const dev = upDeviation(Hk, img.width, img.height);
    if (dev < bestDev) { bestDev = dev; bestH = Hk; }
  }
  return { points: pointsFromH(bestH), H: bestH, score: best.score, upDeviation: bestDev };
}

/**
 * „Feinjustieren“: verbessert die aktuellen Punkte und vergleicht mit der Auto-Erkennung.
 * Von der Auto-Erkennung wird die 36°-Variante genommen, die den aktuellen Punkten am nächsten ist,
 * damit eine bewusst gewählte Drehung erhalten bleibt.
 */
export function refineOrAuto(img, points) {
  img = normalizeColors(img);
  const local = refine(img, points);
  if (local.H && calibrationQuality(img, local.H).score >= 0.95) return local;
  const auto = autoCalibrate(img);
  if (!auto) return local;
  let bestPts = auto.points, bestD = Infinity;
  for (let k = 0; k < 10; k++) {
    const pk = pointsFromH(rotateH(auto.H, k * 36));
    const d = pk.reduce((a, p, i) => a + Math.hypot((p.x - points[i].x) * img.width, (p.y - points[i].y) * img.height), 0);
    if (d < bestD) { bestD = d; bestPts = pk; }
  }
  const Ha = homographyFromPoints(bestPts);
  const autoScore = fitScore(img, Ha, 1);
  return autoScore > local.score + 0.005 ? { points: bestPts, H: Ha, score: autoScore } : local;
}

/** Größte Verschiebung (mm auf der Scheibe) zwischen zwei Kalibrierungen */
export function boardShiftMm(H1, H2) {
  const Hi = invertH(H2);
  let max = 0;
  for (const r of [16, 103, 170]) for (let k = 0; k < 12; k++) {
    const t = (k * 30 * Math.PI) / 180, bx = r * Math.cos(t), by = r * Math.sin(t);
    const q = applyH(H1, bx, by), b = applyH(Hi, q.x, q.y);
    max = Math.max(max, Math.hypot(b.x - bx, b.y - by));
  }
  return max;
}

/** Winkelabweichung (Grad) zwischen „Bull → 20“ im Bild und der Bild-Senkrechten */
export function upDeviation(H, w = 16, h = 9) {
  const c = applyH(H, 0, 0), t = applyH(H, 0, 120);
  const dx = (t.x - c.x) * w, dy = (t.y - c.y) * h;
  return Math.abs((Math.atan2(dx, -dy) * 180) / Math.PI);
}

// ---------- Bildausschnitt um die Scheibe ----------

/** Rechteck (normiert) um die Scheibe inkl. Rand für herausragende Pfeile */
export function boardCrop(H, radiusMm = 290) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let k = 0; k < 48; k++) {
    const t = (k * 7.5 * Math.PI) / 180;
    const p = applyH(H, radiusMm * Math.cos(t), radiusMm * Math.sin(t));
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(1, x1); y1 = Math.min(1, y1);
  if (!(x1 > x0 && y1 > y0)) return { x: 0, y: 0, w: 1, h: 1 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** H (Board → Vollbild normiert) → H (Board → Ausschnitt normiert) */
export function cropH(H, c) {
  return mulH([1 / c.w, 0, -c.x / c.w, 0, 1 / c.h, -c.y / c.h, 0, 0, 1], H);
}

/** Umkehrung von cropH: H (Board → Ausschnitt normiert) → H (Board → Vollbild normiert) */
export function uncropH(Hc, c) {
  return mulH([c.w, 0, c.x, 0, c.h, c.y, 0, 0, 1], Hc);
}

export function uncropPoint(p, c) {
  return { x: c.x + p.x * c.w, y: c.y + p.y * c.h };
}

// ---------- Kamerakontrolle ----------

/** Anteil des äußeren Doppelrings, der im Bild liegt (1 = vollständig sichtbar) */
export function boardVisibility(H) {
  let inside = 0;
  for (let k = 0; k < 72; k++) {
    const t = (k * 5 * Math.PI) / 180;
    const p = applyH(H, R.DOUBLE_OUT * Math.cos(t), R.DOUBLE_OUT * Math.sin(t));
    if (p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1) inside++;
  }
  return inside / 72;
}

/** Helligkeit (0..255) und Schärfe (Varianz des Laplace-Operators) */
export function frameMetrics(img) {
  const { width: w, height: h, data } = img;
  let sum = 0, n = 0, lapSum = 0, lapSq = 0, ln = 0;
  const lum = (x, y) => { const i = (y * w + x) * 4; return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; };
  for (let y = 2; y < h - 2; y += 3) for (let x = 2; x < w - 2; x += 3) {
    const c = lum(x, y);
    sum += c; n++;
    const lap = lum(x - 1, y) + lum(x + 1, y) + lum(x, y - 1) + lum(x, y + 1) - 4 * c;
    lapSum += lap; lapSq += lap * lap; ln++;
  }
  const mean = lapSum / ln;
  return { brightness: sum / n, sharpness: lapSq / ln - mean * mean };
}

/**
 * Kamerakontrolle während des Spiels. img und H müssen zum selben Bildausschnitt gehören.
 * ref = Werte bei der Kalibrierung ({ quality, brightness }).
 */
export function healthCheck(img, H, ref = {}) {
  const warnings = [];
  const q = calibrationQuality(img, H);
  const m = frameMetrics(img);
  const vis = boardVisibility(H);
  if (vis < 0.98) warnings.push({ code: 'visibility', text: 'Die Dartscheibe ist nicht vollständig im Bild.' });
  if (ref.quality != null && q.score < ref.quality - 0.12) {
    warnings.push({ code: 'moved', text: `Die Scheibe passt nicht mehr genau zur Kalibrierung (Übereinstimmung jetzt ${Math.round(q.score * 100)} %, beim Kalibrieren ${Math.round(ref.quality * 100)} %).` });
  }
  if (ref.brightness && Math.abs(m.brightness - ref.brightness) / ref.brightness > 0.35) {
    warnings.push({ code: 'light', text: 'Die Beleuchtung hat sich stark verändert.' });
  }
  if (m.sharpness < 8) warnings.push({ code: 'blur', text: 'Das Kamerabild ist unscharf oder zu dunkel für eine zuverlässige Erkennung.' });
  return { warnings, quality: q.score, metrics: m };
}
