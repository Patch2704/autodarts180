// Geometrie einer Standard-Steeldartscheibe (Maße in mm, Koordinaten: x rechts, y oben, Ursprung = Bullseye)

export const SEGMENTS = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];
export const R = {
  DBULL: 6.35, SBULL: 15.9,
  TRIPLE_IN: 99, TRIPLE_OUT: 107,
  DOUBLE_IN: 162, DOUBLE_OUT: 170,
  BOARD: 225.5,
};
const SEG_INDEX = Object.fromEntries(SEGMENTS.map((s, i) => [s, i]));

/** Erzeugt ein Dart-Objekt. seg: 0 = Miss, 1..20, 25 = Bull; mult: 1/2/3 */
export function makeDart(seg, mult = 1) {
  if (!seg) return { seg: 0, mult: 0, score: 0, label: 'Miss' };
  if (seg === 25) {
    const m = mult === 2 ? 2 : 1;
    return { seg: 25, mult: m, score: 25 * m, label: m === 2 ? 'Bull' : '25' };
  }
  if (seg < 1 || seg > 20 || ![1, 2, 3].includes(mult)) throw new Error(`Ungültiges Feld ${seg}/${mult}`);
  return { seg, mult, score: seg * mult, label: (mult === 3 ? 'T' : mult === 2 ? 'D' : 'S') + seg };
}

/** 'T20', 'D16', 'S5', '25', 'Bull', 'Miss' → Dart */
export function parseLabel(label) {
  const l = String(label).trim().toUpperCase();
  if (l === 'MISS' || l === '0' || l === 'M') return makeDart(0);
  if (l === 'BULL' || l === 'DB' || l === '50') return makeDart(25, 2);
  if (l === '25' || l === 'SB') return makeDart(25, 1);
  const m = /^([SDT]?)(\d{1,2})$/.exec(l);
  if (!m) throw new Error(`Unbekanntes Feld: ${label}`);
  return makeDart(Number(m[2]), m[1] === 'T' ? 3 : m[1] === 'D' ? 2 : 1);
}

/** Mittelwinkel eines Segments in Grad (mathematisch, 0° = rechts, gegen den Uhrzeigersinn) */
export function segmentCenterAngle(seg) {
  return 90 - SEG_INDEX[seg] * 18;
}

function wrap360(a) {
  return ((a % 360) + 360) % 360;
}

/** Trefferberechnung aus Scheibenkoordinaten (mm). wireDist = Abstand zum nächsten Draht (mm). */
export function scoreAt(x, y) {
  const r = Math.hypot(x, y);
  const a = (Math.atan2(y, x) * 180) / Math.PI;
  const rot = wrap360(90 - a + 9);
  const idx = Math.floor(rot / 18) % 20;
  const seg = SEGMENTS[idx];
  const rel = rot - idx * 18;
  const radialWire = r * Math.sin((Math.min(rel, 18 - rel) * Math.PI) / 180);
  const ringDist = Math.min(
    Math.abs(r - R.DBULL), Math.abs(r - R.SBULL), Math.abs(r - R.TRIPLE_IN),
    Math.abs(r - R.TRIPLE_OUT), Math.abs(r - R.DOUBLE_IN), Math.abs(r - R.DOUBLE_OUT),
  );
  let d;
  if (r <= R.DBULL) d = makeDart(25, 2);
  else if (r <= R.SBULL) d = makeDart(25, 1);
  else if (r > R.DOUBLE_OUT) d = makeDart(0);
  else if (r >= R.DOUBLE_IN) d = makeDart(seg, 2);
  else if (r >= R.TRIPLE_IN && r <= R.TRIPLE_OUT) d = makeDart(seg, 3);
  else d = makeDart(seg, 1);
  const wireDist = r <= R.SBULL || r > R.DOUBLE_OUT ? ringDist : Math.min(ringDist, radialWire);
  return { ...d, x, y, r, wireDist };
}

/** Zielpunkt (Mitte des Feldes) für Bot und Anzeige */
export function targetPoint(seg, mult) {
  if (seg === 25) return mult === 2 ? { x: 0, y: 0 } : { x: 0, y: (R.DBULL + R.SBULL) / 2 };
  const a = (segmentCenterAngle(seg) * Math.PI) / 180;
  const r = mult === 3 ? (R.TRIPLE_IN + R.TRIPLE_OUT) / 2
    : mult === 2 ? (R.DOUBLE_IN + R.DOUBLE_OUT) / 2
    : (R.TRIPLE_OUT + R.DOUBLE_IN) / 2;
  return { x: r * Math.cos(a), y: r * Math.sin(a) };
}

/** Alle 62 möglichen punktenden Einzelwürfe */
export const ALL_DARTS = (() => {
  const out = [];
  for (let s = 1; s <= 20; s++) for (const m of [1, 2, 3]) out.push(makeDart(s, m));
  out.push(makeDart(25, 1), makeDart(25, 2));
  return out;
})();

/** Ringfarbe nach Standardscheibe: Segmente mit geradem Index (20, 18, 13 …) haben rote Ringe */
export function ringColorOf(seg) {
  return SEG_INDEX[seg] % 2 === 0 ? 'red' : 'green';
}
