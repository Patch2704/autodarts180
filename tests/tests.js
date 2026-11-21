import { makeDart, parseLabel, scoreAt, targetPoint, SEGMENTS } from '../js/core/board.js';
import { findCheckouts, checkoutInfo, isOneDartFinish } from '../js/core/checkout.js';
import { createMatch, addDart, replay, endVisit, undoDart, undoVisit, replaceDart, deleteDart, clearOpenVisit } from '../js/core/x01.js';
import { matchStats } from '../js/core/stats.js';
import { simulateAverage, calibrateSigma, PERSONALITIES, Bot } from '../js/core/bot.js';
import { solveHomography, applyH, invertH } from '../js/vision/homography.js';
import { createMatch as _cm } from '../js/core/x01.js';

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function eq(a, b, msg = '') {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${msg} erwartet ${B}, erhalten ${A}`);
}
function ok(c, msg) { if (!c) throw new Error(msg || 'Bedingung falsch'); }
const P2 = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
const P1 = [{ id: 'a', name: 'A' }];
const D = (l) => parseLabel(l);
function throwAll(m, labels) { let r; for (const l of labels) r = addDart(m, D(l)); return r; }

// ---------- Scheibe ----------
test('Board: Segmentreihenfolge und Feldmitten', () => {
  for (const seg of SEGMENTS) for (const mult of [1, 2, 3]) {
    const p = targetPoint(seg, mult);
    eq(scoreAt(p.x, p.y).label, makeDart(seg, mult).label, `${seg}x${mult}`);
  }
  eq(scoreAt(0, 0).label, 'Bull');
  eq(scoreAt(0, 10).label, '25');
  eq(scoreAt(0, 171).label, 'Miss');
  eq(scoreAt(0, 103).label, 'T20');
  eq(scoreAt(103, 0).label, 'T6');
  eq(scoreAt(0, -103).label, 'T3');
  eq(scoreAt(-103, 0).label, 'T11');
});
test('Board: Drahtabstand', () => {
  ok(scoreAt(0, 103).wireDist > 3, 'T20-Mitte weit vom Draht');
  ok(scoreAt(0, 99.2).wireDist < 0.5, 'nahe Triple-Innenring');
});

// ---------- Checkout ----------
test('Checkout: 170 = T20 T20 Bull', () => {
  eq(findCheckouts(170, 3)[0].darts.map((d) => d.label), ['T20', 'T20', 'Bull']);
});
test('Checkout: Bogey-Nummern ohne Weg', () => {
  for (const r of [169, 168, 166, 165, 163, 162, 159]) eq(findCheckouts(r, 3).length, 0, `Rest ${r}`);
});
test('Checkout: alle anderen 2..170 sind mit 3 Darts checkbar (Double-Out)', () => {
  const bogey = new Set([169, 168, 166, 165, 163, 162, 159]);
  for (let r = 2; r <= 170; r++) if (!bogey.has(r)) ok(findCheckouts(r, 3).length > 0, `Rest ${r}`);
});
test('Checkout: Double-Out Endwurf ist immer Doppel', () => {
  for (let r = 2; r <= 170; r++) for (const route of findCheckouts(r, 3, undefined, 10)) {
    const last = route.darts[route.darts.length - 1];
    ok(last.mult === 2, `Rest ${r}: ${last.label}`);
    eq(route.darts.reduce((a, d) => a + d.score, 0), r, `Summe ${r}`);
  }
});
test('Checkout: 1 Rest im Double-Out nicht möglich, Straight-Out schon', () => {
  eq(findCheckouts(1, 3).length, 0);
  eq(findCheckouts(1, 3, { outMode: 'straight' })[0].darts.map((d) => d.label), ['S1']);
});
test('Checkout: Master-Out erlaubt Triple-Finish', () => {
  eq(findCheckouts(3, 1, { outMode: 'master' })[0].darts.map((d) => d.label), ['T1']);
  eq(findCheckouts(3, 1, { outMode: 'double' }).length, 0);
});
test('Checkout: Dart-Begrenzung und dynamische Neuberechnung', () => {
  eq(findCheckouts(110, 1).length, 0);
  ok(findCheckouts(110, 2).length > 0, '110 mit 2 Darts');
  eq(findCheckouts(40, 1)[0].darts.map((d) => d.label), ['D20']);
  eq(findCheckouts(32, 1)[0].darts.map((d) => d.label), ['D16']);
  ok(findCheckouts(90, 2)[0].darts.length === 2, '90 in 2 Darts');
});
test('Checkout: Bull nicht als Doppel', () => {
  eq(findCheckouts(50, 1, { bullIsDouble: false }).length, 0);
  ok(findCheckouts(50, 1).length === 1, 'Bull als Finish');
});
test('Checkout: Setup-Vorschlag wenn kein Finish möglich', () => {
  const info = checkoutInfo(99, 1);
  ok(!info.possible && info.setup, 'Setup vorhanden');
  ok(info.setup.leave >= 2, 'kein Bust');
});
test('Checkout: Ein-Dart-Finish', () => {
  ok(isOneDartFinish(40) && isOneDartFinish(50) && !isOneDartFinish(41) && !isOneDartFinish(42), 'DO');
  ok(isOneDartFinish(57, { outMode: 'master' }), 'MO T19');
});

// ---------- X01 ----------
test('X01: Punkte und Spielerwechsel', () => {
  const m = createMatch({ settings: { startScore: 501 }, players: P2 });
  throwAll(m, ['T20', 'T20', 'T20']);
  const st = replay(m);
  eq(st.current.rem, [321, 501]);
  eq(st.currentPlayer, 1);
});
test('X01: Bust bei Überwerfen, bei Rest 1 und ohne Doppel', () => {
  let m = createMatch({ settings: { startScore: 40 }, players: P1 });
  let r = throwAll(m, ['S20', 'S19']);
  ok(r.visit.bust, 'Rest 1 = Bust');
  eq(replay(m).current.rem, [40]);
  m = createMatch({ settings: { startScore: 40 }, players: P1 });
  r = throwAll(m, ['T20']);
  ok(r.visit.bust, 'Überworfen');
  m = createMatch({ settings: { startScore: 40 }, players: P1 });
  r = throwAll(m, ['S20', 'S20']);
  ok(r.visit.bust, 'Auf 0 ohne Doppel');
  eq(replay(m).current.rem, [40]);
});
test('X01: Double-Out Leggewinn', () => {
  const m = createMatch({ settings: { startScore: 40, legsToWin: 2 }, players: P2 });
  const r = throwAll(m, ['D20']);
  eq(r.legWon, 0);
  const st = replay(m);
  eq(st.legsInSet, [1, 0]);
  eq(st.currentPlayer, 1, 'Nächstes Leg beginnt Spieler 2');
  eq(m.legs.length, 2);
});
test('X01: Straight-Out und Master-Out', () => {
  let m = createMatch({ settings: { startScore: 21, outMode: 'straight', legsToWin: 1 }, players: P1 });
  let r = throwAll(m, ['S20', 'S1']);
  eq(r.matchWon, 0);
  m = createMatch({ settings: { startScore: 60, outMode: 'master', legsToWin: 1 }, players: P1 });
  r = throwAll(m, ['T20']);
  eq(r.matchWon, 0, 'Master-Out mit Triple');
  m = createMatch({ settings: { startScore: 21, outMode: 'master', legsToWin: 1 }, players: P1 });
  r = throwAll(m, ['S20']);
  ok(r.visit.bust, 'Master-Out Rest 1 = Bust');
});
test('X01: Double-In', () => {
  const m = createMatch({ settings: { startScore: 501, inMode: 'double' }, players: P1 });
  throwAll(m, ['T20', 'D10', 'T20']);
  eq(replay(m).current.rem, [501 - 20 - 60]);
});
test('X01: Sets und Matchgewinn', () => {
  const m = createMatch({ settings: { startScore: 40, legsToWin: 2, setsToWin: 2 }, players: P2 });
  // Leg 1: A beginnt
  throwAll(m, ['D20']); // A 1:0
  throwAll(m, ['S1', 'S1', 'S1']); // B beginnt Leg 2 – kein Finish
  throwAll(m, ['D20']); // A gewinnt Set 1
  let st = replay(m);
  eq(st.setsWon, [1, 0]);
  eq(m.legs[m.legs.length - 1].set, 2);
  // Set 2: Leg 3 beginnt A (Rotation)
  throwAll(m, ['D20']);
  throwAll(m, ['S1', 'S1', 'S1']);
  const r = throwAll(m, ['D20']);
  eq(r.matchWon, 0);
  eq(m.status, 'finished');
});
test('X01: Aufnahme manuell beenden', () => {
  const m = createMatch({ players: P2 });
  throwAll(m, ['T20']);
  ok(endVisit(m), 'beendet');
  eq(replay(m).currentPlayer, 1);
  eq(endVisit(m), null, 'leere Aufnahme nicht beendbar');
});
test('X01: Undo über Leg- und Matchgrenzen', () => {
  const m = createMatch({ settings: { startScore: 40, legsToWin: 1 }, players: P2 });
  throwAll(m, ['D20']);
  eq(m.status, 'finished');
  undoDart(m);
  eq(m.status, 'running');
  eq(replay(m).current.rem, [40, 40]);
  const m2 = createMatch({ settings: { startScore: 40, legsToWin: 2 }, players: P2 });
  throwAll(m2, ['D20']);
  eq(m2.legs.length, 2);
  undoDart(m2);
  eq(m2.legs.length, 1);
  eq(replay(m2).currentPlayer, 0);
});
test('X01: Aufnahme rückgängig / wiederholen', () => {
  const m = createMatch({ players: P2 });
  throwAll(m, ['T20', 'T20', 'T20', 'S1']);
  ok(clearOpenVisit(m), 'offene Aufnahme verworfen');
  eq(replay(m).current.rem, [321, 501]);
  undoVisit(m);
  eq(replay(m).current.rem, [501, 501]);
});
test('X01: Korrektur mit Protokoll und Bust-Neubewertung', () => {
  const m = createMatch({ settings: { startScore: 100 }, players: P2 });
  throwAll(m, ['T20']);
  replaceDart(m, 0, 0, 0, D('S20'));
  eq(replay(m).current.rem, [80, 501 - 401]);
  eq(m.legs[0].visits[0].darts[0].original.label, 'T20');
  eq(m.corrections.length, 1);
  throwAll(m, ['S20', 'S20']); // A: 80 -> 40 offen? (S20,S20 -> 40) dann Aufnahme geschlossen
  // Korrektur, die einen Bust erzeugt, kürzt nachfolgende Darts
  const m2 = createMatch({ settings: { startScore: 60 }, players: P2 });
  throwAll(m2, ['S20', 'S20']);
  replaceDart(m2, 0, 0, 0, D('T20'));
  ok(replay(m2).current.visits[0].bust, 'Bust nach Korrektur');
  eq(m2.legs[0].visits[0].darts.length, 1, 'Darts nach Bust entfernt');
});
test('X01: Dart löschen', () => {
  const m = createMatch({ players: P2 });
  throwAll(m, ['T20', 'T19']);
  deleteDart(m, 0, 0, 1);
  eq(replay(m).current.rem, [441, 501]);
  eq(replay(m).currentPlayer, 0);
});

// ---------- Statistik ----------
test('Statistik: Average, First 9, 180er, Checkout-Quote', () => {
  const m = createMatch({ settings: { startScore: 501, legsToWin: 1 }, players: P1 });
  throwAll(m, ['T20', 'T20', 'T20', 'T20', 'T20', 'T20', 'T20', 'T19', 'D12']);
  const ps = matchStats(m).players[0];
  eq(ps.darts, 9);
  eq(ps.average, 167);
  eq(ps.first9, 167);
  eq(ps.c180, 2);
  eq(ps.coAttempts, 1);
  eq(ps.coRate, 1);
  eq(ps.highestCo, 141);
  eq(ps.bestLeg, 9);
});
test('Statistik: Bust-Darts zählen mit 0 Punkten, vergebene Matchdarts', () => {
  const m = createMatch({ settings: { startScore: 40, legsToWin: 1 }, players: P1 });
  throwAll(m, ['S20', 'D5', 'D5']); // 40 -> 20 (S20), D5 -> 10, D5 -> 0 Finish
  let ps = matchStats(m).players[0];
  eq(ps.coAttempts, 3, 'Versuche bei 40, 20 und 10');
  eq(ps.missedMatchDarts, 2);
  const m2 = createMatch({ settings: { startScore: 40, legsToWin: 1 }, players: P1 });
  throwAll(m2, ['T20']);
  ps = matchStats(m2).players[0];
  eq(ps.darts, 1); eq(ps.points, 0); eq(ps.busts, 1);
});

// ---------- Homographie ----------
test('Homographie: Hin- und Rücktransformation', () => {
  const src = [{ x: -100, y: 100 }, { x: 100, y: 100 }, { x: 100, y: -100 }, { x: -100, y: -100 }];
  const dst = [{ x: 0.2, y: 0.1 }, { x: 0.75, y: 0.18 }, { x: 0.7, y: 0.9 }, { x: 0.25, y: 0.8 }];
  const H = solveHomography(src, dst);
  for (let i = 0; i < 4; i++) {
    const p = applyH(H, src[i].x, src[i].y);
    ok(Math.abs(p.x - dst[i].x) < 1e-9 && Math.abs(p.y - dst[i].y) < 1e-9, `Punkt ${i}`);
  }
  const Hi = invertH(H);
  const q = applyH(Hi, ...Object.values(applyH(H, 33, -12)));
  ok(Math.abs(q.x - 33) < 1e-6 && Math.abs(q.y + 12) < 1e-6, 'Inverse');
});

// ---------- Bot ----------
const botResults = [];
test('Bot: kalibrierter Average trifft Zielwert (±3, unabhängige Simulation)', () => {
  for (const [avg, pers] of [[30, 'beginner'], [60, 'constant'], [90, 'scorer'], [120, 'pro']]) {
    const t0 = performance.now();
    const sigma = calibrateSigma(avg, pers);
    const dt = performance.now() - t0;
    const real = simulateAverage(sigma, PERSONALITIES[pers], 400, 98765);
    botResults.push(`${avg} ${pers}: σ=${sigma.toFixed(1)} mm → ${real.toFixed(1)} (Kalibrierung ${dt.toFixed(0)} ms)`);
    ok(Math.abs(real - avg) <= 3, `Ziel ${avg} (${pers}) ergab ${real.toFixed(1)}`);
  }
});
test('Bot: spielt ein komplettes Match regelkonform', () => {
  const m = createMatch({ settings: { startScore: 501, legsToWin: 2 }, players: [{ id: 'x', name: 'Bot', isBot: true }] });
  const bot = new Bot({ average: 80, personality: 'pro', seed: 7 });
  let guard = 0;
  while (m.status === 'running' && guard++ < 2000) {
    const st = replay(m);
    if (!st.openVisit) bot.startVisit();
    const p = st.currentPlayer;
    const rem = st.current.rem[p];
    addDart(m, bot.throwDart(rem, 3 - st.dartsInVisit, st.current.isIn[p], m.settings));
  }
  eq(m.status, 'finished');
});

// ---------- Bildverarbeitung (synthetische Szene) ----------
// Zeichnet eine Scheibe affin verzerrt (seitlicher Blickwinkel) und einen Pfeil mit dünner Spitze
// und breitem Flight. Prüft Kalibrier-Qualität, Auto-Schätzung und die komplette Erkennungskette.
const W = 480, HH = 270;
const A = { a: 0.62, b: 0.05, c: -0.02, d: -0.6, e: 250, f: 135 }; // Board(mm, y oben) → Pixel
const Hnorm = [A.a / W, A.c / W, A.e / W, A.b / HH, A.d / HH, A.f / HH, 0, 0, 1];
function boardToPx(x, y) { return { x: A.a * x + A.c * y + A.e, y: A.b * x + A.d * y + A.f }; }
function drawScene(darts = []) {
  const c = document.createElement('canvas'); c.width = W; c.height = HH;
  const g = c.getContext('2d');
  g.fillStyle = '#6b6f75'; g.fillRect(0, 0, W, HH);
  g.save();
  g.setTransform(A.a, A.b, A.c, A.d, A.e, A.f);
  g.fillStyle = '#111'; g.beginPath(); g.arc(0, 0, 225, 0, Math.PI * 2); g.fill();
  SEGMENTS.forEach((seg, i) => {
    const a1 = ((90 - i * 18 - 9) * Math.PI) / 180, a2 = ((90 - i * 18 + 9) * Math.PI) / 180;
    const ring = i % 2 === 0 ? '#c8282d' : '#13924a', single = i % 2 === 0 ? '#151515' : '#efe3c4';
    for (const [r1, r2, col] of [[15.9, 99, single], [99, 107, ring], [107, 162, single], [162, 170, ring]]) {
      g.fillStyle = col; g.beginPath(); g.arc(0, 0, r2, a1, a2); g.arc(0, 0, r1, a2, a1, true); g.closePath(); g.fill();
    }
  });
  g.fillStyle = '#13924a'; g.beginPath(); g.arc(0, 0, 15.9, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#c8282d'; g.beginPath(); g.arc(0, 0, 6.35, 0, Math.PI * 2); g.fill();
  g.restore();
  for (const d of darts) {
    const tip = boardToPx(d.x, d.y);
    const tail = { x: tip.x + 46, y: tip.y - 30 };
    g.strokeStyle = '#9aa0a8'; g.lineWidth = 2; g.beginPath(); g.moveTo(tip.x, tip.y); g.lineTo(tip.x + 14, tip.y - 9); g.stroke();
    g.strokeStyle = '#3a4a9a'; g.lineWidth = 5; g.beginPath(); g.moveTo(tip.x + 14, tip.y - 9); g.lineTo(tip.x + 32, tip.y - 21); g.stroke();
    g.fillStyle = '#f2c230'; g.beginPath(); g.moveTo(tip.x + 30, tip.y - 20); g.lineTo(tail.x + 4, tail.y - 9); g.lineTo(tail.x + 8, tail.y + 6); g.closePath(); g.fill();
  }
  return g.getImageData(0, 0, W, HH);
}
const { DartDetector } = await import('../js/vision/detector.js');
const cal = await import('../js/vision/calibration.js');
test('Vision: Kalibrierqualität auf korrekt kalibrierter Szene > 90 %', () => {
  const q = cal.calibrationQuality(drawScene(), Hnorm).score;
  ok(q > 0.9, `Qualität ${q}`);
  const wrong = cal.rotateH(Hnorm, 18);
  ok(cal.calibrationQuality(drawScene(), wrong).score < 0.6, 'falsch gedrehte Kalibrierung wird erkannt');
});
test('Vision: automatische Erstschätzung liegt nahe an der echten Lage', () => {
  const g = cal.autoGuess(drawScene());
  ok(g, 'Schätzung vorhanden');
  const truth = cal.pointsFromH(Hnorm);
  const err = Math.max(...g.map((p, i) => Math.hypot((p.x - truth[i].x) * W, (p.y - truth[i].y) * HH)));
  ok(err < 25, `max. Abweichung ${err.toFixed(1)} px`);
});
const visionLog = [];
test('Vision: Pfeile werden per Bildvergleich erkannt, gezählt und entfernt', () => {
  const det = new DartDetector();
  det.setCalibration(Hnorm, W, HH);
  const empty = drawScene();
  det.process(empty);
  const targets = [targetPoint(20, 3), targetPoint(16, 2), targetPoint(17, 1), { x: 0, y: 0 }];
  const expected = ['T20', 'D16', 'S17', 'Bull'];
  const placed = [];
  const run = (img) => { let evs = []; for (let k = 0; k < 8; k++) evs = evs.concat(det.process(img)); return evs; };
  targets.forEach((t, i) => {
    placed.push(t);
    const evs = run(drawScene(placed));
    const dart = evs.find((e) => e.type === 'dart');
    ok(dart, `Pfeil ${i + 1} erkannt`);
    visionLog.push(`${expected[i]} → ${dart.hit.label} (Konfidenz ${Math.round(dart.conf * 100)} %, Abweichung ${Math.hypot(dart.board.x - t.x, dart.board.y - t.y).toFixed(1)} mm${dart.reasons.length ? ', ' + dart.reasons.join(', ') : ''})`);
    eq(dart.hit.label, expected[i], `Pfeil ${i + 1}`);
  });
  det.awaitTakeout();
  const evs = run(empty);
  ok(evs.some((e) => e.type === 'takeout'), 'Entfernen erkannt');
  eq(det.dartsOnBoard, 0);
  ok(!run(empty).some((e) => e.type === 'dart'), 'keine Phantom-Pfeile');
});

// ---------- Ausgabe ----------
const out = document.getElementById('out');
const failed = results.filter((r) => !r.ok);
document.getElementById('summary').innerHTML = failed.length
  ? `<span class="fail">${failed.length} von ${results.length} Tests fehlgeschlagen</span>`
  : `<span class="pass">Alle ${results.length} Tests bestanden</span>`;
out.innerHTML = results.map((r) => `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? '✔' : '✘'} ${r.name}${r.ok ? '' : `<pre>${r.err}</pre>`}</div>`).join('')
  + `<h2>Bot-Kalibrierung</h2><pre>${botResults.join('\n')}</pre>`
  + `<h2>Erkennung (synthetisch)</h2><pre>${visionLog.join('\n')}</pre>`;
window.__testResults = { total: results.length, failed: failed.map((f) => `${f.name}: ${f.err}`), bot: botResults, vision: visionLog };
