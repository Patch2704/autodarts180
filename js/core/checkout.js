// Dynamischer Checkout-Assistent: berechnet alle gültigen Finish-Wege und sortiert sie spielpraktisch.
import { ALL_DARTS } from './board.js';

// Bevorzugte Doppel (beliebte, gut teilbare Doppel zuerst)
const DOUBLE_PREF = [20, 16, 8, 18, 12, 10, 4, 6, 2, 14, 5, 3, 9, 7, 11, 13, 15, 17, 19, 1];
const TRIPLE_PREF = [20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];

export const DEFAULT_OUT = { outMode: 'double', bullIsDouble: true };

export function isDoubleDart(d, opts = DEFAULT_OUT) {
  return d.mult === 2 && (d.seg !== 25 || opts.bullIsDouble !== false);
}

export function isValidFinish(d, opts = DEFAULT_OUT) {
  if (d.score <= 0) return false;
  if (opts.outMode === 'straight') return true;
  if (opts.outMode === 'master') return isDoubleDart(d, opts) || d.mult === 3;
  return isDoubleDart(d, opts);
}

/** Kann der Rest mit genau einem Dart beendet werden? (Basis für Checkout-Versuche) */
export function isOneDartFinish(rem, opts = DEFAULT_OUT) {
  return ALL_DARTS.some((d) => d.score === rem && isValidFinish(d, opts));
}

function finishPenalty(d, opts) {
  if (opts.outMode === 'straight') {
    if (d.seg === 25) return d.mult === 2 ? 14 : 10;
    if (d.mult === 1) return 0;
    if (d.mult === 2) return 6 + DOUBLE_PREF.indexOf(d.seg) * 0.5;
    return 8 + TRIPLE_PREF.indexOf(d.seg) * 0.3;
  }
  if (d.seg === 25) return 30;
  if (d.mult === 2) return DOUBLE_PREF.indexOf(d.seg) * 2.5;
  return 12 + TRIPLE_PREF.indexOf(d.seg) * 0.8; // Triple-Finish (Master-Out)
}

function setupPenalty(d) {
  if (d.seg === 25) return d.mult === 2 ? 24 : 16;
  if (d.mult === 1) return 2;
  if (d.mult === 3) return 10 + TRIPLE_PREF.indexOf(d.seg) * 0.6;
  return 28 + DOUBLE_PREF.indexOf(d.seg) * 0.3;
}

function orderSetups(a, b) {
  return (b.mult === 3) - (a.mult === 3) || b.score - a.score;
}

const cache = new Map();
const optKey = (o) => `${o.outMode}|${o.bullIsDouble !== false ? 1 : 0}`;

/**
 * Liefert sortierte Checkout-Wege für `rem` Restpunkte mit maximal `dartsLeft` Darts.
 * Jeder Weg: { darts: [Dart...], cost }. Leeres Array = kein Checkout möglich.
 */
export function findCheckouts(rem, dartsLeft = 3, opts = DEFAULT_OUT, limit = 4) {
  opts = { ...DEFAULT_OUT, ...opts };
  const key = `${rem}|${dartsLeft}|${optKey(opts)}`;
  let all = cache.get(key);
  if (!all) {
    all = computeCheckouts(rem, dartsLeft, opts);
    cache.set(key, all);
  }
  return all.slice(0, limit);
}

function computeCheckouts(rem, dartsLeft, opts) {
  if (!Number.isInteger(rem) || rem < 1 || rem > 180 || dartsLeft < 1) return [];
  const byScore = new Map();
  for (const d of ALL_DARTS) {
    if (!isValidFinish(d, opts)) continue;
    if (!byScore.has(d.score)) byScore.set(d.score, []);
    byScore.get(d.score).push(d);
  }
  const routes = [];
  const seen = new Set();
  const add = (setups) => {
    const sum = setups.reduce((a, d) => a + d.score, 0);
    const fs = byScore.get(rem - sum);
    if (!fs) return;
    const sorted = [...setups].sort(orderSetups);
    for (const f of fs) {
      const darts = [...sorted, f];
      const id = darts.map((d) => d.label).join(' ');
      if (seen.has(id)) continue;
      seen.add(id);
      const cost = setups.length * 1000 + finishPenalty(f, opts) + setups.reduce((a, d) => a + setupPenalty(d), 0);
      routes.push({ darts, cost });
    }
  };
  add([]);
  if (dartsLeft >= 2) for (const a of ALL_DARTS) if (a.score < rem) add([a]);
  if (dartsLeft >= 3) {
    for (let i = 0; i < ALL_DARTS.length; i++) {
      for (let j = i; j < ALL_DARTS.length; j++) {
        const a = ALL_DARTS[i], b = ALL_DARTS[j];
        if (a.score + b.score < rem) add([a, b]);
      }
    }
  }
  routes.sort((x, y) => x.cost - y.cost);
  return routes;
}

/** Wäre dieser Rest nach dem Dart ein Bust? */
export function wouldBust(rem, dart, opts = DEFAULT_OUT) {
  const nr = rem - dart.score;
  if (nr < 0) return true;
  if (nr === 1 && opts.outMode !== 'straight') return true;
  if (nr === 0 && !isValidFinish(dart, opts)) return true;
  return false;
}

const setupCache = new Map();
/**
 * Wenn mit den verbleibenden Darts kein Checkout möglich ist: Vorbereitungswurf,
 * der einen möglichst guten Rest stehen lässt. Liefert { dart, leave } oder null.
 */
export function setupShot(rem, dartsLeft, opts = DEFAULT_OUT) {
  opts = { ...DEFAULT_OUT, ...opts };
  const key = `${rem}|${dartsLeft}|${optKey(opts)}`;
  if (setupCache.has(key)) return setupCache.get(key);
  let best = null;
  for (const d of ALL_DARTS) {
    if (d.mult === 2) continue; // Doppel nicht als Vorbereitung
    if (wouldBust(rem, d, opts)) continue;
    const left = rem - d.score;
    if (left === 0) continue;
    let val;
    const now = dartsLeft > 1 ? findCheckouts(left, dartsLeft - 1, opts, 1)[0] : null;
    if (now) val = 2000 - now.cost;
    else {
      const next = findCheckouts(left, 3, opts, 1)[0];
      val = next ? 1000 - next.cost / 2 : -left;
    }
    val -= setupPenalty(d) * 2;
    if (!best || val > best.val) best = { dart: d, leave: left, val };
  }
  setupCache.set(key, best);
  return best;
}

/** Bekannte Rest-Situation für die Anzeige */
export function checkoutInfo(rem, dartsLeft, opts = DEFAULT_OUT) {
  const routes = findCheckouts(rem, dartsLeft, opts, 4);
  if (routes.length) return { possible: true, routes };
  const any = findCheckouts(rem, 3, opts, 1).length > 0;
  const setup = rem <= 180 ? setupShot(rem, dartsLeft, opts) : null;
  return { possible: false, routes: [], finishableNextVisit: any, setup };
}
