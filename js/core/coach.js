// Autodarts180 Coach (Grundversion): regelbasierte Hinweise ausschließlich aus gespeicherten Daten.
// Gibt nichts aus, wenn die Datenbasis zu klein ist – es werden keine Werte erfunden.
const f2 = (v) => v.toFixed(1).replace('.', ',');

export function coachInsights(career, scatter = []) {
  const out = [];
  const h = career.history.filter((x) => x.average != null);
  if (h.length >= 6) {
    const last = h.slice(-5), prev = h.slice(-10, -5);
    const a = mean(last.map((x) => x.average)), b = mean(prev.map((x) => x.average));
    const d = a - b;
    if (Math.abs(d) >= 1) {
      out.push({ kind: d > 0 ? 'good' : 'warn', text: `Dein Average ist in den letzten ${last.length} Matches im Schnitt um ${f2(Math.abs(d))} Punkte ${d > 0 ? 'gestiegen' : 'gesunken'} (${f2(b)} → ${f2(a)}).` });
    } else {
      out.push({ kind: 'info', text: `Dein Average ist stabil: ${f2(a)} in den letzten ${last.length} Matches.` });
    }
    const sd = Math.sqrt(mean(last.map((x) => (x.average - a) ** 2)));
    if (sd > 8) out.push({ kind: 'warn', text: `Deine Leistung schwankt deutlich (Standardabweichung ${f2(sd)} Punkte über die letzten ${last.length} Matches).` });
  } else if (h.length) {
    out.push({ kind: 'info', text: `Noch ${6 - h.length} abgeschlossene Matches, dann kann der Coach Trends erkennen.` });
  }
  if (career.coAttempts >= 20) {
    const r = career.coRate * 100;
    out.push({
      kind: r < 25 ? 'warn' : 'good',
      text: `Deine Checkout-Quote liegt bei ${f2(r)} % (${career.coHits} von ${career.coAttempts} Darts auf ein Finish).${r < 25 ? ' Gezieltes Doppel-Training lohnt sich.' : ''}`,
    });
  }
  for (const s of scatter) {
    if (!s.enough) continue;
    const dir = s.direction.length ? `Deine Würfe um T${s.seg} liegen im Mittel ${s.direction.join(' und ')} des Feldes` : `Deine Würfe um T${s.seg} sind gut zentriert`;
    out.push({ kind: s.direction.length ? 'warn' : 'good', text: `${dir} (Basis: ${s.n} erkannte Würfe, Triple-Anteil ${f2(s.tripleRate * 100)} %).` });
  }
  return out;
}

function mean(a) {
  return a.reduce((x, y) => x + y, 0) / (a.length || 1);
}
