// Dartpfeil-Erkennung per Bildvergleich (klassische Bildverarbeitung, läuft komplett lokal).
// Ablauf: Bewegung abwarten → ruhiges Bild mit Referenz vergleichen → Veränderungsregion
// segmentieren → Pfeilachse per Hauptkomponentenanalyse → Spitze am schmalen Ende →
// Homographie auf Scheibenebene → Segment. Unsichere Ergebnisse werden als solche gemeldet.
import { applyH, invertH } from './homography.js';
import { estimateTransform, warpRef, applyT, luminance, IDENTITY } from './align.js';
import { scoreAt } from '../core/board.js';

const DEFAULTS = {
  diffThreshold: 28, // mittlere RGB-Differenz pro Pixel (nach 3x3-Glättung), Obergrenze
  minDiffThreshold: 13, // Untergrenze bei sehr rauscharmem Bild (Schwelle passt sich dem Rauschen an; Bilder sind vorher geglättet)
  motionFraction: 0.0015, // Anteil veränderter Scheiben-Pixel (ohne Kantenwackeln), ab dem "Bewegung" gilt
  stableFrames: 5, // so viele ruhige Frames in Folge, bevor ausgewertet wird
  minDartFraction: 0.0005, // minimale Pfeilfläche relativ zur ROI (dunkler Pfeil vor dunklem Grund ist klein)
  smallDartFraction: 0.0012, // darunter muss die Form deutlich länglich sein (sonst kein Pfeil)
  maxDartFraction: 0.07, // größer = Hand/Person/Lichtwechsel
  edgeTolerance: 0.3, // so weit (px) dürfen Kanten gegenüber der ausgerichteten Referenz verrutschen
  minUnexplained: 0.1, // so viel einer Veränderung darf kein Kantenrest (minimal verschobene/anders scharfe Kante) sein
  tipExtend: 1.0, // Korrektur der Spitzenposition, falls die Spitze nicht weiter verfolgt werden kann (px)
  tipRadiusMm: 1.0, // halbe Dicke der Stahlspitze: so weit reicht ihr sichtbares Ende über den Einstich hinaus
  tipBlurPx: 0.4, // Unschärfe/Glättung am Spitzenende (px)
};

const MAX_SHIFT = 3; // maximal ausgeglichene Bildverschiebung (px) durch Wackeln des Stativs

/**
 * Kameramodell aus der Kalibrierung (Lochkamera, quadratische Pixel, Bildmitte bekannt).
 * Pfeile stecken ungefähr senkrecht in der Scheibe; mit dem Modell lässt sich vorhersagen,
 * in welche Richtung ein Pfeil im Bild von seiner Spitze aus „herausragt“.
 * Hpx: Board(mm) → Pixel; cx, cy: Mitte des Vollbilds (px); size: größere Vollbild-Seite (px).
 */
export function estimateCamera(Hpx, cx, cy, size) {
  const [a, b, c, d, e, f, g, h, i] = [Hpx[0] - cx * Hpx[6], Hpx[1] - cx * Hpx[7], Hpx[2] - cx * Hpx[8],
    Hpx[3] - cy * Hpx[6], Hpx[4] - cy * Hpx[7], Hpx[5] - cy * Hpx[8], Hpx[6], Hpx[7], Hpx[8]];
  // Bedingungen r1 ⟂ r2 und |r1| = |r2| → 1/f² (kleinste Quadrate)
  const eqs = [[a * b + d * e, g * h], [a * a + d * d - b * b - e * e, g * g - h * h]];
  let num = 0, den = 0;
  for (const [p, q] of eqs) { num += p * q; den += p * p; }
  const fallback = 0.85 * size; // typische Handy-Hauptkamera
  const persp = (Math.hypot(g, h) * 225) / Math.abs(i); // relative Perspektivwirkung über den Scheibenradius
  let focal = fallback;
  const wq = den > 0 ? -num / den : -1;
  if (wq > 0) {
    const est = 1 / Math.sqrt(wq);
    // nur übernehmen, wenn die Perspektive deutlich genug ist (sonst ist f kaum bestimmbar)
    if (persp > 0.08 && est > fallback * 0.35 && est < fallback * 4) focal = est;
  }
  const m1 = [a / focal, d / focal, g], m2 = [b / focal, e / focal, h], m3 = [c / focal, f / focal, i];
  let lam = 2 / (Math.hypot(...m1) + Math.hypot(...m2));
  if (m3[2] * lam < 0) lam = -lam;
  const r1 = m1.map((v) => v * lam), r2 = m2.map((v) => v * lam), t = m3.map((v) => v * lam);
  let r3 = [r1[1] * r2[2] - r1[2] * r2[1], r1[2] * r2[0] - r1[0] * r2[2], r1[0] * r2[1] - r1[1] * r2[0]];
  const n3 = Math.hypot(...r3); r3 = r3.map((v) => v / n3);
  // Normale zur Kamera hin ausrichten (Kamera im Ursprung)
  if (r3[0] * t[0] + r3[1] * t[1] + r3[2] * t[2] > 0) r3 = r3.map((v) => -v);
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const ray = (px, py) => [(px - cx) / focal, (py - cy) / focal, 1];
  return {
    focal, persp,
    /** Bildpunkt (px) eines Punkts L mm vor der Scheibe über dem Board-Punkt (bx, by) */
    point(bx, by, L = 0) {
      const X = [0, 1, 2].map((k) => r1[k] * bx + r2[k] * by + t[k] + r3[k] * L);
      return { x: (focal * X[0]) / X[2] + cx, y: (focal * X[1]) / X[2] + cy };
    },
    /**
     * Wie schräg müsste ein Pfeil stecken, dessen Spitze im Bild bei tipPx (auf der Scheibe) und
     * dessen hinteres Ende bei farPx liegt? Länge 100–175 mm, hinteres Ende vor der Scheibe.
     * Liefert die kleinste nötige Neigung gegen die Senkrechte (Grad) oder Infinity (unmöglich).
     */
    impliedTilt(tipPx, farPx, Lmin = 100) {
      const qt = ray(tipPx.x, tipPx.y), qf = ray(farPx.x, farPx.y);
      const den = dot3(r3, qt);
      if (Math.abs(den) < 1e-9) return Infinity;
      const s = dot3(r3, t) / den;
      if (!(s > 0)) return Infinity;
      const T = qt.map((v) => v * s);
      const qq = dot3(qf, qf), qT = dot3(qf, T), TT = dot3(T, T);
      let best = Infinity;
      for (let L = Lmin; L <= 175; L += 5) {
        const disc = qT * qT - qq * (TT - L * L);
        if (disc < 0) continue;
        for (const sg of [-1, 1]) {
          const u = (qT + sg * Math.sqrt(disc)) / qq;
          if (!(u > 0)) continue;
          const h = dot3(r3, [u * qf[0] - T[0], u * qf[1] - T[1], u * qf[2] - T[2]]);
          if (h <= 0) continue;
          const tilt = (Math.acos(Math.min(1, h / L)) * 180) / Math.PI;
          if (tilt < best) best = tilt;
        }
      }
      return best;
    },
  };
}

/**
 * Bildpunkte, die den Raum aller möglichen Pfeile umschließen: Scheibe (r ≤ 180 mm) und dieselbe
 * Fläche 150 mm davor, auch mit typisch schräg steckenden Pfeilen. Projektion eines konvexen
 * Körpers = konvexe Hülle dieser Punkte.
 */
function dartVolumePoints(cam) {
  const pts = [];
  // Pfeile bis ca. 40° in jede Richtung geneigt (150 mm lang → 96 mm seitlich, 115 mm vor der Scheibe)
  const tilts = [[0, 0, 0], [0, 0, 150]];
  for (let k = 0; k < 8; k++) tilts.push([96 * Math.cos((k * Math.PI) / 4), 96 * Math.sin((k * Math.PI) / 4), 115]);
  for (const [ox, oy, oz] of tilts) {
    for (let k = 0; k < 24; k++) {
      const t = (k * 15 * Math.PI) / 180;
      const p = cam.point(180 * Math.cos(t) + ox, 180 * Math.sin(t) + oy, oz);
      if (Number.isFinite(p.x) && Number.isFinite(p.y)) pts.push(p);
    }
  }
  return pts;
}

function convexHull(pts) {
  const p = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function inConvex(hull, x, y) {
  if (hull.length < 3) return false;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    if ((b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x) < 0) return false;
  }
  return true;
}

/**
 * Bildausschnitt (normiert) für die Pfeilerkennung: Scheibe mit Rand plus der Bereich, in den
 * Pfeile herausragen können. H: Board → Vollbild normiert; fullW/fullH: Vollbildgröße (px).
 */
export function dartCrop(H, fullW, fullH) {
  const Hpx = [H[0] * fullW, H[1] * fullW, H[2] * fullW, H[3] * fullH, H[4] * fullH, H[5] * fullH, H[6], H[7], H[8]];
  const cam = estimateCamera(Hpx, fullW / 2, fullH / 2, Math.max(fullW, fullH));
  const pts = dartVolumePoints(cam).map((p) => ({ x: p.x / fullW, y: p.y / fullH }));
  for (let k = 0; k < 48; k++) {
    const t = (k * 7.5 * Math.PI) / 180;
    pts.push(applyH(H, 290 * Math.cos(t), 290 * Math.sin(t)));
  }
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const p of pts) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(1, x1); y1 = Math.min(1, y1);
  if (!(x1 > x0 && y1 > y0)) return { x: 0, y: 0, w: 1, h: 1 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Längliche Form? Wurzel des Verhältnisses der Hauptachsen (Pixelindizes, Bildbreite w) */
function elongation(pixels, w) {
  let mx = 0, my = 0;
  for (const p of pixels) { mx += p % w; my += (p / w) | 0; }
  mx /= pixels.length; my /= pixels.length;
  let cxx = 0, cxy = 0, cyy = 0;
  for (const p of pixels) { const dx = (p % w) - mx, dy = ((p / w) | 0) - my; cxx += dx * dx; cxy += dx * dy; cyy += dy * dy; }
  const tr = cxx + cyy, det = cxx * cyy - cxy * cxy, disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  return Math.sqrt((tr / 2 + disc) / Math.max(1e-6, tr / 2 - disc));
}

/**
 * Dominante Gerade (Hough): Richtung in 2°-Schritten, Abstand in 2-px-Klassen; die Gerade mit
 * den meisten Pixeln im ±4-px-Band. Liefert die Pixel in diesem Band.
 */
function dominantLine(pixels, w, minExtent = 0) {
  const step = Math.max(1, Math.floor(pixels.length / 3000));
  const cands = [];
  for (let a = 0; a < 180; a += 2) {
    const t = (a * Math.PI) / 180, nx = -Math.sin(t), ny = Math.cos(t);
    const bins = new Map();
    for (let k = 0; k < pixels.length; k += step) {
      const p = pixels[k], d = Math.round(((p % w) * nx + ((p / w) | 0) * ny) / 2);
      bins.set(d, (bins.get(d) || 0) + 1);
    }
    for (const [d, c] of bins) {
      const s = c + (bins.get(d - 1) || 0) + (bins.get(d + 1) || 0) + 0.5 * ((bins.get(d - 2) || 0) + (bins.get(d + 2) || 0));
      cands.push({ s, nx, ny, off: d * 2 });
    }
  }
  cands.sort((a, b) => b.s - a.s);
  // Die Pfeilachse ist lang; kurze Geraden (z. B. die Kante eines Flight-Flügels) verwerfen
  for (const c of cands.slice(0, 200)) {
    const inliers = [], along = [];
    for (const p of pixels) {
      const x = p % w, y = (p / w) | 0;
      if (Math.abs(x * c.nx + y * c.ny - c.off) <= 4) { inliers.push(p); along.push(x * c.ny - y * c.nx); }
    }
    if (inliers.length < 10) continue;
    along.sort((a, b) => a - b);
    const extent = along[Math.floor(along.length * 0.97)] - along[Math.floor(along.length * 0.03)];
    if (extent >= minExtent) return { inliers, nx: c.nx, ny: c.ny, extent };
  }
  return null;
}

/**
 * Stelle nur abgedunkelt (Schatten), nicht umgefärbt? a = aktuell, b = Referenz; über ein Kreuz aus
 * 9 Pixeln gemittelt, damit Bildrauschen die Farbanteile nicht verfälscht.
 */
function isShadowAt(a, b, i, s) {
  // zuerst der Pixel selbst (schützt die dünne Spitze, deren Umgebung nur Schatten ist) …
  const pa = a[i] + a[i + 1] + a[i + 2], pb = b[i] + b[i + 1] + b[i + 2];
  if (pb < 180 || pa < 0.5 * pb || pa > 0.98 * pb) return false;
  const pt = 0.018 + 1 / pb * 3;
  if (Math.abs(a[i] / pa - b[i] / pb) > pt || Math.abs(a[i + 1] / pa - b[i + 1] / pb) > pt) return false;
  // … dann die Umgebung, mit enger Grenze
  let ar = 0, ag = 0, ab = 0, br = 0, bg = 0, bb = 0;
  for (let k = 0; k < 9; k++) {
    const j = i + SH_X[k] * 4 + SH_Y[k] * s;
    ar += a[j]; ag += a[j + 1]; ab += a[j + 2]; br += b[j]; bg += b[j + 1]; bb += b[j + 2];
  }
  const la = ar + ag + ab, lb = br + bg + bb;
  if (lb < 9 * 75 || la < 9 * 20) return false; // auf sehr dunklem Grund nicht unterscheidbar
  const k = la / lb;
  if (k < 0.5 || k > 0.97) return false;
  // Farbanteile bleiben im Schatten fast gleich. Gemessen: graues Barrel vor weißem Feld weicht um
  // 0,026–0,035 ab (echte Aufnahme)
  const tol = 0.008 + 0.6 / (lb / 9);
  return Math.abs(ar / la - br / lb) < tol && Math.abs(ag / la - bg / lb) < tol;
}
/**
 * Leichte Glättung (3×3-Binomial) vor dem Vergleich: Rauschen, Faserstruktur und Schärfeschwankungen
 * haben wechselnde Vorzeichen und mitteln sich weg, ein Pfeil (mehrere Pixel breit) bleibt.
 */
const softCache = new WeakMap(), rawOf = new WeakMap(); // rawOf: geglättet → Original
export function softImage(src, w, h) {
  let out = softCache.get(src);
  if (out) return out;
  out = blurOnce(src, w, h);
  softCache.set(src, out);
  softCache.set(out, out);
  rawOf.set(out, src);
  return out;
}
function blurOnce(src, w, h) {
  const out = new Uint8ClampedArray(src);
  const W = w * 4, row = new Uint16Array(W * 3); // drei waagerecht geglättete Zeilen
  const hpass = (y, o) => {
    const b = y * W;
    for (let i = 4; i < W - 4; i++) row[o + i] = src[b + i - 4] + 2 * src[b + i] + src[b + i + 4];
  };
  hpass(0, 0); hpass(1, W);
  for (let y = 1; y < h - 1; y++) {
    const o0 = ((y - 1) % 3) * W, o1 = (y % 3) * W, o2 = ((y + 1) % 3) * W, b = y * W;
    hpass(y + 1, o2);
    for (let i = 4; i < W - 4; i += 4) {
      out[b + i] = (row[o0 + i] + 2 * row[o1 + i] + row[o2 + i]) / 16;
      out[b + i + 1] = (row[o0 + i + 1] + 2 * row[o1 + i + 1] + row[o2 + i + 1]) / 16;
      out[b + i + 2] = (row[o0 + i + 2] + 2 * row[o1 + i + 2] + row[o2 + i + 2]) / 16;
    }
  }
  return out;
}

/**
 * Abweichung vom Wertebereich der Referenz in ±tol px Umgebung: Kanten, die um Bruchteile eines Pixels
 * verrutscht sind, zählen nicht; ein Pfeil vor gleichmäßigem Grund zählt voll. s = Bytes je Bildzeile.
 */
function tolDev(a, ref, i, s, tol) {
  const v = ref[i], x = a[i];
  let m = v;
  if (x > v) {
    if (ref[i - 4] > m) m = ref[i - 4]; if (ref[i + 4] > m) m = ref[i + 4];
    if (ref[i - s] > m) m = ref[i - s]; if (ref[i + s] > m) m = ref[i + s];
    const d = x - v - (m - v) * tol;
    return d > 0 ? d : 0;
  }
  if (ref[i - 4] < m) m = ref[i - 4]; if (ref[i + 4] < m) m = ref[i + 4];
  if (ref[i - s] < m) m = ref[i - s]; if (ref[i + s] < m) m = ref[i + s];
  const d = v - x - (v - m) * tol;
  return d > 0 ? d : 0;
}
const SH_X = [0, -1, 1, 0, 0, -1, 1, -1, 1], SH_Y = [0, 0, 0, -1, 1, -1, -1, 1, 1];

export class DartDetector {
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.H = null;
    this.reset();
  }

  /**
   * H: Board(mm) → Bild normiert; w/h: Verarbeitungsauflösung.
   * view (optional, bei Bildausschnitt): { cx, cy, size } = Mitte und größere Seite des
   * Vollbilds in Pixeln dieses Ausschnitts – für das Kameramodell (Pfeilrichtung).
   */
  setCalibration(H, w, h, view = null) {
    this.w = w; this.h = h;
    this.Hpx = [H[0] * w, H[1] * w, H[2] * w, H[3] * h, H[4] * h, H[5] * h, H[6], H[7], H[8]];
    this.Hinv = invertH(this.Hpx);
    const v = view || { cx: w / 2, cy: h / 2, size: Math.max(w, h) };
    this.cam = estimateCamera(this.Hpx, v.cx, v.cy, v.size);
    // Region of Interest: Scheibe + Rand für herausragende Pfeile (bis 300 mm vom Zentrum).
    // Randabstand M, damit Vergleiche mit verschobenem Referenzbild (Wackeln) im Bild bleiben.
    const M = MAX_SHIFT + 1;
    const roi = [];
    // dazu der Bereich, in den Pfeile aus der Scheibe herausragen (bei seitlicher Kamera über den Rand)
    const hull = convexHull(dartVolumePoints(this.cam));
    for (let y = M; y < h - M; y++) for (let x = M; x < w - M; x++) {
      const b = applyH(this.Hinv, x, y);
      if ((Number.isFinite(b.x) && b.x * b.x + b.y * b.y <= 300 * 300) || inConvex(hull, x, y)) roi.push(y * w + x);
    }
    this.roi = Int32Array.from(roi);
    // Bewegungskontrolle nur auf der Scheibe selbst (Personen, Monitore daneben stören nicht)
    this.boardIdx = Int32Array.from(roi.filter((p, k) => { if (k % 3) return false; const b = applyH(this.Hinv, p % w, (p / w) | 0); return Number.isFinite(b.x) && b.x * b.x + b.y * b.y <= 230 * 230; }));
    { const q0 = applyH(this.Hpx, 0, 0), qx = applyH(this.Hpx, 10, 0), qy = applyH(this.Hpx, 0, 10); this.pxPerMm = Math.max(Math.hypot(qx.x - q0.x, qx.y - q0.y), Math.hypot(qy.x - q0.x, qy.y - q0.y)) / 10; }
    this.lastEval = null; this.calibRef = null; this.T0 = null; this.Tcur = null; this.dirPrior = null;
    this.diff = new Uint8Array(w * h);
    this.mask = new Uint8Array(w * h);
    this.reset();
  }

  reset() {
    this.ref = null; this.emptyRef = null; this.prev = null;
    this.stable = 0; this.hadMotion = false;
    this.dartsOnBoard = 0; this.awaitingTakeout = false;
    this.regions = []; this.largeChangeCount = 0; this.clearOcc();
    this.lastRefBefore = null;
    this.status = 'init';
  }

  /** Pixel bereits steckender Pfeile (für die Erkennung verdeckter Spitzen) */
  clearOcc() { if (this.occ) this.occ.fill(0); this.lastPixels = null; this.segs = []; this.dartPx = []; this.dartMem = []; }

  /** „Kein Pfeil“: die zuletzt gemeldete (oder die passende) Erkennung wieder vergessen */
  forget(ev) {
    let k = this.segs.findIndex((s) => ev && ev.tipPx && Math.hypot(s.tip.x - ev.tipPx.x, s.tip.y - ev.tipPx.y) < 2);
    if (k < 0) k = this.segs.length - 1;
    if (k >= 0) {
      this.markOcc(this.dartPx[k], -1);
      for (const l of [this.segs, this.dartPx, this.dartMem, this.regions]) l.splice(k, 1);
    }
    this.dartsOnBoard = Math.max(0, this.dartsOnBoard - 1);
    // war es der einzige, ist die Scheibe leer: aktuelles Bild wird neue Leer-Referenz
    if (!this.dartsOnBoard && this.ref) { this.setEmpty(this.ref); this.clearOcc(); }
  }

  /** Liegt ein bereits steckender Pfeil in der Nähe (±2 px) dieses Bildpunkts? */
  isOcc(p) {
    if (!this.occ) return false;
    const x0 = Math.round(p.x), y0 = Math.round(p.y);
    for (let y = y0 - 2; y <= y0 + 2; y++) for (let x = x0 - 2; x <= x0 + 2; x++) {
      if (x >= 0 && y >= 0 && x < this.w && y < this.h && this.occ[y * this.w + x]) return true;
    }
    return false;
  }

  markOcc(list, delta = 1) {
    if (!list || !this.w) return;
    if (!this.occ || this.occ.length !== this.w * this.h) this.occ = new Uint8Array(this.w * this.h);
    const { occ } = this;
    for (const p of list) { const v = occ[p] + delta; occ[p] = v < 0 ? 0 : v > 255 ? 255 : v; }
    if (delta > 0) this.lastPixels = list;
  }

  /** Aktuelles Bild wird neue Referenz (z. B. "Pfeile entfernt" manuell bestätigt) */
  rebase(img) {
    const raw = img.data.slice(), c = softImage(raw, this.w, this.h);
    this.setEmpty(c);
    this.ref = c; this.refRaw = raw; this.prev = raw;
    this.dartsOnBoard = 0; this.awaitingTakeout = false; this.regions = []; this.stable = 0; this.clearOcc();
    this.lastRefBefore = null;
    this.status = 'bereit';
  }

  /** Neues Bild der leeren Scheibe. Merkt sich, wie weit es gegenüber der Kalibrierung verrutscht ist. */
  setEmpty(c) {
    if (!this.calibRef) { this.calibRef = c; this.T0 = { ...IDENTITY, cx: this.w / 2, cy: this.h / 2 }; } else {
      const T = estimateTransform(c, this.calibRef, this.w, this.h, this.roi, this.T0);
      if (T.ok) this.T0 = T;
    }
    this.emptyRef = c;
  }

  /** Referenz passend zum aktuellen Bild ausrichten: { img, T } */
  alignTo(data, ref) {
    const s = this.estimateShift(data, ref);
    const T = estimateTransform(data, ref, this.w, this.h, this.roi, { tx: s.dx, ty: s.dy });
    if (!T.ok) return { img: ref, T: { ...IDENTITY, cx: this.w / 2, cy: this.h / 2 }, ok: false };
    return { img: warpRef(data, ref, T, this.w, this.h, this.roi), T, ok: true };
  }

  awaitTakeout() { this.awaitingTakeout = true; this.status = 'warte auf Entfernen'; }

  /** Verarbeitet ein Frame (ImageData in Verarbeitungsauflösung). Liefert Ereignisse. */
  process(img) {
    if (!this.roi || img.width !== this.w || img.height !== this.h) return [];
    const data = img.data;
    if (!this.ref) { this.rebase(img); return [{ type: 'ready' }]; }

    let motion = this.motionFraction(data, this.prev);
    if (motion > this.opts.motionFraction) {
      // wackelt nur das Stativ? Dann passt das Bild nach einer kleinen Verschiebung wieder
      const s = this.quickShift(data, this.prev);
      if (s) motion = this.motionFraction(data, this.prev, s.dy * this.w + s.dx);
    }
    this.prev = data.slice();
    if (motion > this.opts.motionFraction) {
      this.stable = 0; this.hadMotion = true;
      if (this.status !== 'warte auf Entfernen') this.status = 'Bewegung';
      return [];
    }
    this.stable++;
    if (this.stable < this.opts.stableFrames) return [];
    // nach Bewegung sofort auswerten, sonst periodisch (falls ein Pfeil ohne messbare Bewegung landete)
    if (!this.hadMotion) {
      if (this.stable % 12 !== 0) return [];
      if (this.lastEval && this.motionFraction(data, this.lastEval) < 0.0003) return []; // nichts Neues
    }
    this.hadMotion = false;
    this.lastEval = data.slice();
    return this.evaluate(data);
  }

  /**
   * Anteil bewegter Bildpunkte auf der Scheibe. Ein leicht wackelndes Stativ verschiebt nur Kanten:
   * Werte, die in der direkten Nachbarschaft des Vorbilds vorkommen, zählen nicht als Bewegung.
   */
  motionFraction(a, b, off = 0) {
    const { boardIdx, w } = this;
    const s = w * 4;
    let changed = 0;
    for (let k = 0; k < boardIdx.length; k++) {
      const i = boardIdx[k] * 4, j = i + off * 4;
      if (Math.abs(a[i] - b[j]) + Math.abs(a[i + 1] - b[j + 1]) + Math.abs(a[i + 2] - b[j + 2]) < 84) continue;
      let inside = true;
      for (let c = 0; c < 3 && inside; c++) {
        const v = a[i + c];
        let lo = 255, hi = 0;
        for (let dy = -s; dy <= s; dy += s) for (let dx = -4; dx <= 4; dx += 4) { const q = b[j + c + dx + dy]; if (q < lo) lo = q; if (q > hi) hi = q; }
        if (v < lo - 14 || v > hi + 14) inside = false;
      }
      if (!inside) changed++;
    }
    return boardIdx.length ? changed / boardIdx.length : 0;
  }

  /** Schnelle Schätzung einer Verschiebung bis ±3 px zwischen zwei aufeinanderfolgenden Bildern (Grünkanal) */
  quickShift(a, b) {
    const { boardIdx, w } = this;
    const step = Math.max(1, Math.floor(boardIdx.length / 1500));
    let best = null, sad0 = 0;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const o = (dy * w + dx) * 4;
      let sad = 0;
      for (let k = 0; k < boardIdx.length; k += step) { const i = boardIdx[k] * 4 + 1; sad += Math.min(60, Math.abs(a[i] - b[i + o])); }
      if (!dx && !dy) sad0 = sad;
      if (!best || sad < best.sad) best = { dx, dy, sad };
    }
    return (best.dx || best.dy) && best.sad < 0.8 * sad0 ? best : null;
  }

  /** Wertet den zuletzt erkannten Pfeil im aktuellen Bild erneut aus (Referenz = Bild davor) */
  redetectLast(img) {
    if (!img || !this.lastRefBefore || (this.awaitingTakeout && this.dartsOnBoard === 0)) return null;
    const data = softImage(img.data, this.w, this.h);
    const A = this.alignTo(data, this.lastRefBefore);
    this.setFrameTransform(data);
    this.pair = { cur: data, ref: this.lastRefBefore, T: A.T, raw: null };
    const count = this.buildMask(data, A.img);
    if (count < this.opts.minDartFraction * this.roi.length) return null;
    const own = this.regions.pop();
    const ownSeg = this.segs.pop();
    const ownPx = this.lastPixels;
    this.markOcc(ownPx, -1); // eigener Pfeil verdeckt sich nicht selbst
    const det = this.analyse(1)[0] || null;
    if (ownPx) { this.markOcc(ownPx, 1); }
    if (own) this.regions.push(own);
    if (ownSeg) this.segs.push(det ? { tip: det.tipPx, far: det.far } : ownSeg);
    if (det) delete det.pixelList;
    return det;
  }

  /**
   * Schätzt eine kleine globale Verschiebung (Wackeln) zwischen Bild a und Referenz b (ganze Pixel,
   * Startwert für die Feinausrichtung): a[p] ≈ b[p + (dx, dy)].
   */
  estimateShift(a, b) {
    const { roi, w } = this;
    const step = Math.max(1, Math.floor(roi.length / 5000));
    const la = luminance(a), lb = luminance(b);
    let bestSad = Infinity, sad0 = 0, bdx = 0, bdy = 0;
    for (let dy = -MAX_SHIFT; dy <= MAX_SHIFT; dy++) {
      for (let dx = -MAX_SHIFT; dx <= MAX_SHIFT; dx++) {
        const o = dy * w + dx;
        let sad = 0;
        for (let k = 0; k < roi.length; k += step) sad += Math.min(40, Math.abs(la[roi[k]] - lb[roi[k] + o]));
        if (!dx && !dy) sad0 = sad;
        if (sad < bestSad) { bestSad = sad; bdx = dx; bdy = dy; }
      }
    }
    if (bestSad > sad0 * 0.95) return { dx: 0, dy: 0 };
    return { dx: bdx, dy: bdy };
  }

  /** Scheibe leer und frei (keine Pfeile, niemand davor)? Für Kamerakontrolle und Nachführung. */
  isClear(img) {
    if (!this.emptyRef || this.dartsOnBoard > 0 || this.awaitingTakeout || this.status !== 'bereit') return false;
    if (!img || img.width !== this.w || img.height !== this.h) return false;
    const data = softImage(img.data, this.w, this.h);
    if (this.motionFraction(data, this.emptyRef) > 0.004) return false; // schnelle Vorprüfung
    const E = this.alignTo(data, this.emptyRef);
    const M = this.matchSharpness(data, E.img);
    this.buildMask(M.a, M.b);
    return this.looksEmpty();
  }

  /** Keine zusammenhängende Veränderung in Pfeilgröße (nach buildMask) */
  looksEmpty() {
    const minPx = this.opts.minDartFraction * this.roi.length;
    const comps = this.components();
    const big = comps.length ? comps[0].px.length : 0;
    return big < 0.45 * minPx;
  }

  /** Lage des aktuellen Bilds gegenüber der Kalibrierung (für die Umrechnung auf die Scheibe) */
  setFrameTransform(data, E = null) {
    const e = E || this.alignTo(data, this.emptyRef);
    this.Tcur = e.ok ? e.T : null;
  }

  /** Bildpunkt im aktuellen Bild → Bildpunkt zum Zeitpunkt der Kalibrierung */
  toCalib(x, y) {
    let p = { x, y };
    if (this.Tcur) p = applyT(this.Tcur, p.x, p.y);
    if (this.T0) p = applyT(this.T0, p.x, p.y);
    return p;
  }

  evaluate(frame) {
    const raw = frame.slice(), data = softImage(raw, this.w, this.h);
    const roiN = this.roi.length;
    let healed = false; // Entnahme erkannt, obwohl die Scheibe nicht ganz wie das alte Leerbild aussieht
    const events = [];
    const E = this.alignTo(data, this.emptyRef);
    // Pfeile entfernt?
    if (this.dartsOnBoard > 0 || this.awaitingTakeout) {
      // Sehen die Stellen aller bekannten Pfeile wieder aus wie vor ihrem Treffer? (unabhängig davon, ob sich
      // Schärfe oder Licht seit dem Bild der leeren Scheibe geändert haben)
      const gone = this.allGone(data, E.T);
      const maybe = gone || this.vanished(data, E.img);
      if (maybe) { const m = this.matchSharpness(data, E.img); this.buildMask(m.a, m.b, null); }
      const empty = maybe && this.looksEmpty();
      if (empty || gone) {
        if (empty) { this.setEmpty(data); this.ref = data; this.refRaw = raw; } else this.ref = this.emptyRef;
        this.dartsOnBoard = 0; this.awaitingTakeout = false; this.regions = []; this.clearOcc();
        this.lastRefBefore = null;
        this.status = 'bereit';
        events.push({ type: 'takeout' });
        if (empty) return events;
        healed = true;
      }
    }
    if (this.awaitingTakeout) { this.status = 'warte auf Entfernen'; return [{ type: 'waiting-takeout' }]; }

    // Referenz auf Bruchteile eines Pixels ausrichten (Stativ wackelt, Scheibe verrutscht minimal)
    const A = this.ref === this.emptyRef ? E : this.alignTo(data, this.ref);
    this.setFrameTransform(data, E);
    this.lastShift = A.T;
    this.pair = { cur: data, ref: this.ref, T: A.T, raw: null };
    const M = this.matchSharpness(data, A.img);
    if (M.changed) this.pair.raw = { cur: M.a, ref: M.b };
    const count = this.buildMask(M.a, M.b, this.dartsOnBoard > 0 ? E.img : null);
    const frac = count / roiN;
    if (frac < this.opts.minDartFraction || this.looksEmpty()) {
      this.status = 'bereit';
      // minimale Drift (Licht, leichtes Verrutschen) in die Referenz übernehmen
      this.ref = data; this.refRaw = raw;
      if (!this.dartsOnBoard) this.setEmpty(data);
      return events;
    }
    if (frac > this.opts.maxDartFraction) {
      this.largeChangeCount++;
      this.status = 'große Veränderung';
      if (this.largeChangeCount >= 3) {
        // dauerhafte Veränderung ohne Pfeil (Licht, verschobene Kamera) → neue Referenz
        this.largeChangeCount = 0;
        this.ref = data; this.refRaw = raw;
        if (this.dartsOnBoard === 0) this.setEmpty(data);
        return [...events, { type: 'lighting' }];
      }
      return [...events, { type: 'large-change', fraction: frac }];
    }
    this.largeChangeCount = 0;
    const dets = this.analyse(Math.max(1, 3 - this.dartsOnBoard));
    this.lastRefBefore = this.ref; this.lastRawBefore = this.refRaw;
    this.ref = data; this.refRaw = raw;
    this.status = 'bereit';
    if (!dets.length) {
      // alle Pfeile weg und nichts Neues, nur Reste (Schärfe, Licht): das ist jetzt die leere Scheibe
      if (healed || this.dartsOnBoard === 0) this.setEmpty(data);
      return healed ? events : [...events, { type: 'unclear' }];
    }
    for (const det of dets) {
      if (this.dartsOnBoard >= 3) { det.conf = Math.min(det.conf, 0.4); det.reasons.push('mehr als drei Pfeile'); }
      this.dartsOnBoard++;
      this.regions.push(det.bbox);
      this.segs.push({ tip: det.tipPx, far: det.far });
      this.dartPx.push(det.pixelList);
      this.dartMem.push(this.remember(det.pixelList, det.conf, E.T));
      this.markOcc(det.pixelList);
      this.learnDirection(det);
      delete det.pixelList;
      events.push({ type: 'dart', ...det });
    }
    return events;
  }

  /**
   * Gleiche Schärfe für beide Bilder: War der Autofokus bei einem der beiden noch nicht fertig, wird das
   * schärfere weicher gezeichnet (sonst gibt es an allen Kanten Reste). Liefert { a, b, changed }.
   */
  matchSharpness(a, b) {
    const { boardIdx, w, h } = this, step = Math.max(1, Math.floor(boardIdx.length / 12000));
    const energy = (d) => {
      let s = 0;
      for (let k = 0; k < boardIdx.length; k += step) { const i = boardIdx[k] * 4 + 1; s += Math.abs(4 * d[i] - d[i - 4] - d[i + 4] - d[i - w * 4] - d[i + w * 4]); }
      return s;
    };
    let ea = energy(a), eb = energy(b), changed = 0;
    this.sharpRatio = eb > 0 ? ea / eb : 1;
    while (changed < 8 && (ea > 1.12 * eb || eb > 1.12 * ea)) {
      if (ea > eb) { const n = blurOnce(a, w, h), en = energy(n); if (en < eb && eb / en > ea / eb) break; a = n; ea = en; } else { const n = blurOnce(b, w, h), en = energy(n); if (en < ea && ea / en > eb / ea) break; b = n; eb = en; }
      changed++;
    }
    return { a, b, changed };
  }

  /** Zustand für „Erkennung speichern“: aktuelles Bild gegen die leere Scheibe */
  diagnose(img) {
    if (!this.emptyRef || !img || img.width !== this.w || img.height !== this.h) return null;
    const data = softImage(img.data.slice(), this.w, this.h), E = this.alignTo(data, this.emptyRef);
    this.allGone(data, E.T);
    const M = this.matchSharpness(data, E.img);
    this.buildMask(M.a, M.b, null);
    const comps = this.components();
    return { mask: this.mask.slice(), empty: this.emptyRef,
      text: `Pfeile laut Erkennung ${this.dartsOnBoard}, ${this.status}; Ausrichtung ${E.T.tx.toFixed(2)}/${E.T.ty.toFixed(2)} Maßstab ${(E.T.a || 0).toFixed(5)} Drehung ${(E.T.b || 0).toFixed(5)}${E.ok ? '' : ' (unsicher)'}; Schärfe ${this.sharpRatio.toFixed(2)}, Rauschen ${this.noise}; Flecken ${comps.slice(0, 5).map((c) => c.px.length).join(' ') || 'keine'} (Pfeil ab ${Math.round(this.opts.minDartFraction * this.roi.length)}); weg: ${this.dartMem.map((m) => (m.gone == null ? '?' : Math.round(m.gone * 100) + '%')).join(' ') || '–'}` };
  }

  /** Merkt sich für einen Pfeil, wie seine Pixel vorher und mit ihm aussahen */
  remember(px, conf, T) {
    const n = px.length, before = new Uint8Array(n * 3), after = new Uint8Array(n * 3);
    for (let k = 0; k < n; k++) for (let c = 0; c < 3; c++) { before[k * 3 + c] = this.refImg[px[k] * 4 + c]; after[k * 3 + c] = this.cur[px[k] * 4 + c]; }
    return { px, before, after, conf, tx: T.tx, ty: T.ty };
  }

  /** Sind alle bekannten Pfeile verschwunden? Je Pixel: Ist das Bild jetzt näher an „vorher“ oder an „mit Pfeil“? */
  allGone(data, T) {
    if (!this.dartMem.length) return false;
    let total = 0, gone = 0, any = false;
    for (const m of this.dartMem) {
      const off = (Math.round(m.ty - T.ty) * this.w + Math.round(m.tx - T.tx)) * 4;
      let back = 0, all = 0;
      for (let k = 0; k < m.px.length; k += 2) {
        const i = m.px[k] * 4 + off;
        if (i < 0 || i + 2 >= data.length) continue;
        let db = 0, da = 0, d = 0;
        for (let c = 0; c < 3; c++) { const v = data[i + c], b = m.before[k * 3 + c], a = m.after[k * 3 + c]; db += Math.abs(v - b); da += Math.abs(v - a); d += Math.abs(a - b); }
        if (d < 45) continue; // kaum Unterschied: sagt nichts aus
        all += d; if (db < 0.6 * da) back += d;
      }
      if (all < 400) continue;
      const isGone = back > 0.75 * all;
      m.gone = all ? back / all : 0;
      // jeder sichere Pfeil muss weg sein; unsichere Meldungen (evtl. gar kein Pfeil) blockieren nicht allein
      if (!isGone && m.conf >= 0.5) return false;
      total += all; if (isGone) { gone += all; any = true; }
    }
    return any && gone >= 0.8 * total;
  }

  /** Schnelle Vorprüfung: Sieht mindestens ein Drittel der bekannten Pfeilpixel wieder aus wie die leere Scheibe? */
  vanished(a, empty) {
    let n = 0, gone = 0;
    const s = this.w * 4, tol = this.opts.edgeTolerance;
    for (const px of this.dartPx) for (let k = 0; k < px.length; k += 3) {
      const i = px[k] * 4;
      const d = Math.max(tolDev(a, empty, i, s, tol), tolDev(a, empty, i + 1, s, tol), tolDev(a, empty, i + 2, s, tol));
      n++; if (d < 18) gone++;
    }
    return n < 20 || gone > n / 3;
  }

  /** Alle Pfeile eines Spielers zeigen im Bild meist in eine ähnliche Richtung – das lernt die Erkennung mit */
  learnDirection(det) {
    if (det.conf < 0.6 || det.axis.elong < 2.5) return;
    const vx = det.far.x - det.tipPx.x, vy = det.far.y - det.tipPx.y, l = Math.hypot(vx, vy);
    if (l < 10) return;
    const d = this.dirPrior || (this.dirPrior = { x: 0, y: 0, n: 0 });
    d.x = d.x * 0.8 + vx / l; d.y = d.y * 0.8 + vy / l; d.n++;
  }

  /** Gelernte Pfeilrichtung (Spitze → Flight) oder null */
  priorDir() {
    const d = this.dirPrior;
    if (!d || d.n < 2) return null;
    const l = Math.hypot(d.x, d.y), max = (1 - 0.8 ** Math.min(d.n, 30)) / 0.2;
    if (l < 0.6 * max) return null; // Richtungen streuen zu stark
    return { x: d.x / l, y: d.y / l };
  }

  /** a = aktuelles Bild, b = ausgerichtete Referenz; vac = ausgerichtetes Bild der leeren Scheibe */
  buildMask(a, b, vac = null) {
    this.cur = a; this.refImg = b;
    const { diff, mask, roi, w } = this;
    const s = w * 4;
    diff.fill(0); mask.fill(0);
    const tol = this.opts.edgeTolerance;
    const hist = new Uint32Array(256);
    let hn = 0;
    for (let k = 0; k < roi.length; k++) {
      const p = roi[k], i = p * 4;
      // Differenz: Mittel und stärkster Farbkanal (silber vor Creme unterscheidet sich fast nur im
      // Blauanteil, schwarz vor dunkelgrün fast nur im Grünanteil – das Mittel würde das verwässern)
      const inNoise = k % 7 === 0;
      if (!inNoise) {
        // Obergrenze ohne Kantentoleranz: fast alle Pixel sind unverändert und damit schon erledigt
        const r = Math.abs(a[i] - b[i]), g = Math.abs(a[i + 1] - b[i + 1]), l = Math.abs(a[i + 2] - b[i + 2]);
        const m = r > g ? (r > l ? r : l) : g > l ? g : l, up = ((r + g + l) / 3 + m) / 2;
        if (up < 4) { diff[p] = 0.6 * up; continue; }
      }
      const er = tolDev(a, b, i, s, tol), eg = tolDev(a, b, i + 1, s, tol), eb = tolDev(a, b, i + 2, s, tol);
      const d = ((er + eg + eb) / 3 + Math.max(er, eg, eb)) / 2;
      if (d < 4) { diff[p] = d; if (inNoise) { hist[diff[p]]++; hn++; } continue; }
      if (inNoise) { hist[d > 255 ? 255 : d | 0]++; hn++; }
      // Schatten: leicht abgedunkelt bei unveränderter Farbe → gehört nicht zum Pfeil
      if (d > 6 && isShadowAt(a, b, i, s)) { diff[p] = 0; continue; }
      // Freigewordene Stelle (ein angestoßener Pfeil hat sich bewegt): Hier sieht das Bild wieder
      // aus wie die leere Scheibe – das gehört nicht zum neuen Pfeil
      if (vac && d > 10) {
        const ve = (tolDev(a, vac, i, s, tol) + tolDev(a, vac, i + 1, s, tol) + tolDev(a, vac, i + 2, s, tol)) / 3;
        if (ve < 0.35 * d && ve < 14) { diff[p] = 0; continue; }
      }
      diff[p] = d > 255 ? 255 : d;
    }
    // Rauschpegel (Median der Differenz – fast alle Pixel sind unverändert): Schwelle daran
    // anpassen, damit kontrastarme Teile (silber vor Creme, schwarz vor dunklem Grün) sichtbar
    // bleiben, ohne dass Rauschen als Pfeil zählt
    let med = 0;
    for (let acc = 0; med < 255; med++) { acc += hist[med]; if (acc >= hn / 2) break; }
    this.noise = med;
    const thrMean = Math.min(this.opts.diffThreshold, Math.max(this.opts.minDiffThreshold, 4 * med + 2));
    this.lowThr = Math.min(18, Math.max(10, 3.5 * med + 2));
    let count = 0;
    for (let k = 0; k < roi.length; k++) {
      const p = roi[k];
      // die Bilder sind schon geglättet, hier nur noch einzelne Ausreißer unterdrücken
      if (2 * diff[p] + diff[p - w] + diff[p - 1] + diff[p + 1] + diff[p + w] > 6 * thrMean) { mask[p] = 1; count++; }
    }
    return count;
  }

  /**
   * Anteil der Pixel, die sich nicht durch minimal verschobene oder anders scharfe Kanten erklären lassen:
   * Ihre Farbe kommt in der 5×5-Umgebung der Referenz nicht vor. Kantenreste ≈ 0, Pfeile deutlich mehr.
   */
  unexplained(px) {
    const { w, cur, refImg } = this, step = Math.max(1, Math.floor(px.length / 300)), M = 10;
    let n = 0, out = 0;
    for (let k = 0; k < px.length; k += step) {
      const i = px[k] * 4; n++;
      for (let c = 0; c < 3; c++) {
        const v = cur[i + c];
        let lo = 255, hi = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const q = refImg[i + c + (dy * w + dx) * 4]; if (q < lo) lo = q; if (q > hi) hi = q; }
        if (v < lo - M || v > hi + M) { out++; break; }
      }
    }
    return n ? out / n : 0;
  }

  /** Zusammenhängende Regionen der Maske, größte zuerst */
  components() {
    const { mask, w, h } = this;
    const seen = new Uint8Array(w * h);
    const comps = [];
    const stack = new Int32Array(w * h);
    for (let k = 0; k < this.roi.length; k++) {
      const start = this.roi[k];
      if (!mask[start] || seen[start]) continue;
      let sp = 0; stack[sp++] = start; seen[start] = 1;
      const px = [];
      let minX = w, minY = h, maxX = 0, maxY = 0;
      while (sp) {
        const p = stack[--sp];
        px.push(p);
        const x = p % w, y = (p / w) | 0;
        if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const q = p + dy * w + dx;
          if (q >= 0 && q < w * h && mask[q] && !seen[q]) { seen[q] = 1; stack[sp++] = q; }
        }
      }
      if (px.length >= 12 && this.unexplained(px) >= this.opts.minUnexplained) comps.push({ px, bbox: { minX, minY, maxX, maxY } });
    }
    return comps.sort((a, b) => b.px.length - a.px.length);
  }

  /** Veränderungen → Pfeile (meist einer; mehrere, wenn zwischendurch nicht ausgewertet werden konnte) */
  analyse(maxDarts = 1) {
    const minPx = this.opts.minDartFraction * this.roi.length;
    let rest = this.components();
    const groups = [];
    while (rest.length && groups.length < maxDarts) {
      if (rest[0].px.length < (groups.length ? 1.2 : 0.4) * minPx) break;
      const g = this.mergeParts(rest);
      rest = rest.filter((c) => !g.merged.includes(c));
      if (g.pixels.length >= minPx) groups.push(g); else if (groups.length) break;
    }
    const dets = [];
    const first = groups[0];
    for (const g of groups) {
      // weitere Gruppen nur, wenn sie wirklich wie ein eigener Pfeil aussehen
      if (g !== first && g.pixels.length < 0.3 * first.pixels.length) continue;
      const atOld = this.occ && this.dartsOnBoard > 0 ? g.pixels.filter((p) => this.occ[p]).length / g.pixels.length : 0;
      if (g !== first && atOld > 0.08) continue; // eher ein angestoßener alter Pfeil
      const extra = rest.filter((c) => c.px.length > 0.04 * g.pixels.length).length;
      // wie viel Neues gibt es insgesamt (ohne angestoßene alte Pfeile)?
      const fresh = g.pixels.length + rest.reduce((n, c) => n + (this.occ && c.px.filter((p) => this.occ[p]).length > 0.08 * c.px.length ? 0 : c.px.length), 0);
      const det = this.groupToDart(g.pixels, g.bb, extra, g === first ? fresh : 0);
      if (!det) continue;
      if (dets.length) {
        if (Math.hypot(det.board.x, det.board.y) > 190 || det.axis.elong < 3 || det.conf < 0.2 || det.axis.length < 0.35 * this.maxDartLen((g.bb.minX + g.bb.maxX) / 2, (g.bb.minY + g.bb.maxY) / 2)) continue;
        det.conf = Math.min(det.conf, 0.55); det.reasons.push('mehrere neue Pfeile auf einmal');
      }
      dets.push(det);
      if (dets.length < maxDarts && atOld < 0.02) {
        const second = this.parallelDart(g.pixels, det);
        if (second) {
          det.conf = Math.min(det.conf, 0.55); det.reasons.push('zwei Pfeile dicht nebeneinander');
          second.conf = Math.min(second.conf, 0.5); second.reasons.push('zwei Pfeile dicht nebeneinander');
          dets.push(second);
        }
      }
    }
    // ein großer, keinem Pfeil zugeordneter Rest (nicht an alten Pfeilen) → evtl. fehlt das Barrel mit der Spitze
    if (dets.length === 1 && rest.some((c) => c.px.length > 0.4 * first.pixels.length && !(this.occ && c.px.filter((p) => this.occ[p]).length > 0.08 * c.px.length))) {
      dets[0].conf *= 0.6; dets[0].reasons.push('weiterer Pfeilteil nicht zugeordnet');
    }
    return dets.slice(0, maxDarts);
  }

  /**
   * Zwei neue Pfeile auf einmal, die sich berühren: Im vorderen Teil (Barrel) liegt neben der Achse des
   * gefundenen Pfeils ein zweiter schmaler, gleich gerichteter Streifen.
   */
  parallelDart(pixels, det) {
    const { w } = this, s = this.pxPerMm;
    const tx = det.tipPx.x, ty = det.tipPx.y, fx = det.far.x - tx, fy = det.far.y - ty, L = Math.hypot(fx, fy);
    if (L < 60 * s * 0.6 || det.axis.elong < 2.5) return null;
    const ux = fx / L, uy = fy / L;
    // Querprofil im vorderen Teil: zwei klar getrennte Streifen (Tal dazwischen) = zwei Barrels
    const R0 = Math.ceil(30 * s), prof = new Float32Array(2 * R0 + 1);
    const front = [];
    // nur deutlich veränderte Pixel: Die Glättung füllt sonst den schmalen Spalt zwischen zwei Barrels
    const strong = this.lowThr * 2.2;
    for (const p of pixels) {
      if (this.diff[p] < strong) continue;
      const dx = (p % w) - tx, dy = ((p / w) | 0) - ty, al = dx * ux + dy * uy, pe = dx * uy - dy * ux;
      if (al < 0.05 * L || al > 0.45 * L || Math.abs(pe) > R0) continue;
      front.push([p, al, pe]); prof[Math.round(pe) + R0]++;
    }
    const sm = prof.map((v, i) => (v + (prof[i - 1] || 0) + (prof[i + 1] || 0)) / 3);
    let m = 0; for (let i = 0; i < sm.length; i++) if (sm[i] > sm[m]) m = i;
    let m2 = -1;
    for (let i = 0; i < sm.length; i++) if (Math.abs(i - m) >= 6 * s && (m2 < 0 || sm[i] > sm[m2])) m2 = i;
    let best = null;
    if (m2 >= 0 && sm[m2] >= 0.35 * sm[m] && sm[m2] >= 14 * s) {
      let valley = Infinity, vi = m;
      for (let i = Math.min(m, m2); i <= Math.max(m, m2); i++) if (sm[i] < valley) { valley = sm[i]; vi = i; }
      const lo = vi - R0;
      if (valley <= 0.6 * sm[m2]) best = front.filter(([, , pe]) => (m2 > m ? pe > lo : pe < lo)).map(([p]) => p);
    }
    if (!best) {
      // … oder der vordere Teil ist durchgehend viel breiter als ein Barrel (ca. 7 mm): zwei berühren sich
      const widths = [];
      const bins = new Map();
      for (const [, al, pe] of front) { const k = Math.round(al / 2); const b = bins.get(k) || [Infinity, -Infinity]; b[0] = Math.min(b[0], pe); b[1] = Math.max(b[1], pe); bins.set(k, b); }
      for (const b of bins.values()) widths.push(b[1] - b[0]);
      widths.sort((x, y) => x - y);
      if (widths.length < 10 * s || widths[Math.floor(widths.length * 0.5)] < 12.5 * s) return null;
      const ps = front.map(([, , pe]) => pe).sort((x, y) => x - y), p5 = ps[Math.floor(ps.length * 0.05)], p95 = ps[Math.floor(ps.length * 0.95)];
      const cut = p95 > -p5 ? p95 / 2 : p5 / 2;
      best = front.filter(([, , pe]) => (p95 > -p5 ? pe > cut : pe < cut)).map(([p]) => p);
    }
    if (best.length < 60 || elongation(best, w) < 2.5) return null;
    let x0 = w, y0 = this.h, x1 = 0, y1 = 0;
    for (const p of best) { const x = p % w, y = (p / w) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const d2 = this.locateTip(best, { minX: x0, minY: y0, maxX: x1, maxY: y1 }, 0, { x: ux, y: uy });
    // ein unsicherer zweiter Pfeil ist eher ein Glanzlicht oder Rand des ersten
    return d2 && d2.conf >= 0.3 && Math.hypot(d2.board.x, d2.board.y) < 190 ? d2 : null;
  }

  /**
   * Teile desselben Pfeils zusammenführen. Ein dunkler Schaft vor dunklem Grund ist unsichtbar, Flight
   * und Barrel sind dann getrennt. Sie gehören zusammen, wenn der längliche Teil (Barrel) genau auf den
   * anderen zeigt und der Abstand zu einem Pfeil passt – unabhängig davon, wie schräg er steckt.
   */
  mergeParts(comps) {
    const { w } = this;
    const s = this.pxPerMm;
    const stat = (px) => {
      let mx = 0, my = 0;
      for (const p of px) { mx += p % w; my += (p / w) | 0; }
      mx /= px.length; my /= px.length;
      let cxx = 0, cxy = 0, cyy = 0;
      for (const p of px) { const dx = (p % w) - mx, dy = ((p / w) | 0) - my; cxx += dx * dx; cxy += dx * dy; cyy += dy * dy; }
      const n = px.length; cxx /= n; cxy /= n; cyy /= n;
      const tr = cxx + cyy, det = cxx * cyy - cxy * cxy, disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
      const l1 = tr / 2 + disc, l2 = Math.max(1e-6, tr / 2 - disc);
      const ax = Math.abs(cxy) > 1e-9 ? l1 - cyy : cxx >= cyy ? 1 : 0, ay = Math.abs(cxy) > 1e-9 ? cxy : cxx >= cyy ? 0 : 1;
      const an = Math.hypot(ax, ay) || 1;
      return { x: mx, y: my, ax: ax / an, ay: ay / an, el: Math.sqrt(l1 / l2), n };
    };
    const prior = this.priorDir();
    const main = comps[0];
    let pixels = main.px.slice();
    const bb = { ...main.bbox };
    const merged = [main];
    let gs = stat(pixels);
    const maxDist = 125 * s;
    for (let changed = true; changed;) {
      changed = false;
      for (const c of comps) {
        if (merged.includes(c)) continue;
        const cs = c.s || (c.s = stat(c.px));
        const dx = cs.x - gs.x, dy = cs.y - gs.y, dist = Math.hypot(dx, dy);
        if (dist > maxDist + 10) continue;
        const b = c.bbox;
        const gx = Math.max(0, Math.max(b.minX - bb.maxX, bb.minX - b.maxX)), gy = Math.max(0, Math.max(b.minY - bb.maxY, bb.minY - b.maxY));
        const gap = Math.hypot(gx, gy);
        const perpTo = (o, px, py) => Math.abs((px - o.x) * o.ay - (py - o.y) * o.ax);
        let ok = false;
        const lim = 5 + 4 * s + 0.07 * dist;
        if (gs.el >= 2.2) ok = perpTo(gs, cs.x, cs.y) <= lim;
        if (!ok && cs.el >= 2.2 && gs.el < 3.5) ok = perpTo(cs, gs.x, gs.y) <= lim;
        // teilweise verdeckter Flight wirkt selbst länglich: dann zählt die Achse des schmaleren Teils (Barrel)
        if (!ok && cs.el >= 3.5 && cs.el > 0.9 * gs.el) ok = perpTo(cs, gs.x, gs.y) <= 4 + 3 * s + 0.05 * dist && Math.abs(gs.ax * cs.ax + gs.ay * cs.ay) > 0.8;
        // zwei eigenständige schmale Teile (zwei Barrels) müssen auch in dieselbe Richtung zeigen;
        // ein teilweise sichtbarer Flight kann quer zur Achse länglich sein (bis ca. 4:1)
        if (ok && gs.el >= 5 && cs.el >= 5) ok = Math.abs(gs.ax * cs.ax + gs.ay * cs.ay) > 0.94;
        if (!ok && gs.el < 2.2 && cs.el < 2.2) {
          const dir = prior || this.expectedDir(gs.x, gs.y);
          if (dir && (prior || dir.len > 45)) ok = Math.abs(dx * dir.y - dy * dir.x) <= 5 + (prior ? 0.3 : 0.6) * dist;
        }
        // kleine Splitter direkt daneben
        if (!ok && c.px.length < 0.15 * pixels.length && gap <= 4 + 2 * s) ok = true;
        if (!ok || c.px.length < Math.max(12, 0.01 * pixels.length)) continue;
        pixels = pixels.concat(c.px);
        bb.minX = Math.min(bb.minX, b.minX); bb.minY = Math.min(bb.minY, b.minY);
        bb.maxX = Math.max(bb.maxX, b.maxX); bb.maxY = Math.max(bb.maxY, b.maxY);
        merged.push(c); gs = stat(pixels); changed = true;
      }
    }
    return { pixels, bb, merged };
  }

  /** Gruppe von Bildpunkten → Pfeil (Spitze, Feld, Konfidenz) oder null */
  groupToDart(pixels, bb, extra, fresh = 0) {
    const { w } = this;
    const minPx = this.opts.minDartFraction * this.roi.length;
    // Enge Gruppe: Berührt die Veränderung steckende Pfeile und ist sie nicht klar länglich
    // (z. B. neuer Pfeil + angestoßener alter Pfeil = V-Form), nur die dominante Gerade auswerten
    let cluster = false;
    if (this.occ && this.dartsOnBoard > 0) {
      let touchOcc = 0;
      for (let k = 0; k < pixels.length; k += 3) if (this.occ[pixels[k]]) touchOcc++;
      if (touchOcc > 3 && elongation(pixels, w) < 2.5) {
        // mind. gut die Hälfte eines ganzen Pfeils (ca. 140 mm) muss auf der Geraden liegen
        const exp = this.expectedDir(pixels[0] % w, (pixels[0] / w) | 0);
        const line = dominantLine(pixels, w, exp && exp.len > 12 ? 0.55 * exp.len * 1.4 : 0);
        if (line && line.inliers.length >= Math.max(minPx, 0.15 * pixels.length)) {
          pixels = line.inliers; cluster = true;
          let x0 = w, y0 = this.h, x1 = 0, y1 = 0;
          for (const p of pixels) { const x = p % w, y = (p / w) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
          bb = { minX: x0, minY: y0, maxX: x1, maxY: y1 };
        }
      }
    }
    const det = this.locateTip(pixels, bb, extra);
    if (det && !cluster && det.axis.elong < 2 && det.reasons.includes('Veränderung länger als ein Pfeil')) return null;
    if (det && cluster) {
      det.conf *= 0.6; det.reasons.push('aus einer Pfeilgruppe herausgelöst');
      // In der Gruppe ist der neue Pfeil oft nur teilweise sichtbar: kürzer als ein ganzer Pfeil
      // oder kontrastarmes Spitzenende → eher nachfragen
      if (det.axis.expLen > 12 && det.axis.length < 1.5 * det.axis.expLen) { det.conf *= 0.6; det.reasons.push('in der Gruppe nur teilweise sichtbar'); }
      if (det.axis.endContrast < 45) det.conf *= 0.75;
    }
    // kleine Veränderung: nur als Pfeil werten, wenn sie deutlich länglich ist
    if (pixels.length < this.opts.smallDartFraction * this.roi.length) {
      if (det.axis.elong < 3) {
        // mehrere getrennte Stücke, zusammen so groß wie ein Pfeil: lieber nachfragen als verpassen
        if (fresh < this.opts.smallDartFraction * this.roi.length || !(Math.hypot(det.board.x, det.board.y) < 200)) return null;
        det.conf = Math.min(det.conf, 0.4);
      }
      det.conf *= 0.6; det.reasons.push('nur teilweise sichtbar');
    }
    return det;
  }

  /**
   * Mittellinie des vorderen Pfeilteils: je Scheibe quer zur Achse die Mitte, dann Ausgleichsgerade mit
   * Ausreißer-Verwerfung. Liefert Startpunkt nahe der Spitze und Richtung zur Spitze oder null.
   */
  frontLine(pixels, t, mx, my, ux, uy, tEnd, atMin, L) {
    const { w } = this, s = this.pxPerMm;
    const nx = -uy, ny = ux, bins = new Map();
    for (let k = 0; k < pixels.length; k++) {
      const q = atMin ? t[k] - tEnd : tEnd - t[k];
      if (q > 0.5 * L) continue;
      const pe = ((pixels[k] % w) - mx) * nx + (((pixels[k] / w) | 0) - my) * ny;
      const b = Math.floor(q / 2);
      let e = bins.get(b); if (!e) bins.set(b, (e = { n: 0, s: 0, lo: Infinity, hi: -Infinity }));
      e.n++; e.s += pe; if (pe < e.lo) e.lo = pe; if (pe > e.hi) e.hi = pe;
    }
    let pts = [];
    for (const [b, e] of bins) if (e.n >= 2 && e.hi - e.lo <= 12 * s + 3) pts.push({ q: b * 2 + 1, p: e.s / e.n });
    if (pts.length < 8) return null;
    let a = 0, c = 0;
    for (let it = 0; it < 4; it++) {
      let sw = 0, sq = 0, sp = 0, sqq = 0, sqp = 0;
      for (const v of pts) { sw++; sq += v.q; sp += v.p; sqq += v.q * v.q; sqp += v.q * v.p; }
      const den = sw * sqq - sq * sq; if (Math.abs(den) < 1e-6) return null;
      c = (sw * sqp - sq * sp) / den; a = (sp - c * sq) / sw;
      const res = pts.map((v) => Math.abs(v.p - a - c * v.q)), lim = Math.max(1.2, 2.2 * (res.reduce((x, y) => x + y, 0) / res.length));
      const keep = pts.filter((v, i) => res[i] <= lim);
      if (keep.length === pts.length || keep.length < 8) break;
      pts = keep;
    }
    if (Math.abs(c) > 0.2) return null;
    const sg = atMin ? 1 : -1, at = (q) => ({ x: mx + ux * (tEnd + sg * q) + nx * (a + c * q), y: my + uy * (tEnd + sg * q) + ny * (a + c * q) });
    const p0 = at(0), p1 = at(1), dx = p0.x - p1.x, dy = p0.y - p1.y, l = Math.hypot(dx, dy);
    return { start: at(0.03 * L), dx: dx / l, dy: dy / l };
  }

  /**
   * Wahrscheinlichkeit, dass das gemeldete Feld stimmt: Anteil der möglichen Spitzenlagen im selben Feld.
   * dir: Richtung zur Spitze entlang (ux, uy); tail: so weit (px) kann sie unsichtbar weitergehen.
   */
  fieldProbability(tip, b, hit, ux, uy, dir, { sure, tail, tailWeight, toBoard }) {
    const tx = ux * dir, ty = uy * dir;
    const at = (al, ac) => { const q = toBoard({ x: tip.x + tx * al - ty * ac, y: tip.y + ty * al + tx * ac }); return Number.isFinite(q.x) ? scoreAt(q.x, q.y).label : ''; };
    const perPx = (q) => Math.hypot(q.x - b.x, q.y - b.y) || 1;
    const mmA = perPx(toBoard({ x: tip.x + tx, y: tip.y + ty })), mmC = perPx(toBoard({ x: tip.x - ty, y: tip.y + tx }));
    const sA = sure ? 0.45 + 0.15 / mmA : 2 / mmA, sC = sure ? 0.35 + 0.15 / mmC : 1.2 / mmC; // Streuung in px
    const G = [[-2, 0.054], [-1, 0.242], [0, 0.399], [1, 0.242], [2, 0.054]];
    let same = 0, sum = 0;
    for (const [i, wi] of G) for (const [j, wj] of G) { const g = wi * wj; sum += g; if (at(i * sA, j * sC) === hit.label) same += g; }
    const p0 = same / sum;
    if (!(tailWeight > 0)) return { p: p0, byTail: false };
    let t = 0; const n = 6;
    for (let k = 1; k <= n; k++) for (const [j, wj] of G) if (at((k / n) * tail, j * sC) === hit.label) t += wj / 0.991;
    const pT = t / n, p = (1 - tailWeight) * p0 + tailWeight * pT;
    return { p, byTail: pT < p0 - 0.05 };
  }

  /** Größte Bildlänge (px) eines Pfeils an dieser Stelle (beliebig schräg, bis 45°) */
  maxDartLen(px, py) {
    const b = applyH(this.Hinv, px + 0.5, py + 0.5);
    if (!this.cam || !Number.isFinite(b.x)) return Infinity;
    const p0 = this.cam.point(b.x, b.y, 0);
    let m = 0;
    for (const [r, z] of [[0, 150], [75, 130], [106, 106]]) for (let k = 0; k < 8; k++) { const q = this.cam.point(b.x + r * Math.cos((k * Math.PI) / 4), b.y + r * Math.sin((k * Math.PI) / 4), z); m = Math.max(m, Math.hypot(q.x - p0.x, q.y - p0.y)); }
    return m;
  }

  /** Erwartete Bildrichtung Spitze → Flight am Bildpunkt (px); len = Länge (px) für 100 mm Pfeil */
  expectedDir(px, py) {
    if (!this.cam) return null;
    const b = applyH(this.Hinv, px + 0.5, py + 0.5);
    if (!Number.isFinite(b.x)) return null;
    const p0 = this.cam.point(b.x, b.y, 0), p1 = this.cam.point(b.x, b.y, 100);
    const dx = p1.x - p0.x, dy = p1.y - p0.y, len = Math.hypot(dx, dy);
    if (!(len > 1e-6)) return null;
    // Pfeile stecken selten exakt senkrecht: typische Neigungen (Flight höher/tiefer/seitlich)
    const variants = [[0, 45], [0, -15], [30, 10], [-30, 10]].map(([ox, oy]) => {
      const q = this.cam.point(b.x + ox, b.y + oy, 100);
      const vx = q.x - p0.x, vy = q.y - p0.y, vl = Math.hypot(vx, vy) || 1;
      return { x: vx / vl, y: vy / vl };
    });
    return { x: dx / len, y: dy / len, len, variants };
  }

  /** Ungeglättetes Bild und ausgerichtete ungeglättete Referenz (nur für die dünne Spitze) */
  rawImages() {
    const p = this.pair;
    if (!p) return { cur: this.cur, ref: this.refImg };
    if (!p.raw) { const cur = rawOf.get(p.cur) || p.cur, ref = rawOf.get(p.ref) || p.ref; p.raw = { cur, ref: warpRef(cur, ref, p.T, this.w, this.h, this.roi) }; }
    return p.raw;
  }

  /**
   * Verfolgt die dünne Spitze vom Ende der Pfeilregion weiter nach außen: Die Spitze ist nur
   * 1–3 px breit und fällt nach der Glättung oft unter die Schwelle. (dx, dy) zeigt zur Spitze.
   */
  extendTip(p, dx, dy, maxGap = 0) {
    const { diff, w, h } = this;
    const low = this.lowThr || this.opts.diffThreshold * 0.45;
    const R = this.rawImages(), st = w * 4, tol = this.opts.edgeTolerance;
    const rawThr = Math.max(18, 1.8 * low); // ungeglättet rauscht stärker
    const rawDev = (i) => { const r = tolDev(R.cur, R.ref, i, st, tol), g = tolDev(R.cur, R.ref, i + 1, st, tol), l = tolDev(R.cur, R.ref, i + 2, st, tol); return ((r + g + l) / 3 + Math.max(r, g, l)) / 2; };
    const at = (x, y) => {
      const xi = Math.round(x), yi = Math.round(y);
      if (xi < 2 || yi < 2 || xi >= w - 2 || yi >= h - 2) return 0;
      const p = yi * w + xi, v = diff[p];
      if (v >= low) return v;
      // die dünne Spitze wird durch die Glättung blasser: im Original nachsehen
      const d = rawDev(p * 4);
      return d < rawThr || isShadowAt(R.cur, R.ref, p * 4, st) ? v : d;
    };
    // quer zur Achse ±1 px (die Spitze ist dünn und nicht exakt auf der Achse), weiter weg ±2 px
    const sample = (s, r) => {
      const x = p.x + dx * s, y = p.y + dy * s;
      let v = 0;
      for (let o = -r; o <= r; o++) v = Math.max(v, at(x - dy * o, y + dx * o));
      return v;
    };
    let last = 0, gap = 0, s = 0.5;
    const trace = (from) => {
      gap = 0;
      for (s = from; s <= from + 40; s += 0.5) {
        if (sample(s, 1) >= low) { last = s; gap = 0; } else if (++gap > 2) break;
      }
    };
    trace(0.5);
    this.bridged = 0;
    // Lücke (bis ca. 14 mm), z. B. wo die Spitze genau auf einer Feldgrenze liegt: nur über ein
    // deutlich sichtbares Stück dahinter
    if (last) {
      const strong = Math.max(24, low * 2);
      for (let g = 0; g < 2; g++) {
        let run = 0, found = 0;
        for (let t = last + 1.5; t <= last + 14 * this.pxPerMm; t += 0.5) {
          if (sample(t, 1) >= strong) { if (++run >= 4) { found = t - 1.5; break; } } else run = 0;
        }
        if (!found || this.isOcc({ x: p.x + dx * found, y: p.y + dy * found })) break;
        last = found;
        trace(found);
      }
    }
    // Eine graue Spitze vor hellem Feld sieht wie ein Schatten aus und wurde ausgefiltert. Ein kurzes Stück
    // genau in Verlängerung gehört zur Spitze; geht es länger weiter, ist es wirklich ein Schatten.
    if (last && this.cur && this.refImg) {
      const thr = Math.max(16, low * 1.5);
      const raw = (x, y) => {
        const xi = Math.round(x), yi = Math.round(y);
        return xi < 2 || yi < 2 || xi >= w - 2 || yi >= h - 2 ? 0 : rawDev((yi * w + xi) * 4);
      };
      const maxLen = 6 * this.pxPerMm;
      let end = last, miss = 0;
      for (let t = last + 0.5; t <= last + 2 * maxLen; t += 0.5) {
        const x = p.x + dx * t, y = p.y + dy * t;
        if (Math.max(raw(x, y), raw(x - dy, y + dx), raw(x + dy, y - dx)) >= thr) { end = t; miss = 0; } else if (++miss > 2) break;
      }
      if (end - last <= maxLen && !this.isOcc({ x: p.x + dx * end, y: p.y + dy * end })) last = end;
    }
    // Unsichtbares Stück überbrücken (z. B. schwarzes Barrel vor schwarzem Feld, silber vor Creme):
    // weiter entlang der Achse nach einem zusammenhängenden Stück (≥ 3 px) suchen
    for (let bridges = 0; bridges < 2 && maxGap > 0; bridges++) {
      let run = 0, found = 0;
      for (let t = last + 2; t <= last + maxGap; t += 0.5) {
        if (sample(t, 2) >= low) { if (++run >= 6) { found = t - 2.5; break; } } else run = 0;
      }
      if (!found) break;
      this.bridged += found - last;
      last = found;
      trace(found);
    }
    if (!last) return { x: p.x + dx * this.opts.tipExtend, y: p.y + dy * this.opts.tipExtend };
    // Das sichtbare Ende reicht um den Spitzenradius (+ Unschärfe) über den Einstichpunkt hinaus
    const e = { x: p.x + dx * last, y: p.y + dy * last };
    const b = applyH(this.Hinv, e.x + 0.5, e.y + 0.5);
    let back = this.opts.tipBlurPx;
    if (Number.isFinite(b.x)) {
      const q0 = applyH(this.Hpx, b.x, b.y), qx = applyH(this.Hpx, b.x + 1, b.y), qy = applyH(this.Hpx, b.x, b.y + 1);
      const pxPerMm = Math.max(Math.hypot(qx.x - q0.x, qx.y - q0.y), Math.hypot(qy.x - q0.x, qy.y - q0.y));
      if (Number.isFinite(pxPerMm)) back += this.opts.tipRadiusMm * pxPerMm;
    }
    const sEnd = last - back;
    return { x: p.x + dx * sEnd, y: p.y + dy * sEnd };
  }

  /** dirHint: bekannte Richtung Spitze → Flight (z. B. vom Nachbarpfeil) */
  locateTip(pixels, bbox, otherBlobs, dirHint = null) {
    const w = this.w;
    const n = pixels.length;
    let mx = 0, my = 0;
    for (const p of pixels) { mx += p % w; my += (p / w) | 0; }
    mx /= n; my /= n;
    let cxx = 0, cxy = 0, cyy = 0;
    for (const p of pixels) {
      const dx = (p % w) - mx, dy = ((p / w) | 0) - my;
      cxx += dx * dx; cxy += dx * dy; cyy += dy * dy;
    }
    cxx /= n; cxy /= n; cyy /= n;
    const tr = cxx + cyy, det = cxx * cyy - cxy * cxy;
    const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
    const l1 = tr / 2 + disc, l2 = Math.max(1e-6, tr / 2 - disc);
    let ux, uy;
    if (Math.abs(cxy) > 1e-9) { ux = l1 - cyy; uy = cxy; } else if (cxx >= cyy) { ux = 1; uy = 0; } else { ux = 0; uy = 1; }
    const un = Math.hypot(ux, uy); ux /= un; uy /= un;
    let elong = Math.sqrt(l1 / l2);

    // Erwartete Pfeilrichtung (Spitze → Flight) aus dem Kameramodell: Pfeile stecken ungefähr
    // senkrecht in der Scheibe. Stark bei seitlicher Kamera, schwach bei frontalem Blick.
    const exp = this.expectedDir(mx, my);
    let dot = exp ? ux * exp.x + uy * exp.y : 0;
    // gedrungene Form (Pfeil zeigt fast zur Kamera) → Achse aus der Geometrie übernehmen
    let axisFromModel = false;
    const spreadOk = exp && exp.variants.every((v) => v.x * exp.x + v.y * exp.y > 0.8);
    const prior = dirHint || this.priorDir();
    if (elong < 2 && (prior || (exp && exp.len > 12))) { const d = prior || exp; ux = d.x; uy = d.y; dot = prior && exp ? ux * exp.x + uy * exp.y : 1; axisFromModel = true; }

    // Projektionen entlang der Achse
    const t = new Float32Array(n);
    let tmin = Infinity, tmax = -Infinity;
    for (let k = 0; k < n; k++) {
      const p = pixels[k];
      const v = ((p % w) - mx) * ux + (((p / w) | 0) - my) * uy;
      t[k] = v; if (v < tmin) tmin = v; if (v > tmax) tmax = v;
    }
    const L = Math.max(1, tmax - tmin);
    const seg = 0.2 * L;
    let cntMin = 0, cntMax = 0;
    for (let k = 0; k < n; k++) { if (t[k] <= tmin + seg) cntMin++; if (t[k] >= tmax - seg) cntMax++; }
    const thinIsMin = cntMin <= cntMax;
    const widthRatio = Math.min(cntMin, cntMax) / Math.max(1, Math.max(cntMin, cntMax));
    // Geometrie eindeutig genug? (Pfeil ragt im Bild sichtbar heraus und Achse passt zur Erwartung)
    // … und die Richtung bleibt auch bei typisch schräg steckenden Pfeilen eindeutig
    const signOk = exp && exp.variants.every((v) => (ux * v.x + uy * v.y) * Math.sign(dot) > 0.2);
    const nearlyPerp = exp && exp.len > 12 && Math.abs(dot) > 0.45 && (signOk || axisFromModel) && (elong >= 2 || axisFromModel);
    // Jeder Pfeil steckt anders schräg. Deshalb für beide Zuordnungen (Spitze am einen oder am
    // anderen Ende) prüfen, wie schräg ein echter Steeldart (100–175 mm) dafür stecken müsste.
    // Nur die richtige Zuordnung ergibt eine plausible Neigung – unabhängig von der Neigung selbst.
    const rawEnd = (atMin) => {
      const lim = atMin ? tmin + 0.04 * L : tmax - 0.04 * L;
      let sx = 0, sy = 0, c = 0;
      for (let k = 0; k < n; k++) if (atMin ? t[k] <= lim : t[k] >= lim) { sx += pixels[k] % w; sy += (pixels[k] / w) | 0; c++; }
      return { x: sx / c + 0.5, y: sy / c + 0.5 };
    };
    let tiltMin = Infinity, tiltMax = Infinity;
    if (this.cam && (elong >= 2 || axisFromModel)) {
      const eMin = rawEnd(true), eMax = rawEnd(false);
      // ohne klar breites Ende ist kein Flight zu sehen → es kann auch nur ein Stück (Barrel) sein
      const Lmin = widthRatio > 0.6 ? 45 : 100;
      tiltMin = this.cam.impliedTilt(eMin, eMax, Lmin); // Spitze am min-Ende
      tiltMax = this.cam.impliedTilt(eMax, eMin, Lmin); // Spitze am max-Ende
    }
    const tBest = Math.min(tiltMin, tiltMax), tOther = Math.max(tiltMin, tiltMax);
    // Widerspricht die Form deutlich (schmales Ende = Spitze, breites = Flight), muss die Geometrie
    // eindeutiger sein – das Kameramodell kann z. B. bei fast frontaler Kamera ungenau sein.
    const geoTipMin = tiltMin < tiltMax;
    const shapeContradicts = widthRatio < 0.5 && thinIsMin !== geoTipMin;
    const geoDecided = tBest <= 60 && tOther - tBest >= (shapeContradicts ? 40 : widthRatio > 0.6 ? 25 : 15);
    const pd = prior ? ux * prior.x + uy * prior.y : 0;
    const priorDecided = Math.abs(pd) > 0.8;
    const geoStrong = geoDecided || nearlyPerp || priorDecided;
    const tipAtMin = dirHint && priorDecided ? pd > 0 : geoDecided ? tiltMin < tiltMax : priorDecided ? pd > 0 : nearlyPerp ? dot > 0 : thinIsMin;
    const dirConflict = (geoDecided && nearlyPerp && !priorDecided && (tiltMin < tiltMax) !== (dot > 0)) || (priorDecided && tipAtMin !== (pd > 0));
    const dartTilt = tipAtMin ? tiltMin : tiltMax;

    const endPoint = (atMin, maxGap = 0) => {
      const lim = atMin ? tmin + 0.04 * L : tmax - 0.04 * L;
      let sx = 0, sy = 0, c = 0;
      for (let k = 0; k < n; k++) {
        if (atMin ? t[k] <= lim : t[k] >= lim) { sx += pixels[k] % w; sy += (pixels[k] / w) | 0; c++; }
      }
      return this.extendTip({ x: sx / c, y: sy / c }, atMin ? -ux : ux, atMin ? -uy : uy, maxGap);
    };
    // Bei sicherer Richtung darf die Spitzensuche ein unsichtbares Stück (dunkles/silbernes
    // Barrel vor gleichfarbigem Grund) überbrücken – bis ca. 70 mm Pfeillänge
    const fullLen = (bx, by) => { const p0 = this.cam.point(bx, by, 0), p1 = this.cam.point(bx, by, 138); return Math.hypot(p1.x - p0.x, p1.y - p0.y); };
    const altPx = endPoint(!tipAtMin);
    // Der breite Flight zieht die Hauptachse zur Seite. Für die Spitze zählt die Mittellinie des
    // vorderen, schmalen Teils (Barrel und Spitze).
    const front = this.frontLine(pixels, t, mx, my, ux, uy, tipAtMin ? tmin : tmax, tipAtMin, L);
    const tipEnd = (maxGap = 0) => (front ? this.extendTip(front.start, front.dx, front.dy, maxGap) : endPoint(tipAtMin, maxGap));
    if (front) { const sg = tipAtMin ? -1 : 1; ux = front.dx * sg; uy = front.dy * sg; }
    let tipPx = tipEnd();
    let bridged = 0;
    let visRatio = 1;
    const ratioOf = (p) => { const bb = applyH(this.Hinv, p.x + 0.5, p.y + 0.5); return Number.isFinite(bb.x) ? Math.hypot(p.x - altPx.x, p.y - altPx.y) / fullLen(bb.x, bb.y) : 1; };
    if (geoStrong) {
      visRatio = ratioOf(tipPx);
      // sichtbarer Pfeil zu kurz → vorne fehlt evtl. ein kontrastloses Stück: überbrücken,
      // aber nicht länger als ein ganzer Pfeil und nicht auf einen anderen Pfeil
      // (gedrungene Form bei seitlicher Kamera = vorderer Teil fehlt sehr wahrscheinlich)
      if (visRatio < 0.95 || (axisFromModel && exp.len > 30)) {
        // höchstens eine Barrel-Länge (ca. 50 mm) überbrücken
        const cand = tipEnd(0.6 * exp.len);
        const r2 = ratioOf(cand);
        if (this.bridged > 0 && r2 <= 1.1 && !this.isOcc(cand)) { tipPx = cand; bridged = this.bridged; visRatio = r2; }
      }
    }
    const toBoard = (p) => { const c = this.toCalib(p.x, p.y); return applyH(this.Hinv, c.x + 0.5, c.y + 0.5); };
    let tipB = toBoard(tipPx), altB = toBoard(altPx);
    let usedAlt = false;
    const rTip = Math.hypot(tipB.x, tipB.y), rAlt = Math.hypot(altB.x, altB.y);
    // Spitze muss auf der Scheibe liegen; wenn nur das andere Ende plausibel ist, dieses nehmen
    if (!geoStrong && rTip > 200 && rAlt <= 175 && widthRatio > 0.5) { usedAlt = true; }
    let tip = usedAlt ? altPx : tipPx;
    let b = usedAlt ? altB : tipB;

    // Ein ganzer Steeldart (ca. 140 mm) hat an dieser Stelle eine ungefähr bekannte Bildlänge
    // (±25 % je nach Neigung). Deutlich kürzer → vorderes Stück nicht sichtbar → Rückfrage.
    const estimated = false;
    // gedrungene Form, obwohl ein ganzer Pfeil hier lang erscheinen müsste → nur ein Teil sichtbar
    const stubby = axisFromModel && !bridged && exp.len > 30;
    const partial = geoStrong && !usedAlt && (visRatio < 0.7 || stubby);
    const hit = scoreAt(b.x, b.y);

    // Konfidenz aus nachvollziehbaren Faktoren
    const reasons = [];
    let conf = 1;
    if (geoStrong) {
      // Richtung aus Geometrie; Form nur als Zusatzkontrolle
      if (elong < 2.5 && !axisFromModel) conf *= 0.85;
      if (axisFromModel) { conf *= spreadOk ? 0.7 : 0.5; reasons.push('Pfeil zeigt fast zur Kamera'); }
      if (!geoDecided && Math.abs(dot) < 0.7) { conf *= 0.92; reasons.push('Pfeil stark schräg'); }
      if (thinIsMin !== tipAtMin && widthRatio < 0.6) { conf *= 0.85; reasons.push('Form widerspricht Pfeilrichtung'); }
      if (dirConflict) { conf *= 0.6; reasons.push('Pfeilrichtung unklar'); }
      // beide Enden gleich breit und die Neigung nicht deutlich verschieden → evtl. nur Flight oder nur Barrel zu sehen
      if (widthRatio > 0.8 && !axisFromModel && tOther - tBest < 35) { conf *= 0.55; reasons.push('Spitze/Flight nicht unterscheidbar'); }
      if (!geoDecided && !axisFromModel) conf *= 0.92; // nur über die Senkrecht-Annahme entschieden
    } else {
      // weder Geometrie noch gelernte Richtung entscheiden, welches Ende die Spitze ist
      conf *= 0.55; reasons.push('Pfeilrichtung nicht eindeutig');
      if (elong < 2.5) { conf *= 0.55; reasons.push('Form wenig länglich'); }
      else if (elong < 4) conf *= 0.85;
      if (widthRatio > 0.85) { conf *= 0.45; reasons.push('Spitze/Flight nicht unterscheidbar'); }
      else if (widthRatio > 0.6) { conf *= 0.75; reasons.push('Spitzenrichtung unsicher'); }
    }
    if (usedAlt) { conf *= 0.6; reasons.push('Spitze am breiteren Ende angenommen'); }
    if (estimated) { conf *= 0.3; reasons.push('Spitze kaum sichtbar – Lage über Pfeillänge geschätzt'); }
    else if (partial) { conf *= 0.5; reasons.push('Pfeil nur teilweise sichtbar'); }
    else if (bridged > 2) { conf *= 0.65; reasons.push('Spitze über kontrastarmes Stück verfolgt'); }
    // Veränderung deutlich länger als ein ganzer Pfeil sein kann → Teile anderer Pfeile mit erfasst
    if (L > 1.15 * this.maxDartLen(mx, my)) { conf *= 0.5; reasons.push('Veränderung länger als ein Pfeil'); }
    // nur ein kurzes Stück sichtbar (weniger als gut die Hälfte eines Pfeils) → Richtung und Spitze unsicher
    if (exp && exp.len > 12 && L < 0.95 * exp.len) { conf *= 0.6; reasons.push('nur ein kurzes Stück des Pfeils sichtbar'); }
    if (hit.r > 175 && hit.r < 190) { conf *= 0.55; reasons.push('knapp außerhalb des Doppels'); }
    // ein „Fehlwurf“ weit draußen ist selten; oft fehlt nur der vordere Pfeilteil → nachfragen
    else if (hit.r >= 190) { conf *= 0.55; reasons.push('außerhalb der Wertungsfläche'); }
    // Liegt die Spitze direkt auf/an einem schon steckenden Pfeil? (Nur Überschneidung der
    // Umrisse reicht nicht – in einer engen Gruppe überschneiden sich die Umrisse fast immer.)
    if (this.isOcc(tip)) { conf *= 0.75; reasons.push('Spitze liegt an einem anderen Pfeil'); }
    // Liegt die Spitze mitten am Körper eines steckenden Pfeils, kann es auch dieser Pfeil selbst sein,
    // der angestoßen wurde (nahe seiner Spitze bewegt er sich nicht, weiter hinten schon)
    for (const s of this.segs || []) {
      const sx = s.far.x - s.tip.x, sy = s.far.y - s.tip.y, sl = Math.hypot(sx, sy) || 1;
      const al = ((tip.x - s.tip.x) * sx + (tip.y - s.tip.y) * sy) / sl, pe = Math.abs((tip.x - s.tip.x) * sy - (tip.y - s.tip.y) * sx) / sl;
      if (al > 14 && al < sl && pe < 4 + 0.16 * al) { conf *= 0.55; reasons.push('evtl. nur ein angestoßener Pfeil'); break; }
    }
    // stecken schon Pfeile, deuten weitere Veränderungen auf angestoßene Pfeile hin → nachfragen
    if (otherBlobs > 2) { conf *= this.dartsOnBoard > 0 ? 0.55 : 0.8; reasons.push('weitere Bildveränderungen'); }
    // Kontrast am Spitzenende: Ist das Pfeilende (z. B. schwarze Spitze/Barrel) farblich kaum vom
    // Untergrund direkt dahinter zu unterscheiden (schwarz vor schwarzem Feld, silber vor Creme),
    // kann die Spitze unsichtbar weitergehen → Rückfrage statt Raten.
    let endContrast = 255;
    if (this.cur && this.refImg && !usedAlt) {
      const atMinEnd = tipAtMin;
      const tdx = atMinEnd ? -ux : ux, tdy = atMinEnd ? -uy : uy;
      const avg = (data, off, s0, s1, r) => {
        const c = [0, 0, 0]; let k = 0;
        for (let s = s0; s <= s1; s += 1) for (let o = -r; o <= r; o++) {
          const x = Math.round(tip.x + tdx * s - tdy * o), y = Math.round(tip.y + tdy * s + tdx * o);
          if (x < 0 || y < 0 || x >= this.w || y >= this.h) continue;
          const i = (y * this.w + x + off) * 4;
          c[0] += data[i]; c[1] += data[i + 1]; c[2] += data[i + 2]; k++;
        }
        return k ? c.map((v) => v / k) : null;
      };
      const R = this.rawImages();
      const end = avg(R.cur, 0, -6, -2, 0), beyond = avg(R.ref, 0, 2, 8, 1);
      if (end && beyond) {
        const e = end.map((v, i) => Math.abs(v - beyond[i]));
        endContrast = ((e[0] + e[1] + e[2]) / 3 + Math.max(...e)) / 2;
      }
    }
    // Wie wahrscheinlich stimmt das Feld? Messfehler der Spitze (wächst mit den mm pro Bildpunkt) und,
    // bei wenig Kontrast am Ende, eine Spitze, die unsichtbar bis zu 20 mm weitergeht.
    const pField = this.fieldProbability(tip, b, hit, ux, uy, tipAtMin !== usedAlt ? -1 : 1, {
      sure: geoStrong && !axisFromModel, tail: 0.15 * L, tailWeight: !geoStrong || usedAlt ? 0 : endContrast < 15 ? 0.45 : endContrast < 35 ? 0.25 : 0.05, toBoard });
    conf *= pField.p ** 1.6;
    if (pField.p < 0.93) reasons.push(pField.byTail ? 'Spitze kaum vom Untergrund zu unterscheiden' : pField.p < 0.75 ? 'direkt am Draht' : 'nahe am Draht');
    // kein Kontrast am Ende und der Pfeil ist kürzer als üblich oder gedrungen: vorderer Teil vermutlich unsichtbar
    if (geoStrong && !usedAlt && endContrast < 35 && (visRatio < 0.9 || elong < 2.5)) { conf *= 0.6; if (pField.p >= 0.93 || !pField.byTail) reasons.push('Spitze kaum vom Untergrund zu unterscheiden'); }
    // Spitze hinter einem bereits steckenden Pfeil? Dann ist der sichtbare Teil deutlich kürzer
    // als ein ganzer Pfeil und endet direkt an dessen Pixeln → Spitze liegt weiter vorne, unsicher.
    let occTouch = false;
    if (this.occ && exp && exp.len > 12) {
      const atMinEnd = usedAlt ? !tipAtMin : tipAtMin;
      const tdx = atMinEnd ? -ux : ux, tdy = atMinEnd ? -uy : uy;
      let touches = false;
      for (let s = 0; s <= 6 && !touches; s += 1) {
        const x = Math.round(tip.x + tdx * s), y = Math.round(tip.y + tdy * s);
        for (let o = -2; o <= 2 && !touches; o++) {
          const xx = x - Math.round(tdy * o), yy = y + Math.round(tdx * o);
          if (xx >= 0 && yy >= 0 && xx < this.w && yy < this.h && this.occ[yy * this.w + xx]) touches = true;
        }
      }
      occTouch = touches;
      // ein ganzer Pfeil ist im Bild ca. 1,5–1,8 × so lang wie 100 mm senkrecht zur Scheibe
      if (touches && L < 1.3 * exp.len) { conf *= 0.4; reasons.push('Spitze evtl. von anderem Pfeil verdeckt'); }
      else if (touches) { conf *= 0.65; reasons.push('Spitze grenzt an anderen Pfeil (evtl. verdeckt)'); }
    }

    return {
      tip: { x: (tip.x + 0.5) / this.w, y: (tip.y + 0.5) / this.h },
      far: { x: altPx.x, y: altPx.y }, tipPx: { x: tip.x, y: tip.y },
      board: { x: b.x, y: b.y },
      hit: { seg: hit.seg, mult: hit.mult, score: hit.score, label: hit.label, wireDist: hit.wireDist, r: hit.r },
      conf: Math.max(0, Math.min(1, conf)),
      reasons,
      bbox,
      axis: { elong, widthRatio, length: L, expLen: exp ? exp.len : 0, occTouch, visRatio, bridged, estimated, endContrast, tilt: dartTilt, tiltOther: tOther },
      pixels: pixels.length,
      pixelList: pixels,
    };
  }
}

/** Vollbild-Mitte und -Größe in Pixeln eines Ausschnitts (für setCalibration(..., view)) */
export function cropView(crop, w, h) {
  return { cx: ((0.5 - crop.x) / crop.w) * w, cy: ((0.5 - crop.y) / crop.h) * h, size: Math.max(w / crop.w, h / crop.h) };
}
