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
  minDartFraction: 0.0012, // minimale Pfeilfläche relativ zur ROI
  maxDartFraction: 0.07, // größer = Hand/Person/Lichtwechsel
  emptyFraction: 0.0015, // darunter gilt die Scheibe als "leer wie Referenz"
  tipExtend: 1.0, // Korrektur der Spitzenposition entlang der Pfeilachse (px, Verarbeitungsauflösung)
};

export class DartDetector {
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.H = null;
    this.reset();
  }

  /** H: Board(mm) → Bild normiert; w/h: Verarbeitungsauflösung */
  setCalibration(H, w, h) {
    this.w = w; this.h = h;
    this.Hpx = [H[0] * w, H[1] * w, H[2] * w, H[3] * h, H[4] * h, H[5] * h, H[6], H[7], H[8]];
    this.Hinv = invertH(this.Hpx);
    // Region of Interest: Scheibe + Rand für herausragende Pfeile (bis 300 mm vom Zentrum)
    const roi = [];
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const b = applyH(this.Hinv, x, y);
      if (Number.isFinite(b.x) && b.x * b.x + b.y * b.y <= 300 * 300) roi.push(y * w + x);
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
    this.regions = []; this.largeChangeCount = 0;
    this.lastRefBefore = null;
    this.status = 'init';
  }

  /** Aktuelles Bild wird neue Referenz (z. B. "Pfeile entfernt" manuell bestätigt) */
  rebase(img) {
    const c = img.data.slice();
    this.ref = c; this.emptyRef = c; this.prev = c;
    this.dartsOnBoard = 0; this.awaitingTakeout = false; this.regions = []; this.stable = 0;
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
    const det = this.analyse();
    if (own) this.regions.push(own);
    return det;
  }

  evaluate(data) {
    const roiN = this.roi.length;
    // Pfeile entfernt?
    if (this.dartsOnBoard > 0 || this.awaitingTakeout) {
      const f = this.changedFraction(data, this.emptyRef, 1);
      if (f < this.opts.emptyFraction) {
        const c = data.slice();
        this.ref = c; this.emptyRef = c;
        this.dartsOnBoard = 0; this.awaitingTakeout = false; this.regions = [];
        this.lastRefBefore = null;
        this.status = 'bereit';
        return [{ type: 'takeout' }];
      }
    }
    if (this.awaitingTakeout) { this.status = 'warte auf Entfernen'; return [{ type: 'waiting-takeout' }]; }

    const count = this.buildMask(data, this.ref);
    const frac = count / roiN;
    if (frac < this.opts.minDartFraction) {
      this.status = 'bereit';
      // minimale Drift (Licht) in die Referenz übernehmen
      if (frac < this.opts.minDartFraction / 4) this.ref = data.slice();
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
    this.status = 'bereit';
    return [{ type: 'dart', ...det }];
  }

  changedFraction(a, b, step) {
    const thr = this.opts.diffThreshold * 3;
    const roi = this.roi;
    let changed = 0, n = 0;
    for (let k = 0; k < roi.length; k += step) {
      const i = roi[k] * 4;
      const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      if (d > thr) changed++;
      n++;
    }
    return n ? changed / n : 0;
  }

  buildMask(a, b) {
    const { diff, mask, roi, w } = this;
    diff.fill(0); mask.fill(0);
    for (let k = 0; k < roi.length; k++) {
      const p = roi[k], i = p * 4;
      const d = (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
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
    // nahe Teile (z. B. Flight getrennt vom Barrel) zusammenführen
    const main = comps[0];
    const gap = Math.max(8, Math.round(Math.min(w, h) * 0.04));
    let pixels = main.px.slice();
    const bb = { ...main.bbox };
    const merged = [main];
    for (const c of comps.slice(1)) {
      const b = c.bbox;
      const dx = Math.max(0, Math.max(b.minX - bb.maxX, bb.minX - b.maxX));
      const dy = Math.max(0, Math.max(b.minY - bb.maxY, bb.minY - b.maxY));
      if (dx <= gap && dy <= gap && c.px.length >= main.px.length * 0.05) {
        pixels = pixels.concat(c.px);
        bb.minX = Math.min(bb.minX, b.minX); bb.minY = Math.min(bb.minY, b.minY);
        bb.maxX = Math.max(bb.maxX, b.maxX); bb.maxY = Math.max(bb.maxY, b.maxY);
        merged.push(c);
      }
    }
    const minPx = this.opts.minDartFraction * this.roi.length;
    if (pixels.length < minPx) return null;
    return this.locateTip(pixels, bb, comps.length - merged.length);
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
    const elong = Math.sqrt(l1 / l2);

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

    const endPoint = (atMin) => {
      const lim = atMin ? tmin + 0.04 * L : tmax - 0.04 * L;
      let sx = 0, sy = 0, c = 0;
      for (let k = 0; k < n; k++) {
        if (atMin ? t[k] <= lim : t[k] >= lim) { sx += pixels[k] % w; sy += (pixels[k] / w) | 0; c++; }
      }
      // Die äußerste Spitze ist dünn und kontrastarm und fällt nach der Glättung unter die
      // Schwelle; der Mittelwert des Endstücks liegt deshalb etwas innen → nach außen korrigieren.
      const s = atMin ? -this.opts.tipExtend : this.opts.tipExtend;
      return { x: sx / c + s * ux, y: sy / c + s * uy };
    };
    const tipPx = endPoint(thinIsMin);
    const altPx = endPoint(!thinIsMin);
    const toBoard = (p) => applyH(this.Hinv, p.x + 0.5, p.y + 0.5);
    let tipB = toBoard(tipPx), altB = toBoard(altPx);
    let usedAlt = false;
    const rTip = Math.hypot(tipB.x, tipB.y), rAlt = Math.hypot(altB.x, altB.y);
    // Spitze muss auf der Scheibe liegen; wenn nur das andere Ende plausibel ist, dieses nehmen
    if (rTip > 200 && rAlt <= 175 && widthRatio > 0.5) { usedAlt = true; }
    const tip = usedAlt ? altPx : tipPx;
    const b = usedAlt ? altB : tipB;
    const hit = scoreAt(b.x, b.y);

    // Konfidenz aus nachvollziehbaren Faktoren
    const reasons = [];
    let conf = 1;
    if (elong < 2.5) { conf *= 0.55; reasons.push('Form wenig länglich'); }
    else if (elong < 4) conf *= 0.85;
    if (widthRatio > 0.85) { conf *= 0.45; reasons.push('Spitze/Flight nicht unterscheidbar'); }
    else if (widthRatio > 0.6) { conf *= 0.75; reasons.push('Spitzenrichtung unsicher'); }
    if (usedAlt) { conf *= 0.6; reasons.push('Spitze am breiteren Ende angenommen'); }
    if (hit.r <= 175) {
      if (hit.wireDist < 1) { conf *= 0.5; reasons.push('direkt am Draht'); }
      else if (hit.wireDist < 2.5) { conf *= 0.8; reasons.push('nahe am Draht'); }
    } else if (hit.r < 190) { conf *= 0.6; reasons.push('knapp außerhalb des Doppels'); }
    const overlap = this.regions.some((r) => !(bbox.maxX < r.minX || bbox.minX > r.maxX || bbox.maxY < r.minY || bbox.minY > r.maxY));
    if (overlap) { conf *= 0.75; reasons.push('überlagert einen vorhandenen Pfeil'); }
    if (otherBlobs > 2) { conf *= 0.8; reasons.push('weitere Bildveränderungen'); }

    return {
      tip: { x: tip.x / this.w, y: tip.y / this.h },
      board: { x: b.x, y: b.y },
      hit: { seg: hit.seg, mult: hit.mult, score: hit.score, label: hit.label, wireDist: hit.wireDist, r: hit.r },
      conf: Math.max(0, Math.min(1, conf)),
      reasons,
      bbox,
      axis: { elong, widthRatio, length: L },
      pixels: pixels.length,
    };
  }
}
