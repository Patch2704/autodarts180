import { h, fmt, clear, icon } from '../dom.js';
import { players as P, matches as M } from '../../data/repo.js';
import { replay } from '../../core/x01.js';

export async function render(root, params) {
  const [plist, all] = await Promise.all([P.list(), M.list()]);
  let pf = params[0] || '';
  let sf = 'all';
  root.append(h('div', { class: 'page-head' }, h('h1', {}, 'Match-Historie')));
  const pSel = h('select', { onchange: () => { pf = pSel.value; draw(); } },
    h('option', { value: '' }, 'Alle Spieler'), plist.map((p) => h('option', { value: p.id, selected: p.id === pf }, p.name)));
  const sSel = h('select', { onchange: () => { sf = sSel.value; draw(); } },
    h('option', { value: 'all' }, 'Alle'), h('option', { value: 'finished' }, 'Abgeschlossen'), h('option', { value: 'running' }, 'Unterbrochen'),
    ...[301, 501, 701, 901, 1001].map((v) => h('option', { value: String(v) }, `${v}`)));
  const list = h('div', { class: 'list' });
  root.append(h('div', { class: 'card' }, h('div', { class: 'grid grid-2 stack-sm' }, h('label', { class: 'field' }, 'Spieler', pSel), h('label', { class: 'field' }, 'Filter', sSel))),
    h('div', { class: 'card' }, list));

  function draw() {
    clear(list);
    const items = all.filter((m) => (!pf || m.players.some((p) => p.id === pf))
      && (sf === 'all' || m.status === sf || String(m.settings.startScore) === sf));
    if (!items.length) { list.append(h('div', { class: 'muted' }, 'Keine Matches gefunden.')); return; }
    for (const m of items) {
      const st = replay(m);
      const score = m.settings.setsToWin > 1 ? st.setsWon.join(' : ') : st.legsTotal.join(' : ');
      list.append(h('a', { class: 'list-item', href: m.status === 'running' ? `#/game/${m.id}` : `#/match/${m.id}` },
        h('div', { class: 'grow' },
          h('div', { class: 'title' }, m.players.map((p) => p.name).join(' vs. ')),
          h('div', { class: 'sub' }, `${fmt.dateTime(m.createdAt)} · ${m.settings.startScore} · ${m.settings.setsToWin > 1 ? `Sets ${score}` : `Legs ${score}`}`)),
        m.status === 'running' ? h('span', { class: 'badge warn' }, 'Fortsetzen')
          : h('span', { class: 'badge green' }, icon('trophy'), m.players[m.winner]?.name)));
    }
  }
  draw();
}
