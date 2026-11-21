// KI-Dart-Bot: simuliert echte Würfe als 2D-Normalverteilung um den Zielpunkt.
// Die Streuung (Sigma) wird per Simulation so kalibriert, dass der langfristige
// 3-Dart-Average dem eingestellten Ziel entspricht. Keine Ergebnis-Manipulation.
import { scoreAt, targetPoint, makeDart } from './board.js';
import { findCheckouts, setupShot, wouldBust } from './checkout.js';
import { mulberry32, gaussian } from './rng.js';

export const BOT_AVERAGES = [30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100, 105, 110, 115, 120];

// score/dbl: relative Streuung beim Scoring bzw. auf Doppel; jitter: Schwankung von Aufnahme zu Aufnahme
export const PERSONALITIES = {
  beginner: { label: 'Anfänger', score: 1.0, dbl: 1.25, jitter: 0.35, desc: 'Viele Fehlwürfe, unregelmäßige Aufnahmen, schwache Checkout-Quote.' },
  hobby: { label: 'Hobbyspieler', score: 1.0, dbl: 1.05, jitter: 0.25, desc: 'Schwankende Aufnahmen, gelegentlich hohe Scores, durchschnittliche Checkouts.' },
  constant: { label: 'Konstant', score: 1.0, dbl: 1.0, jitter: 0.05, desc: 'Gleichmäßige Leistung mit wenig Schwankung.' },
  scorer: { label: 'Scoring-Maschine', score: 0.9, dbl: 1.35, jitter: 0.1, desc: 'Hohe Aufnahmen, gute Triple-Quote, schwächere Checkouts.' },
  finisher: { label: 'Checkout-Spezialist', score: 1.08, dbl: 0.7, jitter: 0.1, desc: 'Besonders gute Doppelquote und Finish-Entscheidungen.' },
  pro: { label: 'Profi', score: 1.0, dbl: 0.85, jitter: 0.08, desc: 'Hoher Average, gutes Scoring, starke Checkouts.' },
};

const SIM_OPTS = { outMode: 'double', bullIsDouble: true };

/** Zielwahl wie ein vernünftiger Spieler */
export function chooseTarget(rem, dartsLeft, isIn, opts) {
  if (!isIn) return makeDart(20, 2);
  if (rem <= 180) {
    const co = findCheckouts(rem, dartsLeft, opts, 1)[0];
    if (co) return co.darts[0];
    if (rem <= 170) {
      const s = setupShot(rem, dartsLeft, opts);
      if (s) return s.dart;
    }
  }
  const t20 = makeDart(20, 3);
  if (!wouldBust(rem, t20, opts)) return t20;
  return makeDart(1, 1);
}

function isFinishingTarget(target, rem, opts) {
  return target.score === rem || (target.mult === 2 && opts.outMode !== 'straight');
}

/** Einzelner Wurf auf ein Ziel mit Streuung sigma (mm) */
export function throwAt(target, sigma, rng) {
  const p = targetPoint(target.seg, target.mult);
  const x = p.x + gaussian(rng) * sigma;
  const y = p.y + gaussian(rng) * sigma;
  const hit = scoreAt(x, y);
  return { seg: hit.seg, mult: hit.mult, score: hit.score, label: hit.label, x, y, target: target.label };
}

/** Simulierter Average (501, Double-Out) für gegebene Basis-Streuung */
export function simulateAverage(baseSigma, pers, legs = 250, seed = 12345) {
  const rng = mulberry32(seed);
  let points = 0, darts = 0;
  for (let l = 0; l < legs; l++) {
    let rem = 501, legDarts = 0;
    while (rem > 0 && legDarts < 120) {
      const factor = Math.exp(pers.jitter * gaussian(rng));
      const start = rem;
      for (let k = 0; k < 3; k++) {
        const target = chooseTarget(rem, 3 - k, true, SIM_OPTS);
        const sigma = baseSigma * factor * (isFinishingTarget(target, rem, SIM_OPTS) ? pers.dbl : pers.score);
        const d = throwAt(target, sigma, rng);
        darts++; legDarts++;
        if (wouldBust(rem, d, SIM_OPTS)) { rem = start; break; }
        rem -= d.score;
        if (rem === 0) break;
      }
      points += start - rem;
    }
  }
  return (points / darts) * 3;
}

const CAL_VERSION = 'v2';
const calCache = new Map();

function storageGet(key) {
  try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; }
}
function storageSet(key, val) {
  try { globalThis.localStorage?.setItem(key, val); } catch { /* ignore */ }
}

/** Findet per Bisektion die Basis-Streuung für den Ziel-Average */
export function calibrateSigma(average, personality = 'constant') {
  const key = `botcal:${CAL_VERSION}:${average}:${personality}`;
  if (calCache.has(key)) return calCache.get(key);
  const stored = Number(storageGet(key));
  if (stored > 0) { calCache.set(key, stored); return stored; }
  const pers = PERSONALITIES[personality] || PERSONALITIES.constant;
  let lo = Math.log(0.3), hi = Math.log(600);
  for (let i = 0; i < 22; i++) {
    const mid = (lo + hi) / 2;
    const a = simulateAverage(Math.exp(mid), pers, 220, 4242);
    if (a > average) lo = mid; else hi = mid;
  }
  const sigma = Math.exp((lo + hi) / 2);
  calCache.set(key, sigma);
  storageSet(key, String(sigma));
  return sigma;
}

export class Bot {
  constructor({ average = 60, personality = 'constant', seed } = {}) {
    this.average = average;
    this.personality = PERSONALITIES[personality] ? personality : 'constant';
    this.pers = PERSONALITIES[this.personality];
    this.rng = seed != null ? mulberry32(seed) : Math.random;
    this.sigma = calibrateSigma(average, this.personality);
    this.factor = 1;
  }
  startVisit() {
    this.factor = Math.exp(this.pers.jitter * gaussian(this.rng));
  }
  /** Wirft einen Dart. opts = Match-Einstellungen (outMode, bullIsDouble) */
  throwDart(rem, dartsLeft, isIn, opts) {
    const target = chooseTarget(rem, dartsLeft, isIn, opts);
    const finishing = !isIn ? true : isFinishingTarget(target, rem, opts);
    const sigma = this.sigma * this.factor * (finishing ? this.pers.dbl : this.pers.score);
    return { ...throwAt(target, sigma, this.rng), source: 'bot' };
  }
}
