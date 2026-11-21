// Kalibrierung: Homographie zwischen Scheibenebene (mm) und Kamerabild (normierte Koordinaten 0..1),
// automatische Erstschätzung über die roten/grünen Ringe, Qualitätsmessung und Kamerakontrolle.
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

export function classifyColor(r, g, b) {
  if (r > 80 && r > g * 1.6 && r > b * 1.3) return 'red';
  if (g > 55 && g > r * 1.25 && g > b * 1.05) return 'green';
  return 'neutral';
}

function sampleRGB(img, nx, ny) {
  const { width: w, height: h, data } = img;
  const cx = Math.round(nx * w), cy = Math.round(ny * h);
  let r = 0, g = 0, b = 0, n = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const x = cx + dx, y = cy + dy;
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const i = (y * w + x) * 4;
    r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
  }
  return n ? [r / n, g / n, b / n] : null;
}

/**
 * Automatische Erstschätzung: Schwerpunkt und Kovarianz aller roten/grünen Pixel
 * ergeben eine Ellipse (die Ringe). Die Drehung wird mit "20 oben" angenommen
 * und kann anschließend angepasst werden. Liefert 4 normierte Punkte oder null.
 */
export function autoGuess(img) {
  const { width: w, height: h, data } = img;
  let pts = [];
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
    const i = (y * w + x) * 4;
    if (classifyColor(data[i], data[i + 1], data[i + 2]) !== 'neutral') pts.push(x, y);
  }
  if (pts.length < 400) return null;
  let stats = null;
  for (let iter = 0; iter < 3; iter++) {
    stats = moments(pts);
    if (!stats) return null;
    const { mx, my, inv } = stats;
    const kept = [];
    for (let k = 0; k < pts.length; k += 2) {
      const dx = pts[k] - mx, dy = pts[k + 1] - my;
      const d2 = dx * (inv[0] * dx + inv[1] * dy) + dy * (inv[2] * dx + inv[3] * dy);
      if (d2 < 4.5) kept.push(pts[k], pts[k + 1]);
    }
    if (kept.length < 400) break;
    pts = kept;
  }
  const { mx, my, cxx, cxy, cyy } = stats;
  // Effektiver RMS-Radius der farbigen Flächen (Doppel, Triple, Bull) ≈ 141 mm
  const RMS = 141.2;
  const tr = cxx + cyy, det = cxx * cyy - cxy * cxy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
  if (l2 <= 0) return null;
  let v1 = Math.abs(cxy) > 1e-9 ? [l1 - cyy, cxy] : (cxx >= cyy ? [1, 0] : [0, 1]);
  const n1 = Math.hypot(v1[0], v1[1]);
  v1 = [v1[0] / n1, v1[1] / n1];
  const v2 = [-v1[1], v1[0]];
  const s1 = Math.sqrt(2 * l1) / RMS, s2 = Math.sqrt(2 * l2) / RMS;
  // S = V diag(s) V^T  (symmetrische Wurzel)
  const S = [
    s1 * v1[0] * v1[0] + s2 * v2[0] * v2[0], s1 * v1[0] * v1[1] + s2 * v2[0] * v2[1],
    s1 * v1[1] * v1[0] + s2 * v2[1] * v2[0], s1 * v1[1] * v1[1] + s2 * v2[1] * v2[1],
  ];
  return calBoardPoints().map((p) => {
    const bx = p.x, by = -p.y; // Bild-y zeigt nach unten
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
 * Qualität: An 80 Stellen wird geprüft, ob die projizierten Felder die erwartete Farbe haben
 * (Doppel/Triple rot bzw. grün, Single-Felder ungefärbt). Ergebnis 0..1.
 */
export function calibrationQuality(img, H) {
  let match = 0, total = 0, ringMatch = 0, ringTotal = 0;
  for (const seg of SEGMENTS) {
    const a = (segmentCenterAngle(seg) * Math.PI) / 180;
    const want = ringColorOf(seg);
    for (const [r, kind] of [[103, 'ring'], [166, 'ring'], [60, 'single'], [135, 'single']]) {
      const p = applyH(H, r * Math.cos(a), r * Math.sin(a));
      const rgb = sampleRGB(img, p.x, p.y);
      total++;
      if (!rgb) continue;
      const c = classifyColor(...rgb);
      if (kind === 'ring') { ringTotal++; if (c === want) { match++; ringMatch++; } }
      else if (c === 'neutral') match++;
    }
  }
  return { score: total ? match / total : 0, ringScore: ringTotal ? ringMatch / ringTotal : 0 };
}

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
 * Kamerakontrolle während des Spiels. Vergleicht mit den Werten bei der Kalibrierung.
 * Liefert eine Liste von Warnungen (leer = alles in Ordnung).
 */
export function healthCheck(img, calib) {
  const warnings = [];
  const q = calibrationQuality(img, calib.H);
  const m = frameMetrics(img);
  const vis = boardVisibility(calib.H);
  if (vis < 0.98) warnings.push({ code: 'visibility', text: 'Die Dartscheibe ist nicht vollständig im Bild.' });
  if (calib.quality != null && q.score < calib.quality - 0.2) {
    warnings.push({ code: 'moved', text: 'Die Kamera scheint verrutscht zu sein – die Scheibe passt nicht mehr zur Kalibrierung.' });
  }
  if (calib.brightness && Math.abs(m.brightness - calib.brightness) / calib.brightness > 0.35) {
    warnings.push({ code: 'light', text: 'Die Beleuchtung hat sich stark verändert.' });
  }
  if (m.sharpness < 15) warnings.push({ code: 'blur', text: 'Das Kamerabild ist unscharf oder zu dunkel für eine zuverlässige Erkennung.' });
  return { warnings, quality: q.score, metrics: m };
}
