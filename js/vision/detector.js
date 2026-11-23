// Dartpfeil-Erkennung per Bildvergleich (klassische Bildverarbeitung, läuft komplett lokal).
// Ablauf: Bewegung abwarten → ruhiges Bild mit Referenz vergleichen → Veränderungsregion
// segmentieren → Pfeilachse per Hauptkomponentenanalyse → Spitze am schmalen Ende →
// Homographie auf Scheibenebene → Segment. Unsichere Ergebnisse werden als solche gemeldet.
import { applyH, invertH } from './homography.js';
import { scoreAt } from '../core/board.js';

const DEFAULTS = {
  diffThreshold: 28, // mittlere RGB-Differenz pro Pixel (nach 3x3-Glättung)
  motionFraction: 0.001, // Anteil veränderter ROI-Pixel, ab dem "Bewegung" gilt
  stableFrames: 5, // so viele ruhige Frames in Folge, bevor ausgewertet wird
  minDartFraction: 0.0005, // minimale Pfeilfläche relativ zur ROI (dunkler Pfeil vor dunklem Grund ist klein)
  smallDartFraction: 0.0012, // darunter muss die Form deutlich länglich sein (sonst kein Pfeil)
  maxDartFraction: 0.07, // größer = Hand/Person/Lichtwechsel
  emptyFraction: 0.0015, // darunter gilt die Scheibe als "leer wie Referenz"
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
  return {
    focal, persp,
    /** Bildpunkt (px) eines Punkts L mm vor der Scheibe über dem Board-Punkt (bx, by) */
    point(bx, by, L = 0) {
      const X = [0, 1, 2].map((k) => r1[k] * bx + r2[k] * by + t[k] + r3[k] * L);
      return { x: (focal * X[0]) / X[2] + cx, y: (focal * X[1]) / X[2] + cy };
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
  for (const [ox, oy, oz] of [[0, 0, 0], [0, 0, 150], [0, 65, 150], [0, -25, 150], [45, 15, 150], [-45, 15, 150]]) {
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

/** Pixel nur abgedunkelt (Schatten), nicht umgefärbt? a = aktuell, b = Referenz */
function isShadow(ar, ag, ab, br, bg, bb) {
  const lb = br + bg + bb;
  if (lb < 90) return false; // auf dunklem Grund nicht unterscheidbar (Differenz dort ohnehin klein)
  const la = ar + ag + ab;
  const k = la / lb;
  if (k < 0.3 || k > 0.95) return false;
  // Farbanteile (Chromatizität) bleiben im Schatten fast gleich
  const dr = ar / la - br / lb, dg = ag / la - bg / lb;
  return Math.abs(dr) < 0.035 && Math.abs(dg) < 0.035;
}

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
  clearOcc() { if (this.occ) this.occ.fill(0); this.lastPixels = null; }

  markOcc(list, delta = 1) {
    if (!list || !this.w) return;
    if (!this.occ || this.occ.length !== this.w * this.h) this.occ = new Uint8Array(this.w * this.h);
    const { occ } = this;
    for (const p of list) { const v = occ[p] + delta; occ[p] = v < 0 ? 0 : v > 255 ? 255 : v; }
    if (delta > 0) this.lastPixels = list;
  }

  /** Aktuelles Bild wird neue Referenz (z. B. "Pfeile entfernt" manuell bestätigt) */
  rebase(img) {
    const c = img.data.slice();
    this.ref = c; this.emptyRef = c; this.prev = c;
    this.dartsOnBoard = 0; this.awaitingTakeout = false; this.regions = []; this.stable = 0; this.clearOcc();
    this.lastRefBefore = null;
    this.status = 'bereit';
  }

  awaitTakeout() { this.awaitingTakeout = true; this.status = 'warte auf Entfernen'; }

  /** Verarbeitet ein Frame (ImageData in Verarbeitungsauflösung). Liefert Ereignisse. */
  process(img) {
    if (!this.roi || img.width !== this.w || img.height !== this.h) return [];
    const data = img.data;
    if (!this.ref) { this.rebase(img); return [{ type: 'ready' }]; }

    const motion = this.changedFraction(data, this.prev, 2);
    this.prev = data.slice();
    if (motion > this.opts.motionFraction) {
      this.stable = 0; this.hadMotion = true;
      if (this.status !== 'warte auf Entfernen') this.status = 'Bewegung';
      return [];
    }
    this.stable++;
    if (this.stable < this.opts.stableFrames) return [];
    // nach Bewegung sofort auswerten, sonst periodisch (falls ein Pfeil ohne messbare Bewegung landete)
    if (!this.hadMotion && this.stable % 15 !== 0) return [];
    this.hadMotion = false;
    return this.evaluate(data);
  }

  /** Wertet den zuletzt erkannten Pfeil im aktuellen Bild erneut aus (Referenz = Bild davor) */
  redetectLast(img) {
    if (!img || !this.lastRefBefore || this.awaitingTakeout && this.dartsOnBoard === 0) return null;
    const count = this.buildMask(img.data, this.lastRefBefore);
    if (count < this.opts.minDartFraction * this.roi.length) return null;
    const own = this.regions.pop();
    const ownPx = this.lastPixels;
    this.markOcc(ownPx, -1); // eigener Pfeil verdeckt sich nicht selbst
    const det = this.analyse();
    if (ownPx) { this.markOcc(ownPx, 1); }
    if (own) this.regions.push(own);
    if (det) delete det.pixelList;
    return det;
  }

  /**
   * Schätzt eine kleine globale Verschiebung (Wackeln) zwischen Bild a und Referenz b.
   * Liefert den Index-Versatz o, mit dem a[p] ≈ b[p + o] gilt (0 = keine Verschiebung).
   */
  estimateShift(a, b) {
    const { roi, w } = this;
    const step = Math.max(1, Math.floor(roi.length / 5000));
    const lum = (d, i) => d[i] + 2 * d[i + 1] + d[i + 2];
    let best = 0, bestSad = Infinity, sad0 = 0, bdx = 0, bdy = 0;
    for (let dy = -MAX_SHIFT; dy <= MAX_SHIFT; dy++) {
      for (let dx = -MAX_SHIFT; dx <= MAX_SHIFT; dx++) {
        const o = dy * w + dx;
        let sad = 0;
        for (let k = 0; k < roi.length; k += step) {
          const p = roi[k];
          sad += Math.abs(lum(a, p * 4) - lum(b, (p + o) * 4));
        }
        if (!dx && !dy) sad0 = sad;
        if (sad < bestSad) { bestSad = sad; best = o; bdx = dx; bdy = dy; }
      }
    }
    // nur übernehmen, wenn die Verschiebung das Bild deutlich besser erklärt
    if (best !== 0 && bestSad > sad0 * 0.85) return { o: 0, dx: 0, dy: 0 };
    return { o: best, dx: bdx, dy: bdy };
  }

  /** Scheibe leer und frei (keine Pfeile, niemand davor)? Für Kamerakontrolle und Nachführung. */
  isClear(img) {
    if (!this.emptyRef || this.dartsOnBoard > 0 || this.awaitingTakeout || this.status !== 'bereit') return false;
    if (!img || img.width !== this.w || img.height !== this.h) return false;
    const s = this.estimateShift(img.data, this.emptyRef);
    return this.changedFraction(img.data, this.emptyRef, 2, s.o) < this.opts.emptyFraction * 2;
  }

  evaluate(data) {
    const roiN = this.roi.length;
    // Pfeile entfernt?
    if (this.dartsOnBoard > 0 || this.awaitingTakeout) {
      const se = this.estimateShift(data, this.emptyRef);
      const f = this.changedFraction(data, this.emptyRef, 1, se.o);
      if (f < this.opts.emptyFraction) {
        const c = data.slice();
        this.ref = c; this.emptyRef = c;
        this.dartsOnBoard = 0; this.awaitingTakeout = false; this.regions = []; this.clearOcc();
        this.lastRefBefore = null;
        this.status = 'bereit';
        return [{ type: 'takeout' }];
      }
    }
    if (this.awaitingTakeout) { this.status = 'warte auf Entfernen'; return [{ type: 'waiting-takeout' }]; }

    // Wackeln ausgleichen: Referenz um die geschätzte Verschiebung versetzt vergleichen
    const sh = this.estimateShift(data, this.ref);
    this.lastShift = sh;
    const count = this.buildMask(data, this.ref, sh.o);
    const frac = count / roiN;
    if (frac < this.opts.minDartFraction) {
      this.status = 'bereit';
      // minimale Drift (Licht, leichtes Verrutschen) in die Referenz übernehmen
      if (frac < 0.0003 || sh.o) {
        this.ref = data.slice();
        if (!this.dartsOnBoard) this.emptyRef = this.ref;
      }
      return [];
    }
    if (frac > this.opts.maxDartFraction) {
      this.largeChangeCount++;
      this.status = 'große Veränderung';
      if (this.largeChangeCount >= 3) {
        // dauerhafte Veränderung ohne Pfeil (Licht, verschobene Kamera) → neue Referenz
        this.largeChangeCount = 0;
        const c = data.slice();
        this.ref = c;
        if (this.dartsOnBoard === 0) this.emptyRef = c;
        return [{ type: 'lighting' }];
      }
      return [{ type: 'large-change', fraction: frac }];
    }
    this.largeChangeCount = 0;
    const det = this.analyse();
    this.lastRefBefore = this.ref;
    this.ref = data.slice();
    if (!det) { this.status = 'bereit'; return [{ type: 'unclear' }]; }
    this.dartsOnBoard++;
    this.regions.push(det.bbox);
    this.markOcc(det.pixelList);
    delete det.pixelList;
    this.status = 'bereit';
    return [{ type: 'dart', ...det }];
  }

  changedFraction(a, b, step, off = 0) {
    const thr = this.opts.diffThreshold * 3;
    const roi = this.roi;
    let changed = 0, n = 0;
    for (let k = 0; k < roi.length; k += step) {
      const i = roi[k] * 4, j = (roi[k] + off) * 4;
      const d = Math.abs(a[i] - b[j]) + Math.abs(a[i + 1] - b[j + 1]) + Math.abs(a[i + 2] - b[j + 2]);
      if (d > thr) changed++;
      n++;
    }
    return n ? changed / n : 0;
  }

  buildMask(a, b, off = 0) {
    const { diff, mask, roi, w } = this;
    diff.fill(0); mask.fill(0);
    for (let k = 0; k < roi.length; k++) {
      const p = roi[k], i = p * 4, j = (p + off) * 4;
      const d = (Math.abs(a[i] - b[j]) + Math.abs(a[i + 1] - b[j + 1]) + Math.abs(a[i + 2] - b[j + 2])) / 3;
      // Schatten: gleichmäßig abgedunkelt bei unveränderter Farbe → gehört nicht zum Pfeil
      if (d > 6 && isShadow(a[i], a[i + 1], a[i + 2], b[j], b[j + 1], b[j + 2])) { diff[p] = 0; continue; }
      diff[p] = d > 255 ? 255 : d;
    }
    const thr = this.opts.diffThreshold * 9;
    let count = 0;
    for (let k = 0; k < roi.length; k++) {
      const p = roi[k];
      const s = diff[p - w - 1] + diff[p - w] + diff[p - w + 1] + diff[p - 1] + diff[p] + diff[p + 1]
        + diff[p + w - 1] + diff[p + w] + diff[p + w + 1];
      if (s > thr) { mask[p] = 1; count++; }
    }
    return count;
  }

  /** Zusammenhängende Regionen → Pfeil-Hypothese */
  analyse() {
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
      if (px.length >= 12) comps.push({ px, bbox: { minX, minY, maxX, maxY } });
    }
    if (!comps.length) return null;
    comps.sort((a, b) => b.px.length - a.px.length);
    // Teile desselben Pfeils zusammenführen: nahe Teile, und Teile entlang der erwarteten
    // Pfeilachse (ein dunkler Schaft vor dunklem Grund ist unsichtbar → Flight und Barrel getrennt)
    const main = comps[0];
    const centroid = (c) => {
      if (!c.c) { let sx = 0, sy = 0; for (const p of c.px) { sx += p % w; sy += (p / w) | 0; } c.c = { x: sx / c.px.length, y: sy / c.px.length }; }
      return c.c;
    };
    const mc = centroid(main);
    const exp = this.expectedDir(mc.x, mc.y);
    const axis = exp && exp.len > 12 ? exp : null;
    const dartLen = axis ? axis.len * 1.45 : 0; // Pfeil ≈ 140 mm lang
    const gap = Math.max(8, Math.round(Math.min(w, h) * 0.04));
    let pixels = main.px.slice();
    const bb = { ...main.bbox };
    const merged = [main];
    for (const c of comps.slice(1)) {
      const b = c.bbox;
      const dx = Math.max(0, Math.max(b.minX - bb.maxX, bb.minX - b.maxX));
      const dy = Math.max(0, Math.max(b.minY - bb.maxY, bb.minY - b.maxY));
      let onAxis = false;
      if (axis) {
        const cc = centroid(c), rx = cc.x - mc.x, ry = cc.y - mc.y;
        const along = rx * axis.x + ry * axis.y, perp = Math.abs(rx * axis.y - ry * axis.x);
        // Kegel um die Achse: Pfeile stecken nicht exakt senkrecht (bis ca. 25° geneigt)
        onAxis = Math.abs(along) <= dartLen * 1.2 && perp <= 5 + 0.45 * Math.abs(along) && c.px.length >= Math.max(12, main.px.length * 0.02);
      }
      if ((dx <= gap && dy <= gap && c.px.length >= main.px.length * 0.05) || onAxis) {
        pixels = pixels.concat(c.px);
        bb.minX = Math.min(bb.minX, b.minX); bb.minY = Math.min(bb.minY, b.minY);
        bb.maxX = Math.max(bb.maxX, b.maxX); bb.maxY = Math.max(bb.maxY, b.maxY);
        merged.push(c);
      }
    }
    const minPx = this.opts.minDartFraction * this.roi.length;
    if (pixels.length < minPx) return null;
    const det = this.locateTip(pixels, bb, comps.length - merged.length);
    // kleine Veränderung: nur als Pfeil werten, wenn sie deutlich länglich ist
    if (pixels.length < this.opts.smallDartFraction * this.roi.length) {
      if (det.axis.elong < 3) return null;
      det.conf *= 0.85; det.reasons.push('nur teilweise sichtbar');
    }
    return det;
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

  /**
   * Verfolgt die dünne Spitze vom Ende der Pfeilregion weiter nach außen: Die Spitze ist nur
   * 1–3 px breit und fällt nach der Glättung oft unter die Schwelle. (dx, dy) zeigt zur Spitze.
   */
  extendTip(p, dx, dy) {
    const { diff, w, h } = this;
    const low = this.opts.diffThreshold * 0.45;
    const at = (x, y) => {
      const xi = Math.round(x), yi = Math.round(y);
      if (xi < 1 || yi < 1 || xi >= w - 1 || yi >= h - 1) return 0;
      return diff[yi * w + xi];
    };
    let last = 0, gap = 0;
    for (let s = 0.5; s <= 24; s += 0.5) {
      const x = p.x + dx * s, y = p.y + dy * s;
      // quer zur Achse ±1 px (die Spitze ist dünn und nicht exakt auf der Achse)
      const v = Math.max(at(x, y), at(x - dy, y + dx), at(x + dy, y - dx));
      if (v >= low) { last = s; gap = 0; } else if (++gap > 3) break;
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
    const s = last - back;
    return { x: p.x + dx * s, y: p.y + dy * s };
  }

  locateTip(pixels, bbox, otherBlobs) {
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
    if (exp && exp.len > 12 && elong < 2) { ux = exp.x; uy = exp.y; dot = 1; axisFromModel = true; }

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
    const geoStrong = exp && exp.len > 12 && Math.abs(dot) > 0.45 && (signOk || axisFromModel) && (elong >= 2 || axisFromModel);
    const tipAtMin = geoStrong ? dot > 0 : thinIsMin;

    const endPoint = (atMin) => {
      const lim = atMin ? tmin + 0.04 * L : tmax - 0.04 * L;
      let sx = 0, sy = 0, c = 0;
      for (let k = 0; k < n; k++) {
        if (atMin ? t[k] <= lim : t[k] >= lim) { sx += pixels[k] % w; sy += (pixels[k] / w) | 0; c++; }
      }
      return this.extendTip({ x: sx / c, y: sy / c }, atMin ? -ux : ux, atMin ? -uy : uy);
    };
    const tipPx = endPoint(tipAtMin);
    const altPx = endPoint(!tipAtMin);
    const toBoard = (p) => applyH(this.Hinv, p.x + 0.5, p.y + 0.5);
    let tipB = toBoard(tipPx), altB = toBoard(altPx);
    let usedAlt = false;
    const rTip = Math.hypot(tipB.x, tipB.y), rAlt = Math.hypot(altB.x, altB.y);
    // Spitze muss auf der Scheibe liegen; wenn nur das andere Ende plausibel ist, dieses nehmen
    if (!geoStrong && rTip > 200 && rAlt <= 175 && widthRatio > 0.5) { usedAlt = true; }
    const tip = usedAlt ? altPx : tipPx;
    const b = usedAlt ? altB : tipB;
    const hit = scoreAt(b.x, b.y);

    // Konfidenz aus nachvollziehbaren Faktoren
    const reasons = [];
    let conf = 1;
    if (geoStrong) {
      // Richtung aus Geometrie; Form nur als Zusatzkontrolle
      if (elong < 2.5 && !axisFromModel) conf *= 0.85;
      if (axisFromModel) { conf *= spreadOk ? 0.7 : 0.5; reasons.push('Pfeil zeigt fast zur Kamera'); }
      if (Math.abs(dot) < 0.7) { conf *= 0.85; reasons.push('Pfeil stark schräg'); }
      if (thinIsMin !== tipAtMin && widthRatio < 0.6) { conf *= 0.8; reasons.push('Form widerspricht Pfeilrichtung'); }
    } else {
      if (elong < 2.5) { conf *= 0.55; reasons.push('Form wenig länglich'); }
      else if (elong < 4) conf *= 0.85;
      if (widthRatio > 0.85) { conf *= 0.45; reasons.push('Spitze/Flight nicht unterscheidbar'); }
      else if (widthRatio > 0.6) { conf *= 0.75; reasons.push('Spitzenrichtung unsicher'); }
    }
    if (usedAlt) { conf *= 0.6; reasons.push('Spitze am breiteren Ende angenommen'); }
    if (hit.r <= 175) {
      // Toleranz je nach Messsicherheit: mit eindeutiger Pfeilrichtung ist die Spitze auf
      // Bruchteile von Millimetern genau, sonst deutlich ungenauer
      const sigma = geoStrong && !axisFromModel ? 0.6 : 2;
      if (hit.wireDist < sigma * 0.75) { conf *= 0.5; reasons.push('direkt am Draht'); }
      else if (hit.wireDist < sigma * 1.6) { conf *= 0.8; reasons.push('nahe am Draht'); }
    } else if (hit.r < 190) { conf *= 0.6; reasons.push('knapp außerhalb des Doppels'); }
    const overlap = this.regions.some((r) => !(bbox.maxX < r.minX || bbox.minX > r.maxX || bbox.maxY < r.minY || bbox.minY > r.maxY));
    if (overlap) { conf *= 0.75; reasons.push('überlagert einen vorhandenen Pfeil'); }
    if (otherBlobs > 2) { conf *= 0.8; reasons.push('weitere Bildveränderungen'); }
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
      tip: { x: tip.x / this.w, y: tip.y / this.h },
      board: { x: b.x, y: b.y },
      hit: { seg: hit.seg, mult: hit.mult, score: hit.score, label: hit.label, wireDist: hit.wireDist, r: hit.r },
      conf: Math.max(0, Math.min(1, conf)),
      reasons,
      bbox,
      axis: { elong, widthRatio, length: L, expLen: exp ? exp.len : 0, occTouch },
      pixels: pixels.length,
      pixelList: pixels,
    };
  }
}

/** Vollbild-Mitte und -Größe in Pixeln eines Ausschnitts (für setCalibration(..., view)) */
export function cropView(crop, w, h) {
  return { cx: ((0.5 - crop.x) / crop.w) * w, cy: ((0.5 - crop.y) / crop.h) * h, size: Math.max(w / crop.w, h / crop.h) };
}
