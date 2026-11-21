import { h, fmt, statTile, segControl, clear } from '../dom.js';
import { players as P, matches as M } from '../../data/repo.js';
import { careerStats, positionedDarts, scatterAnalysis } from '../../core/stats.js';
import { coachInsights } from '../../core/coach.js';
import { heatmapSvg, lineChart } from '../boardSvg.js';
import { settings } from '../../state.js';

const RANGES = [
  { value: 1, label: 'Letztes Match' },
  { value: 5, label: 'Letzte 5' },
  { value: 10, label: 'Letzte 10' },
  { value: 0, label: 'Gesamt' },
];

export async function render(root, params) {
  const [plist, finished] = await Promise.all([P.list(), M.finished()]);
  root.append(h('div', { class: 'page-head' }, h('h1', {}, 'Statistiken')));
  if (!plist.length) { root.append(h('div', { class: 'notice' }, 'Noch keine Spieler vorhanden.')); return; }

  let pid = params[0] && plist.some((p) => p.id === params[0]) ? params[0] : (settings.get('mainPlayer') || plist[0].id);
  let range = 0;
  const sel = h('select', { onchange: () => { pid = sel.value; draw(); } }, plist.map((p) => h('option', { value: p.id, selected: p.id === pid }, p.name)));
  const body = h('div', {});
  root.append(h('div', { class: 'card' },
    h('div', { class: 'grid grid-2 stack-sm' },
      h('label', { class: 'field' }, 'Spieler', sel),
      h('label', { class: 'field' }, 'Zeitraum', segControl(RANGES, range, (v) => { range = v; draw(); })))),
  body);

  function draw() {
    clear(body);
    const mine = finished.filter((m) => m.players.some((p) => p.id === pid)); // neueste zuerst
    const subset = range ? mine.slice(0, range) : mine;
    if (!subset.length) { body.append(h('div', { class: 'notice', style: { marginTop: '12px' } }, 'Für diesen Spieler gibt es im gewählten Zeitraum noch keine abgeschlossenen Matches.')); return; }
    const c = careerStats(pid, subset);

    body.append(h('div', { class: 'card' },
      h('h3', {}, `Leistung · ${c.matches} Match${c.matches === 1 ? '' : 'es'}`),
      h('div', { class: 'grid grid-4' },
        statTile('3-Dart-Average', fmt.avg(c.average), true),
        statTile('First-9-Average', fmt.avg(c.first9)),
        statTile('Checkout-Quote', fmt.pct(c.coRate)),
        statTile('Siege / Niederlagen', `${c.wins} / ${c.losses}`),
        statTile('Höchste Aufnahme', c.highest || '–'),
        statTile('Höchstes Checkout', c.highestCo || '–'),
        statTile('Bestes Leg', c.bestLeg ? `${c.bestLeg} Darts` : '–'),
        statTile('Gewonnene Legs', c.legsWon),
        statTile('180er', c.c180),
        statTile('140+', c.c140),
        statTile('100+', c.c100),
        statTile('Checkout-Darts', `${c.coHits} / ${c.coAttempts}`))));

    if (c.history.length > 1) {
      body.append(h('div', { class: 'card' }, h('h3', {}, 'Average-Entwicklung'), lineChart(c.history.map((x) => x.average)),
        h('div', { class: 'small muted' }, `Von ${fmt.date(c.history[0].date)} bis ${fmt.date(c.history[c.history.length - 1].date)}`)));
    }

    const darts = positionedDarts(pid, subset);
    const scatter = [scatterAnalysis(darts, 20), scatterAnalysis(darts, 19)];
    const heat = h('div', { class: 'card' }, h('h3', {}, 'Dart-Heatmap'));
    if (!darts.length) {
      heat.append(h('div', { class: 'notice' }, 'Die Heatmap verwendet nur echte Trefferpositionen aus der Kamera-Erkennung. Im gewählten Zeitraum gibt es noch keine kamera-erkannten Würfe dieses Spielers.'));
    } else {
      heat.append(heatmapSvg(darts), h('div', { class: 'small muted', style: { textAlign: 'center', marginTop: '6px' } }, `${darts.length} Würfe mit Kameraposition (manuell korrigierte Würfe ausgenommen) · blau = selten, rot = häufig`));
      const sc = scatter.filter((s) => s.enough);
      if (sc.length) {
        heat.append(h('h3', { style: { marginTop: '14px' } }, 'Streuung'), h('div', { class: 'grid grid-2 stack-sm' }, sc.map((s) => h('div', { class: 'stat' },
          h('div', { class: 'l' }, `Um Triple ${s.seg} (${s.n} Würfe)`),
          h('div', { style: { fontWeight: 700, marginTop: '4px' } }, s.direction.length ? `Tendenz: ${s.direction.join(', ')}` : 'Gut zentriert'),
          h('div', { class: 'small muted' }, `Mittlere Abweichung ${s.offsetTangential.toFixed(1)} mm seitlich, ${s.offsetRadial.toFixed(1)} mm radial · Streuradius ${s.spread.toFixed(1)} mm · T${s.seg}-Anteil ${fmt.pct(s.tripleRate)}`)))),
        h('div', { class: 'small muted', style: { marginTop: '6px' } }, 'Annahme: Würfe im Umkreis von 45 mm um das Triple zielten auf das Triple.'));
      }
    }
    body.append(heat);

    const tips = coachInsights(careerStats(pid, mine), scatter);
    body.append(h('div', { class: 'card' }, h('h3', {}, 'Autodarts180 Coach (Grundversion)'),
      tips.length ? h('div', { class: 'stack' }, tips.map((t) => h('div', { class: `notice ${t.kind === 'good' ? 'ok' : t.kind === 'warn' ? 'warn' : ''}` }, t.text)))
        : h('div', { class: 'small muted' }, 'Für Hinweise braucht der Coach mehr Daten.'),
      h('div', { class: 'small muted', style: { marginTop: '8px' } }, 'Alle Hinweise beruhen ausschließlich auf deinen gespeicherten Matches über den gesamten Zeitraum.')));

    body.append(h('div', { class: 'card' }, h('h3', {}, 'Matches im Vergleich'),
      h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Datum'), h('th', { class: 'r' }, 'Average'), h('th', { class: 'r' }, 'First 9'), h('th', { class: 'r' }, 'Checkout'), h('th', {}, 'Ergebnis'))),
        h('tbody', {}, [...c.history].reverse().map((x) => h('tr', { style: { cursor: 'pointer' }, onclick: () => { location.hash = `#/match/${x.matchId}`; } },
          h('td', {}, fmt.dateTime(x.date)), h('td', { class: 'r num' }, fmt.avg(x.average)), h('td', { class: 'r num' }, fmt.avg(x.first9)),
          h('td', { class: 'r num' }, fmt.pct(x.coRate)), h('td', {}, h('span', { class: `badge ${x.won ? 'green' : 'red'}` }, x.won ? 'Sieg' : 'Niederlage')))))))));

    body.append(h('div', { class: 'card soon' }, h('div', { class: 'row between' }, h('h3', { style: { margin: 0 } }, 'Trefferquoten je Zielfeld'), h('span', { class: 'soon-tag' }, 'noch nicht verfügbar')),
      h('p', { class: 'small muted', style: { marginBottom: 0 } }, 'Triple-, Doppel-, T20-, T19- und Bull-Quoten setzen voraus, dass bekannt ist, worauf gezielt wurde. Sie werden mit dem Trainingsbereich erfasst und hier nicht geschätzt.')));
  }
  draw();
}
