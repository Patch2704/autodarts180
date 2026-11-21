// X01-Spielsystem. Das Match speichert nur die geworfenen Darts (Event-Log);
// alle Spielstände werden per replay() abgeleitet – dadurch sind Undo, Korrektur
// und Wiederherstellung nach Unterbrechung immer konsistent.
import { isDoubleDart, isValidFinish } from './checkout.js';
import { uid } from './rng.js';

export const DEFAULT_SETTINGS = {
  startScore: 501,
  inMode: 'straight', // 'straight' | 'double'
  outMode: 'double', // 'double' | 'master' | 'straight'
  bullIsDouble: true, // zählt Bull (50) als Doppel für Double-In/Out?
  legsToWin: 3, // "first to" Legs pro Set
  setsToWin: 1, // "first to" Sets
  startPlayer: 0,
};

export function createMatch({ settings = {}, players, id }) {
  if (!players || !players.length) throw new Error('Mindestens ein Spieler erforderlich');
  const s = { ...DEFAULT_SETTINGS, ...settings };
  s.startPlayer = ((s.startPlayer % players.length) + players.length) % players.length;
  const now = Date.now();
  return {
    id: id || uid(), type: 'x01', version: 1, settings: s,
    players: players.map((p) => ({ id: p.id, name: p.name, isBot: !!p.isBot, bot: p.bot || null })),
    legs: [{ set: 1, leg: 1, starter: s.startPlayer, visits: [] }],
    status: 'running', winner: null,
    createdAt: now, updatedAt: now, finishedAt: null,
    corrections: [],
  };
}

/** Bewertet eine Aufnahme ausgehend von Restpunkten / Double-In-Status */
export function evalVisit(visit, remStart, inStart, s) {
  let rem = remStart, inn = inStart, bust = false, finished = false;
  const darts = [];
  for (const d of visit.darts) {
    const ev = { ...d, remBefore: rem, inBefore: inn, points: 0 };
    if (bust || finished) { ev.ignored = true; ev.remAfter = rem; darts.push(ev); continue; }
    let pts = d.score;
    let nowIn = inn;
    if (!inn) {
      if (isDoubleDart(d, s)) nowIn = true;
      else pts = 0;
    }
    const nr = rem - pts;
    if (nr < 0 || (nr === 1 && s.outMode !== 'straight') || (nr === 0 && !isValidFinish(d, s))) {
      bust = true; ev.bust = true; rem = remStart; inn = inStart;
    } else {
      rem = nr; inn = nowIn; ev.points = pts;
      if (nr === 0) { finished = true; ev.finish = true; }
    }
    ev.remAfter = rem;
    darts.push(ev);
  }
  const counted = darts.filter((d) => !d.ignored).length;
  return {
    p: visit.p, darts, bust, finished,
    closed: bust || finished || visit.darts.length >= 3 || !!visit.closed,
    remBefore: remStart, remAfter: rem, inAfter: inn,
    scored: bust ? 0 : remStart - rem, dartCount: counted,
  };
}

/** Leitet den kompletten Spielstand aus dem Match ab */
export function replay(match) {
  const s = match.settings, n = match.players.length;
  const setsWon = Array(n).fill(0);
  let legsInSet = Array(n).fill(0);
  const legsTotal = Array(n).fill(0);
  const legs = [];
  let matchWinner = null;
  for (let li = 0; li < match.legs.length; li++) {
    const leg = match.legs[li];
    const before = { setsWon: [...setsWon], legsInSet: [...legsInSet] };
    const rem = Array(n).fill(s.startScore);
    const isIn = Array(n).fill(s.inMode !== 'double');
    const visits = [];
    let winner = null;
    for (const v of leg.visits) {
      if (winner !== null) break;
      const ev = evalVisit(v, rem[v.p], isIn[v.p], s);
      rem[v.p] = ev.remAfter;
      isIn[v.p] = ev.inAfter;
      visits.push(ev);
      if (ev.finished) winner = v.p;
    }
    let setWon = false;
    if (winner !== null) {
      legsInSet[winner]++;
      legsTotal[winner]++;
      if (legsInSet[winner] >= s.legsToWin) {
        setsWon[winner]++;
        setWon = true;
        legsInSet = Array(n).fill(0);
        if (setsWon[winner] >= s.setsToWin) matchWinner = winner;
      }
    }
    legs.push({ index: li, set: leg.set, leg: leg.leg, starter: leg.starter, rem, isIn, visits, winner, setWon, before });
  }
  const cur = legs[legs.length - 1];
  let currentPlayer = null, openVisit = null;
  if (matchWinner === null && cur.winner === null) {
    const last = cur.visits[cur.visits.length - 1];
    if (!last) currentPlayer = cur.starter;
    else if (!last.closed) { currentPlayer = last.p; openVisit = last; }
    else currentPlayer = (last.p + 1) % n;
  }
  return {
    legs, setsWon, legsInSet, legsTotal, matchWinner,
    current: cur, currentPlayer, openVisit,
    dartsInVisit: openVisit ? openVisit.dartCount : 0,
    finished: matchWinner !== null,
  };
}

function cleanDart(d) {
  const out = { seg: d.seg, mult: d.mult, score: d.score, label: d.label, source: d.source || 'manual', t: d.t || Date.now() };
  if (Number.isFinite(d.x) && Number.isFinite(d.y)) { out.x = +d.x.toFixed(2); out.y = +d.y.toFixed(2); }
  if (d.conf != null) out.conf = +(+d.conf).toFixed(3);
  if (d.original) out.original = d.original;
  if (d.corrected) out.corrected = true;
  if (d.confirmed) out.confirmed = true;
  return out;
}

function afterChange(match) {
  let st = replay(match);
  const cur = st.current;
  const res = { visit: cur.visits[cur.visits.length - 1] || null, legWon: null, setWon: false, matchWon: null };
  if (cur.winner !== null) {
    res.legWon = cur.winner;
    res.setWon = cur.setWon;
    if (st.matchWinner !== null) {
      match.status = 'finished';
      match.winner = st.matchWinner;
      match.finishedAt = Date.now();
      res.matchWon = st.matchWinner;
    } else {
      const k = match.legs.length;
      const prev = match.legs[k - 1];
      match.legs.push({
        set: cur.setWon ? prev.set + 1 : prev.set,
        leg: cur.setWon ? 1 : prev.leg + 1,
        starter: (match.settings.startPlayer + k) % match.players.length,
        visits: [],
      });
      st = replay(match);
    }
  }
  match.updatedAt = Date.now();
  res.state = st;
  return res;
}

function reopen(match) {
  if (match.status === 'finished') {
    match.status = 'running';
    match.winner = null;
    match.finishedAt = null;
  }
}

/** Fügt einen Dart für den aktuellen Spieler hinzu */
export function addDart(match, dart) {
  if (match.status !== 'running') throw new Error('Match ist nicht aktiv');
  const st = replay(match);
  const leg = match.legs[match.legs.length - 1];
  if (!st.openVisit) leg.visits.push({ p: st.currentPlayer, darts: [] });
  leg.visits[leg.visits.length - 1].darts.push(cleanDart(dart));
  return afterChange(match);
}

/** Aufnahme manuell abschließen (bei 1–2 geworfenen Darts) */
export function endVisit(match) {
  const st = replay(match);
  if (!st.openVisit || st.openVisit.dartCount === 0) return null;
  const leg = match.legs[match.legs.length - 1];
  leg.visits[leg.visits.length - 1].closed = true;
  return afterChange(match);
}

/** Letzte Aktion zurücknehmen (letzter Dart bzw. manuelles Abschließen) */
export function undoDart(match) {
  reopen(match);
  for (;;) {
    const leg = match.legs[match.legs.length - 1];
    const v = leg.visits[leg.visits.length - 1];
    if (!v) {
      if (match.legs.length > 1) { match.legs.pop(); continue; }
      return false;
    }
    if (v.closed) {
      delete v.closed;
      if (!v.darts.length) leg.visits.pop();
      match.updatedAt = Date.now();
      return true;
    }
    if (v.darts.length) {
      v.darts.pop();
      if (!v.darts.length) leg.visits.pop();
      match.updatedAt = Date.now();
      return true;
    }
    leg.visits.pop();
  }
}

/** Gesamte letzte Aufnahme entfernen */
export function undoVisit(match) {
  reopen(match);
  for (;;) {
    const leg = match.legs[match.legs.length - 1];
    if (!leg.visits.length) {
      if (match.legs.length > 1) { match.legs.pop(); continue; }
      return false;
    }
    leg.visits.pop();
    match.updatedAt = Date.now();
    return true;
  }
}

/** Aktuelle (offene) Aufnahme verwerfen, um sie zu wiederholen */
export function clearOpenVisit(match) {
  const st = replay(match);
  if (!st.openVisit) return false;
  match.legs[match.legs.length - 1].visits.pop();
  match.updatedAt = Date.now();
  return true;
}

function assertEditable(match, li) {
  if (li !== match.legs.length - 1) throw new Error('Nur Darts des aktuellen Legs können bearbeitet werden');
}

function normalize(match) {
  reopen(match);
  const li = match.legs.length - 1;
  const leg = match.legs[li];
  const st = replay(match);
  const cl = st.legs[li];
  cl.visits.forEach((ev, i) => {
    leg.visits[i].darts.length = ev.darts.filter((d) => !d.ignored).length;
  });
  if (cl.visits.length < leg.visits.length) leg.visits.length = cl.visits.length;
  return afterChange(match);
}

/** Einzelnen Dart korrigieren – Original bleibt nachvollziehbar gespeichert */
export function replaceDart(match, li, vi, di, newDart) {
  assertEditable(match, li);
  const v = match.legs[li].visits[vi];
  const old = v.darts[di];
  if (!old) throw new Error('Dart nicht gefunden');
  const original = old.original || { label: old.label, source: old.source, x: old.x, y: old.y, conf: old.conf };
  v.darts[di] = cleanDart({ ...newDart, source: old.source, original, corrected: true, t: old.t });
  match.corrections.push({ at: Date.now(), action: 'replace', leg: li, visit: vi, dart: di, from: old.label, to: newDart.label });
  return normalize(match);
}

/** Einzelnen Dart löschen */
export function deleteDart(match, li, vi, di) {
  assertEditable(match, li);
  const leg = match.legs[li];
  const v = leg.visits[vi];
  const old = v.darts[di];
  if (!old) throw new Error('Dart nicht gefunden');
  v.darts.splice(di, 1);
  if (vi === leg.visits.length - 1) {
    if (!v.darts.length) leg.visits.pop();
  } else {
    v.closed = true; // Reihenfolge der Spieler bleibt erhalten
  }
  match.corrections.push({ at: Date.now(), action: 'delete', leg: li, visit: vi, dart: di, from: old.label });
  return normalize(match);
}
