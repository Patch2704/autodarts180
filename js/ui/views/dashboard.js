import { h, icon, fmt, statTile, avatar, LOGO_SVG } from '../dom.js';
import { players as P, matches as M } from '../../data/repo.js';
import { careerStats, matchStats } from '../../core/stats.js';
import { settings, calibration } from '../../state.js';

export async function render(root) {
  const [plist, mlist] = await Promise.all([P.list(), M.list()]);
  const running = mlist.filter((m) => m.status === 'running');
  const finished = mlist.filter((m) => m.status === 'finished');
  const main = plist.find((p) => p.id === settings.get('mainPlayer')) || plist[0] || null;

  root.append(h('div', { class: 'card hero' },
    h('div', {},
      h('div', { class: 'row', html: `<span style="width:44px;height:44px;display:inline-flex">${LOGO_SVG}</span><span class="big-logo">Autodarts<b>180</b></span>` }),
      h('div', { class: 'muted small', style: { marginTop: '6px' } }, 'Scoring, Checkout-Assistent, Bot und Statistiken – lokal auf deinem Gerät.')),
    h('a', { class: 'btn primary big', href: '#/setup' }, icon('play'), 'Neues Spiel')));

  if (running.length) {
    const m = running[0];
    root.append(h('div', { class: 'notice warn', style: { marginTop: '12px' } },
      h('div', { class: 'row between' },
        h('div', {}, h('b', {}, 'Unterbrochenes Match'), h('div', { class: 'small' }, `${m.players.map((p) => p.name).join(' vs. ')} · ${m.settings.startScore} · gestartet ${fmt.dateTime(m.createdAt)}`)),
        h('a', { class: 'btn primary', href: `#/game/${m.id}` }, 'Fortsetzen'))));
  }

  root.append(h('div', { class: 'quick', style: { marginTop: '12px' } },
    h('a', { href: '#/setup', class: 'primary' }, icon('play'), 'Neues Spiel'),
    h('a', { href: '#/camera' }, icon('camera'), calibration.current ? 'Kamera' : 'Kamera kalibrieren'),
    h('a', { href: '#/training' }, icon('target'), h('span', {}, 'Training ', h('span', { class: 'soon-tag' }, 'bald')))));

  if (!plist.length) {
    root.append(h('div', { class: 'card', style: { marginTop: '12px' } },
      h('h2', {}, 'Willkommen!'),
      h('p', { class: 'muted' }, 'Lege zuerst ein Spielerprofil an. Danach kannst du gegen Freunde oder den Bot spielen.'),
      h('a', { class: 'btn primary', href: '#/players' }, icon('plus'), 'Spieler anlegen')));
    return;
  }

  const c = careerStats(main.id, finished);
  root.append(h('div', { class: 'card', style: { marginTop: '12px' } },
    h('div', { class: 'row between', style: { marginBottom: '12px' } },
      h('div', { class: 'row' }, avatar(main), h('div', {}, h('div', { style: { fontWeight: 750 } }, main.name), h('div', { class: 'small muted' }, 'Persönliche Übersicht'))),
      h('a', { class: 'btn sm', href: `#/stats/${main.id}` }, 'Details')),
    h('div', { class: 'grid grid-4' },
      statTile('3-Dart-Average', fmt.avg(c.average), true),
      statTile('Matches', c.matches),
      statTile('Siege / Niederlagen', `${c.wins} / ${c.losses}`),
      statTile('First 9', fmt.avg(c.first9))),
    h('h3', { style: { marginTop: '16px' } }, 'Bestleistungen'),
    h('div', { class: 'grid grid-4' },
      statTile('Höchste Aufnahme', c.highest || '–'),
      statTile('Höchstes Checkout', c.highestCo || '–'),
      statTile('Bester Average', fmt.avg(c.bestAverage)),
      statTile('180er', c.c180))));

  const last = finished[0];
  if (last) {
    const ms = matchStats(last);
    root.append(h('a', { class: 'card', href: `#/match/${last.id}`, style: { display: 'block', textDecoration: 'none', color: 'inherit', marginTop: '12px' } },
      h('h3', {}, 'Letztes Match'),
      h('div', { class: 'row between' },
        h('div', {},
          h('div', { style: { fontWeight: 750, fontSize: '17px' } }, ms.players.map((p) => `${p.name} ${p.setsWon > 0 && last.settings.setsToWin > 1 ? p.setsWon : p.legsWon}`).join(' : ')),
          h('div', { class: 'small muted' }, `${last.settings.startScore} · ${fmt.dateTime(last.createdAt)} · Sieger: ${last.players[last.winner]?.name}`)),
        h('div', { class: 'small muted', style: { textAlign: 'right' } }, ms.players.map((p) => h('div', {}, `${p.name}: Ø ${fmt.avg(p.average)}`))))));
  }

  root.append(h('div', { class: 'card soon', style: { marginTop: '12px' } },
    h('div', { class: 'row between' }, h('h3', { style: { margin: 0 } }, 'Trainingsziele'), h('span', { class: 'soon-tag' }, 'noch nicht verfügbar')),
    h('p', { class: 'small muted', style: { marginBottom: 0 } }, 'Wochen- und Monatsziele folgen zusammen mit dem Trainingsbereich.')));
}
