// Realistischere synthetische Kamerabilder: echte Perspektive (Homographie), gedämpfte Farben,
// warmes Licht mit Verlauf, Rauschen. Dient zum Testen von Kalibrierung und Erkennung.
import { SEGMENTS, R } from '../js/core/board.js';
import { applyH, invertH } from '../js/vision/homography.js';
import { homographyFromPoints } from '../js/vision/calibration.js';
import { mulberry32, gaussian } from '../js/core/rng.js';

const COLORS = {
  red: [150, 38, 42], green: [28, 98, 60], black: [30, 30, 32], cream: [205, 188, 150],
  surround: [22, 22, 24], wall: [118, 108, 92], wire: [175, 175, 170],
};

/**
 * Erzeugt eine Szene. pts = 4 Kalibrierpunkte (normiert) der echten Lage.
 * Liefert { img: ImageData, H } mit H = Board(mm) → Bild(normiert).
 */
export function renderScene({ w = 960, h = 540, pts, darts = [], seed = 1, light = 1, noise = 6, warm = true, wall = null }) {
  if (wall) COLORS.wall = wall; else COLORS.wall = [118, 108, 92];
  const H = homographyFromPoints(pts);
  const Hpx = [H[0] * w, H[1] * w, H[2] * w, H[3] * h, H[4] * h, H[5] * h, H[6], H[7], H[8]];
  const Hi = invertH(Hpx);
  const rng = mulberry32(seed);
  const img = new ImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const b = applyH(Hi, x + 0.5, y + 0.5);
      const r = Math.hypot(b.x, b.y);
      let c;
      if (r > 225) c = COLORS.wall;
      else if (r > R.DOUBLE_OUT) c = COLORS.surround;
      else if (r <= R.DBULL) c = COLORS.red;
      else if (r <= R.SBULL) c = COLORS.green;
      else {
        const a = (Math.atan2(b.y, b.x) * 180) / Math.PI;
        const rot = (((90 - a + 9) % 360) + 360) % 360;
        const idx = Math.floor(rot / 18) % 20;
        const rel = rot - idx * 18;
        const even = idx % 2 === 0;
        const ring = (r >= R.TRIPLE_IN && r <= R.TRIPLE_OUT) || r >= R.DOUBLE_IN;
        c = ring ? (even ? COLORS.red : COLORS.green) : (even ? COLORS.black : COLORS.cream);
        // Drähte
        const wd = Math.min(rel, 18 - rel) * Math.PI / 180 * r;
        const ringEdge = [R.TRIPLE_IN, R.TRIPLE_OUT, R.DOUBLE_IN, R.DOUBLE_OUT].some((q) => Math.abs(r - q) < 0.6);
        if (wd < 0.6 || ringEdge) c = COLORS.wire;
      }
      // Licht: Verlauf von links oben, warm getönt
      const shade = light * (0.75 + 0.35 * (1 - (x / w) * 0.6 - (y / h) * 0.4));
      const i = (y * w + x) * 4;
      d[i] = clamp(c[0] * shade * (warm ? 1.08 : 1) + gaussian(rng) * noise);
      d[i + 1] = clamp(c[1] * shade + gaussian(rng) * noise);
      d[i + 2] = clamp(c[2] * shade * (warm ? 0.85 : 1) + gaussian(rng) * noise);
      d[i + 3] = 255;
    }
  }
  // Pfeile: Spitze auf der Scheibe, Körper ragt seitlich heraus (dünn → dick)
  for (const dart of darts) {
    const tip = applyH(Hpx, dart.x, dart.y);
    const dir = dart.dir || { x: 1, y: -0.65 };
    const n = Math.hypot(dir.x, dir.y);
    const ux = dir.x / n, uy = dir.y / n;
    const len = (dart.len || 0.11) * w;
    const parts = [[0, 0.12, 1.2, [150, 152, 158]], [0.12, 0.5, 3, [60, 70, 140]], [0.5, 0.62, 1.5, [40, 40, 40]], [0.62, 1, 9, [235, 200, 40]]];
    for (const [t0, t1, half, col] of parts) {
      for (let t = t0 * len; t <= t1 * len; t += 0.5) {
        const cx = tip.x + ux * t, cy = tip.y + uy * t;
        const hw = t0 === 0.62 ? half * ((t / len - 0.62) / 0.38 + 0.2) : half;
        for (let s = -hw; s <= hw; s += 0.5) {
          const px = Math.round(cx - uy * s), py = Math.round(cy + ux * s);
          if (px < 0 || py < 0 || px >= w || py >= h) continue;
          const i = (py * w + px) * 4;
          d[i] = col[0]; d[i + 1] = col[1]; d[i + 2] = col[2];
        }
      }
    }
  }
  return { img, H };
}

function clamp(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** Seitliche Perspektive: Scheibe klein, rechts vom Handy, leicht gekippt */
export const SIDE_VIEW = [
  { x: 0.505, y: 0.215 }, // 20|1
  { x: 0.605, y: 0.52 }, // 6|10
  { x: 0.47, y: 0.80 }, // 3|19
  { x: 0.385, y: 0.48 }, // 11|14
];
