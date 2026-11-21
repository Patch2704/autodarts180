import { h, fmt, icon, confirmDialog, download, toast } from '../dom.js';
import { matches as M } from '../../data/repo.js';
import { matchStats } from '../../core/stats.js';
import { createMatch } from '../../core/x01.js';
import { uid } from '../../core/rng.js';

export async function render(root, params) {
  const m = await M.get(params[0]);
  if (!m) { root.append(h('div', { class: 'notice err' }, 'Match nicht gefunden.')); return; }
  const ms = matchStats(m);
  const s = m.settings;
  const st = ms.state;
  const result = s.setsToWin > 1 ? st.setsWon.join(' : ') : st.legsTotal.join(' : ');
  const rules = `${s.startScore} · ${s.inMode === 'double' ? 'Double-In · ' : ''}${{ double: 'Double-Out', master: 'Master-Out', straight: 'Straight-Out' }[s.outMode]} · ${s.setsToWin > 1 ? `First to ${s.setsToWin} Sets à ${s.legsToWin} Legs` : `First to ${s.legsToWin} Legs`}`;

  root.append(h('div', { class: 'page-head' },
    h('div', {},
      h('h1', {}, m.players.map((p) => p.name).join(' vs. ')),
      h('div', { class: 'muted small' }, `${fmt.dateTime(m.createdAt)} · Dauer ${fmt.duration(ms.duration)} · ${rules}`)),
    h('div', { class: 'row no-print' },
      m.status === 'running' ? h('a', { class: 'btn primary', href: `#/game/${m.id}` }, icon('play'), 'Fortsetzen') : null,
      h('button', { class: 'btn', onclick: rematch }, icon('refresh'), 'Revanche'),
      h('button', { class: 'btn', onclick: () => window.print(), title: 'Drucken oder als PDF speichern' }, icon('print'), 'PDF'),
      h('button', { class: 'btn', onclick: () => download(`autodarts180-match-${fmt.date(m.createdAt)}.json`, JSON.stringify(m, null, 2)) }, icon('download'), 'Export'),
      h('button', { class: 'btn danger', onclick: remove }, icon('trash')))));

  root.append(h('div', { class: 'card', style: { textAlign: 'center' } },
    h('div', { class: 'muted small' }, m.status === 'finished' ? 'Endergebnis' : 'Zwischenstand (Match unterbrochen)'),
    h('div', { class: 'num', style: { fontSize: '52px', fontWeight: 900, letterSpacing: '-0.03em' } }, result),
    m.status === 'finished' ? h('div', {}, h('span', { class: 'badge green' }, icon('trophy'), `${m.players[m.winner].name} gewinnt`)) : null));

  // Vergleichstabelle
  const P = ms.players;
  const best = (vals, higher = true) => {
    const nums = vals.filter((v) => typeof v === 'number' && Number.isFinite(v));
    if (nums.length < 2) return null;
    return higher ? Math.max(...nums) : Math.min(...nums);
  };
  const row = (label, get, show = (v) => v ?? '–', higher = true) => {
    const vals = P.map(get);
    const b = best(vals, higher);
    return h('tr', {}, h('td', {}, label), vals.map((v) => h('td', { class: 'r num', style: v === b && P.length > 1 ? { color: 'var(--accent)', fontWeight: 800 } : {} }, show(v))));
  };
  root.append(h('div', { class: 'card' }, h('h3', {}, 'Statistik'), h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
    h('thead', {}, h('tr', {}, h('th', {}, ''), P.map((p) => h('th', { class: 'r' }, p.name)))),
    h('tbody', {},
      row('3-Dart-Average', (p) => p.average, fmt.avg),
      row('First-9-Average', (p) => p.first9, fmt.avg),
      row('Höchste Aufnahme', (p) => p.highest || null),
      row('180', (p) => p.c180),
      row('140+', (p) => p.c140),
      row('100+', (p) => p.c100),
      row('60+', (p) => p.c60),
      row('Checkout-Quote', (p) => p.coRate, fmt.pct),
      row('Checkout-Darts (Treffer/Versuche)', (p) => `${p.coHits} / ${p.coAttempts}`),
      row('Höchstes Checkout', (p) => p.highestCo || null),
      row('Geworfene Darts', (p) => p.darts),
      row('Darts pro gewonnenem Leg', (p) => p.dartsPerLeg, (v) => (v == null ? '–' : v.toFixed(1).replace('.', ',')), false),
      row('Bestes Leg (Darts)', (p) => p.bestLeg, undefined, false),
      row('Gewonnene Legs', (p) => p.legsWon),
      s.setsToWin > 1 ? row('Gewonnene Sets', (p) => p.setsWon) : null,
      row('Vergebene Legdarts', (p) => p.missedLegDarts, undefined, false),
      row('Vergebene Matchdarts', (p) => p.missedMatchDarts, undefined, false),
      row('Busts', (p) => p.busts, undefined, false),
      row('Kamera-erkannte Darts', (p) => p.cameraDarts),
      row('Manuell korrigiert', (p) => p.corrected, undefined, false))))));

  // Grafik: Aufnahmen-Verteilung
  const maxBucket = Math.max(1, ...P.flatMap((p) => [p.c60, p.c100, p.c140, p.c180]));
  root.append(h('div', { class: 'card' }, h('h3', {}, 'Verteilung hoher Aufnahmen'),
    h('div', { class: 'grid', style: { gridTemplateColumns: `repeat(${P.length}, minmax(0,1fr))` } }, P.map((p) => h('div', {},
      h('div', { style: { fontWeight: 700, marginBottom: '6px' } }, p.name),
      [['60+', p.c60], ['100+', p.c100], ['140+', p.c140], ['180', p.c180]].map(([l, v]) => h('div', { class: 'row', style: { gap: '8px', marginBottom: '4px', flexWrap: 'nowrap' } },
        h('span', { class: 'small muted', style: { width: '38px' } }, l),
        h('div', { class: 'qbar', style: { flex: 1 } }, h('i', { style: { width: `${(v / maxBucket) * 100}%` } })),
        h('span', { class: 'small num', style: { width: '22px', textAlign: 'right' } }, v))))))));

  // Legs
  const legsCard = h('div', { class: 'card' }, h('h3', {}, 'Legs und Aufnahmen'));
  st.legs.forEach((leg) => {
    if (!leg.visits.length) return;
    legsCard.append(h('details', { style: { borderTop: '1px solid var(--border)', padding: '8px 0' } },
      h('summary', { style: { cursor: 'pointer', fontWeight: 650 } },
        `${s.setsToWin > 1 ? `Set ${leg.set} · ` : ''}Leg ${leg.leg}`,
        leg.winner != null ? ` – gewonnen von ${m.players[leg.winner].name}` : ' – nicht beendet'),
      h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Spieler'), h('th', {}, 'Darts'), h('th', { class: 'r' }, 'Punkte'), h('th', { class: 'r' }, 'Rest'))),
        h('tbody', {}, leg.visits.map((v) => h('tr', {},
          h('td', {}, m.players[v.p].name),
          h('td', {}, v.darts.map((d) => `${d.label}${d.corrected ? '*' : ''}${d.source === 'camera' ? '' : ''}`).join('  ')),
          h('td', { class: 'r num' }, v.bust ? 'Bust' : v.scored),
          h('td', { class: 'r num' }, v.remAfter))))))));
  });
  root.append(legsCard);

  if (m.corrections?.length) {
    root.append(h('div', { class: 'card' }, h('h3', {}, 'Korrekturprotokoll'),
      h('div', { class: 'list' }, m.corrections.map((c) => h('div', { class: 'list-item small' },
        h('span', { class: 'muted' }, new Date(c.at).toLocaleTimeString('de-DE')),
        h('span', { class: 'grow' }, c.action === 'replace' ? `Leg ${c.leg + 1}, Aufnahme ${c.visit + 1}, Dart ${c.dart + 1}: ${c.from} → ${c.to}` : `Leg ${c.leg + 1}, Aufnahme ${c.visit + 1}: ${c.from} gelöscht`))))));
  }

  async function rematch() {
    const n = createMatch({ settings: { ...s, startPlayer: (s.startPlayer + 1) % m.players.length }, players: m.players.map((p) => (p.isBot ? { ...p, id: 'bot-' + uid() } : p)) });
    n.inputMode = m.inputMode || 'manual';
    await M.save(n);
    location.hash = `#/game/${n.id}`;
  }

  async function remove() {
    if (!(await confirmDialog('Dieses Match endgültig löschen? Es fließt dann auch nicht mehr in Statistiken ein.', { okLabel: 'Löschen', danger: true }))) return;
    await M.remove(m.id);
    toast('Match gelöscht');
    location.hash = '#/history';
  }
}
