// Statistiken – ausschließlich aus tatsächlich gespeicherten Würfen berechnet.
import { replay } from './x01.js';
import { isOneDartFinish } from './checkout.js';
import { R, targetPoint } from './board.js';

const avg3 = (points, darts) => (darts ? (points / darts) * 3 : null);

export function matchStats(match) {
  const s = match.settings, n = match.players.length;
  const st = replay(match);
  const P = match.players.map((p, i) => ({
    playerId: p.id, name: p.name, isBot: p.isBot, index: i,
    darts: 0, points: 0, visits: 0, f9Darts: 0, f9Points: 0,
    highest: 0, c180: 0, c140: 0, c100: 0, c60: 0, busts: 0,
    coAttempts: 0, coHits: 0, highestCo: 0,
    legsWon: st.legsTotal[i], setsWon: st.setsWon[i], legDarts: [],
    missedLegDarts: 0, missedMatchDarts: 0, corrected: 0, cameraDarts: 0,
  }));
  let legsPlayed = 0;
  for (const leg of st.legs) {
    if (!leg.visits.length) continue;
    legsPlayed++;
    const vcount = Array(n).fill(0);
    const dcount = Array(n).fill(0);
    for (const v of leg.visits) {
      const ps = P[v.p];
      const k = vcount[v.p]++;
      const nd = v.dartCount;
      ps.darts += nd; ps.points += v.scored; ps.visits++; dcount[v.p] += nd;
      if (k < 3) { ps.f9Darts += nd; ps.f9Points += v.scored; }
      if (v.bust) ps.busts++;
      else {
        if (v.scored === 180) ps.c180++;
        else if (v.scored >= 140) ps.c140++;
        else if (v.scored >= 100) ps.c100++;
        else if (v.scored >= 60) ps.c60++;
        ps.highest = Math.max(ps.highest, v.scored);
      }
      const matchPoint = leg.before.setsWon[v.p] === s.setsToWin - 1 && leg.before.legsInSet[v.p] === s.legsToWin - 1;
      for (const d of v.darts) {
        if (d.ignored) continue;
        if (d.source === 'camera') ps.cameraDarts++;
        if (d.corrected) ps.corrected++;
        if (d.inBefore && isOneDartFinish(d.remBefore, s)) {
          ps.coAttempts++;
          if (!d.finish) { ps.missedLegDarts++; if (matchPoint) ps.missedMatchDarts++; }
        }
      }
      if (v.finished) { ps.coHits++; ps.highestCo = Math.max(ps.highestCo, v.scored); }
    }
    if (leg.winner !== null) P[leg.winner].legDarts.push(dcount[leg.winner]);
  }
  for (const ps of P) {
    ps.average = avg3(ps.points, ps.darts);
    ps.first9 = avg3(ps.f9Points, ps.f9Darts);
    ps.coRate = ps.coAttempts ? ps.coHits / ps.coAttempts : null;
    ps.dartsPerLeg = ps.legDarts.length ? ps.legDarts.reduce((a, b) => a + b, 0) / ps.legDarts.length : null;
    ps.bestLeg = ps.legDarts.length ? Math.min(...ps.legDarts) : null;
  }
  const end = match.finishedAt || match.updatedAt;
  return { players: P, legsPlayed, duration: end - match.createdAt, winner: match.winner, state: st };
}

/** Langzeitstatistik eines Spielers über alle abgeschlossenen Matches */
export function careerStats(playerId, matches) {
  const list = matches
    .filter((m) => m.status === 'finished' && m.players.some((p) => p.id === playerId))
    .sort((a, b) => a.createdAt - b.createdAt);
  const c = {
    matches: 0, wins: 0, losses: 0, darts: 0, points: 0, f9Darts: 0, f9Points: 0,
    c180: 0, c140: 0, c100: 0, highest: 0, highestCo: 0, coAttempts: 0, coHits: 0,
    legsWon: 0, bestLeg: null, bestAverage: null, history: [],
  };
  for (const m of list) {
    const ms = matchStats(m);
    const ps = ms.players.find((p) => p.playerId === playerId);
    if (!ps || !ps.darts) continue;
    c.matches++;
    const won = m.players[m.winner]?.id === playerId;
    if (m.players.length > 1) { if (won) c.wins++; else c.losses++; }
    c.darts += ps.darts; c.points += ps.points; c.f9Darts += ps.f9Darts; c.f9Points += ps.f9Points;
    c.c180 += ps.c180; c.c140 += ps.c140; c.c100 += ps.c100;
    c.highest = Math.max(c.highest, ps.highest);
    c.highestCo = Math.max(c.highestCo, ps.highestCo);
    c.coAttempts += ps.coAttempts; c.coHits += ps.coHits; c.legsWon += ps.legsWon;
    if (ps.bestLeg != null && (c.bestLeg == null || ps.bestLeg < c.bestLeg)) c.bestLeg = ps.bestLeg;
    if (c.bestAverage == null || ps.average > c.bestAverage) c.bestAverage = ps.average;
    c.history.push({ matchId: m.id, date: m.createdAt, average: ps.average, first9: ps.first9, coRate: ps.coRate, won });
  }
  c.average = avg3(c.points, c.darts);
  c.first9 = avg3(c.f9Points, c.f9Darts);
  c.coRate = c.coAttempts ? c.coHits / c.coAttempts : null;
  return c;
}

/** Alle Darts mit echter Trefferposition (Kamera oder Bot) eines Spielers */
export function positionedDarts(playerId, matches) {
  const out = [];
  for (const m of matches) {
    const idx = m.players.findIndex((p) => p.id === playerId);
    if (idx < 0) continue;
    for (const leg of m.legs) {
      for (const v of leg.visits) {
        if (v.p !== idx) continue;
        for (const d of v.darts) {
          if (Number.isFinite(d.x) && Number.isFinite(d.y) && !d.corrected) out.push({ x: d.x, y: d.y, label: d.label, matchId: m.id });
        }
      }
    }
  }
  return out;
}

/**
 * Streuungsanalyse um T20/T19: Würfe im jeweiligen Segment-Korridor werden relativ zur
 * Feldmitte ausgewertet. Annahme (wird in der UI genannt): diese Würfe zielten auf das Triple.
 */
export function scatterAnalysis(darts, seg) {
  const tp = targetPoint(seg, 3);
  const ang = Math.atan2(tp.y, tp.x);
  const near = darts.filter((d) => Math.hypot(d.x - tp.x, d.y - tp.y) < 45);
  if (near.length < 8) return { seg, n: near.length, enough: false };
  // in lokales System drehen: u = tangential (rechts positiv), v = radial (außen positiv)
  let su = 0, sv = 0;
  const cosA = Math.cos(ang), sinA = Math.sin(ang);
  for (const d of near) {
    const dx = d.x - tp.x, dy = d.y - tp.y;
    sv += dx * cosA + dy * sinA;
    su += dx * sinA - dy * cosA;
  }
  const mu = su / near.length, mv = sv / near.length;
  let spread = 0;
  for (const d of near) spread += (d.x - tp.x) ** 2 + (d.y - tp.y) ** 2;
  spread = Math.sqrt(spread / near.length);
  const hits = near.filter((d) => {
    const r = Math.hypot(d.x, d.y);
    return r >= R.TRIPLE_IN && r <= R.TRIPLE_OUT && d.label === `T${seg}`;
  }).length;
  // Für T20 (oben) entspricht radial außen = "oberhalb"
  const dir = [];
  if (Math.abs(mu) >= 3) dir.push(mu > 0 ? 'rechts' : 'links');
  if (Math.abs(mv) >= 3) dir.push(mv > 0 ? (seg === 20 ? 'oberhalb' : 'außerhalb') : (seg === 20 ? 'unterhalb' : 'innerhalb'));
  return { seg, n: near.length, enough: true, offsetTangential: mu, offsetRadial: mv, spread, tripleRate: hits / near.length, direction: dir };
}
