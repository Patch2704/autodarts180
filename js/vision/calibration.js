// Kalibrierung: Homographie zwischen Scheibenebene (mm) und Kamerabild (normierte Koordinaten 0..1),
// automatische Erkennung über die roten/grünen Ringe, Feinjustierung, Qualitätsmessung und Kamerakontrolle.
import { solveHomography, applyH, mulH } from './homography.js';
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
  const [h, s, , d] = rgbToHsv(r, g, b);
  if (s < 0.3 || d < 18) return 'neutral';
  if (isRedHue(h)) return 'red';
  if (isGreenHue(h)) return 'green';
  return 'neutral';
}

/** Wie stark ist die Farbe ein gesättigtes Rot/Grün? 0..1 (kontinuierlich, für die Feinjustierung) */
function colorEvidence(rgb, want) {
  const [h, s, , d] = rgbToHsv(rgb[0], rgb[1], rgb[2]);
  const sat = Math.min(1, Math.max(0, (s - 0.18) / 0.3)) * Math.min(1, Math.max(0, (d - 8) / 25));
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

/** Kontinuierliche Übereinstimmung (0..1) zwischen Bild und projizierter Scheibe */
export function fitScore(img, H, radius = 0) {
  let ring = 0, nRing = 0, neutral = 0, nNeutral = 0;
  for (const p of PROBES) {
    const q = applyH(H, p.x, p.y);
    const rgb = sampleRGB(img, q.x, q.y, radius);
    if (!rgb) { if (p.want === 'neutral') nNeutral++; else nRing++; continue; }
    if (p.want === 'neutral') { neutral += 1 - colorEvidence(rgb, 'any'); nNeutral++; }
    else { ring += colorEvidence(rgb, p.want); nRing++; }
  }
  // Ringe zählen stärker: sie legen Lage, Größe und Drehung fest
  return (0.6 * ring) / nRing + (0.4 * neutral) / nNeutral;
}

/**
 * Qualität (0..1): Anteil der Prüfpunkte, deren Farbklasse zur Kalibrierung passt.
 * ringScore = Anteil korrekt farbiger Ringpunkte, singleScore = Anteil ungefärbter Single-Punkte.
 */
export function calibrationQuality(img, H) {
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
  const { width: w, height: h, data } = img;
  // 1) Blockmittelwerte (reduziert Rauschen), Farbklasse pro Block
  const step = Math.max(1, Math.round(w / 320));
  const bw = Math.floor(w / step), bh = Math.floor(h / step);
  const colored = new Uint8Array(bw * bh);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    let r = 0, g = 0, b = 0;
    for (let y = by * step; y < (by + 1) * step; y++) for (let x = bx * step; x < (bx + 1) * step; x++) {
      const i = (y * w + x) * 4; r += data[i]; g += data[i + 1]; b += data[i + 2];
    }
    const n = step * step;
    if (classifyColor(r / n, g / n, b / n) !== 'neutral') colored[by * bw + bx] = 1;
  }
  // 2) Grobes Raster: nur Zellen mit dichter Färbung, größter zusammenhängender Cluster = Scheibe
  const C = 8, cw = Math.ceil(bw / C), ch = Math.ceil(bh / C);
  const frac = new Float32Array(cw * ch);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) if (colored[by * bw + bx]) frac[((by / C) | 0) * cw + ((bx / C) | 0)] += 1 / (C * C);
  const label = new Int32Array(cw * ch).fill(-1);
  let bestLabel = -1, bestMass = 0, nl = 0;
  for (let i = 0; i < cw * ch; i++) {
    if (frac[i] < 0.1 || label[i] >= 0) continue;
    let mass = 0;
    const stack = [i]; label[i] = nl;
    while (stack.length) {
      const c = stack.pop(); mass += frac[c];
      const cx = c % cw, cy = (c / cw) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= cw || y >= ch) continue;
        const q = y * cw + x;
        if (frac[q] >= 0.1 && label[q] < 0) { label[q] = nl; stack.push(q); }
      }
    }
    if (mass > bestMass) { bestMass = mass; bestLabel = nl; }
    nl++;
  }
  if (bestLabel < 0) return null;
  // Alles innerhalb des Rechtecks um den größten Cluster gehört zur Scheibe (bei großen Scheiben
  // sind Doppelring, Triple-Ring und Bull getrennte Cluster), plus eine Zelle Rand.
  let bx0 = cw, by0 = ch, bx1 = -1, by1 = -1;
  for (let i = 0; i < cw * ch; i++) {
    if (label[i] !== bestLabel) continue;
    const cx = i % cw, cy = (i / cw) | 0;
    if (cx < bx0) bx0 = cx; if (cx > bx1) bx1 = cx; if (cy < by0) by0 = cy; if (cy > by1) by1 = cy;
  }
  const keep = new Uint8Array(cw * ch);
  for (let y = Math.max(0, by0 - 1); y <= Math.min(ch - 1, by1 + 1); y++) {
    for (let x = Math.max(0, bx0 - 1); x <= Math.min(cw - 1, bx1 + 1); x++) keep[y * cw + x] = 1;
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
  const steps = [span * 0.04, span * 0.02, span * 0.01, span * 0.005, span * 0.0025].filter((s) => s >= 0.3);
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
 * Vollautomatisch: Erstschätzung, dann Feinjustierung für die Drehungen 0°, ±18°.
 * (Rot/Grün wiederholt sich alle 36° – „20 oben“ bleibt die Annahme.)
 */
export function autoCalibrate(img) {
  const g = autoGuess(img);
  if (!g) return null;
  const H0 = homographyFromPoints(g);
  if (!H0) return null;
  let best = null;
  for (const rot of [0, 18, -18]) {
    const pts = pointsFromH(rotateH(H0, rot));
    const r = refine(img, pts, { maxMs: 900 });
    if (r.H && (!best || r.score > best.score)) best = r;
  }
  if (!best) return null;
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
  const local = refine(img, points);
  if (local.score >= 0.9) return local;
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
  if (ref.quality != null && q.score < ref.quality - 0.2) {
    warnings.push({ code: 'moved', text: 'Die Kamera scheint verrutscht zu sein – die Scheibe passt nicht mehr zur Kalibrierung.' });
  }
  if (ref.brightness && Math.abs(m.brightness - ref.brightness) / ref.brightness > 0.35) {
    warnings.push({ code: 'light', text: 'Die Beleuchtung hat sich stark verändert.' });
  }
  if (m.sharpness < 8) warnings.push({ code: 'blur', text: 'Das Kamerabild ist unscharf oder zu dunkel für eine zuverlässige Erkennung.' });
  return { warnings, quality: q.score, metrics: m };
}
