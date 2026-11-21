import { h, icon, fmt, statTile, avatar, modal, confirmDialog, toast } from '../dom.js';
import { players as P, matches as M, resizeImage } from '../../data/repo.js';
import { careerStats } from '../../core/stats.js';
import { lineChart } from '../boardSvg.js';
import { settings } from '../../state.js';

export async function render(root, params) {
  if (params[0]) return renderProfile(root, params[0]);
  const [plist, finished] = await Promise.all([P.list(), M.finished()]);
  root.append(h('div', { class: 'page-head' },
    h('h1', {}, 'Spieler'),
    h('button', { class: 'btn primary', onclick: () => editPlayer(null, () => rerender(root)) }, icon('plus'), 'Neuer Spieler')));

  if (!plist.length) {
    root.append(h('div', { class: 'card' }, h('p', { class: 'muted', style: { margin: 0 } }, 'Noch keine Spieler angelegt.')));
    return;
  }
  const mainId = settings.get('mainPlayer') || plist[0].id;
  root.append(h('div', { class: 'card' }, h('div', { class: 'list' }, plist.map((p) => {
    const c = careerStats(p.id, finished);
    return h('a', { class: 'list-item', href: `#/player/${p.id}` },
      avatar(p),
      h('div', { class: 'grow' },
        h('div', { class: 'title' }, p.name, p.id === mainId ? h('span', { class: 'badge green', style: { marginLeft: '8px' } }, 'Hauptspieler') : null),
        h('div', { class: 'sub' }, `${c.matches} Matches · Ø ${fmt.avg(c.average)} · ${c.wins} Siege`)),
      icon('edit'));
  }))));
}

function rerender(root) {
  root.innerHTML = '';
  render(root, []);
}

export function editPlayer(player, onSaved) {
  let avatarData = player?.avatar || null;
  const name = h('input', { type: 'text', value: player?.name || '', placeholder: 'Spielername', maxLength: 30 });
  const prev = h('div', {});
  const drawPrev = () => { prev.innerHTML = ''; prev.append(avatar({ name: name.value || '?', avatar: avatarData }, 'lg')); };
  drawPrev();
  name.addEventListener('input', drawPrev);
  const file = h('input', { type: 'file', accept: 'image/*', class: 'hidden', onchange: async () => {
    if (!file.files[0]) return;
    try { avatarData = await resizeImage(file.files[0]); drawPrev(); } catch { toast('Bild konnte nicht geladen werden', 'err'); }
  } });
  modal({
    title: player ? 'Spieler bearbeiten' : 'Neuer Spieler',
    body: h('div', { class: 'stack' },
      h('div', { class: 'row' }, prev,
        h('button', { class: 'btn sm', type: 'button', onclick: () => file.click() }, 'Profilbild wählen'),
        h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { avatarData = null; drawPrev(); } }, 'Entfernen'), file),
      h('label', { class: 'field' }, 'Name', name)),
    actions: [
      { label: 'Abbrechen' },
      { label: 'Speichern', kind: 'primary', onClick: async () => {
        const n = name.value.trim();
        if (!n) { toast('Bitte einen Namen eingeben', 'err'); return false; }
        let saved;
        if (player) { saved = { ...player, name: n, avatar: avatarData }; await P.save(saved); }
        else {
          saved = await P.create({ name: n, avatar: avatarData });
          if (!settings.get('mainPlayer')) await settings.set('mainPlayer', saved.id);
        }
        toast('Gespeichert', 'ok');
        onSaved?.(saved);
      } },
    ],
  });
  setTimeout(() => name.focus(), 50);
}

async function renderProfile(root, id) {
  const [p, finished] = await Promise.all([P.get(id), M.finished()]);
  if (!p) { root.append(h('div', { class: 'notice err' }, 'Spieler nicht gefunden.')); return; }
  const c = careerStats(p.id, finished);
  const isMain = settings.get('mainPlayer') === p.id;
  root.append(h('div', { class: 'page-head' },
    h('div', { class: 'row' }, avatar(p, 'lg'), h('div', {}, h('h1', {}, p.name), h('div', { class: 'muted small' }, `Profil seit ${fmt.date(p.createdAt)}`))),
    h('div', { class: 'row' },
      isMain ? h('span', { class: 'badge green' }, 'Hauptspieler') : h('button', { class: 'btn sm', onclick: async () => { await settings.set('mainPlayer', p.id); toast('Als Hauptspieler festgelegt', 'ok'); root.innerHTML = ''; renderProfile(root, id); } }, 'Als Hauptspieler'),
      h('button', { class: 'btn sm', onclick: () => editPlayer(p, () => { root.innerHTML = ''; renderProfile(root, id); }) }, icon('edit'), 'Bearbeiten'),
      h('button', { class: 'btn sm danger', onclick: async () => {
        if (!(await confirmDialog(`Spieler „${p.name}“ löschen? Gespeicherte Matches bleiben in der Historie erhalten.`, { okLabel: 'Löschen', danger: true }))) return;
        await P.remove(p.id);
        if (isMain) await settings.set('mainPlayer', null);
        location.hash = '#/players';
      } }, icon('trash'), 'Löschen'))));

  root.append(h('div', { class: 'card' },
    h('div', { class: 'grid grid-4' },
      statTile('3-Dart-Average', fmt.avg(c.average), true),
      statTile('First 9', fmt.avg(c.first9)),
      statTile('Matches', c.matches),
      statTile('Siege / Niederlagen', `${c.wins} / ${c.losses}`),
      statTile('Checkout-Quote', fmt.pct(c.coRate)),
      statTile('Höchste Aufnahme', c.highest || '–'),
      statTile('Höchstes Checkout', c.highestCo || '–'),
      statTile('Bestes Leg', c.bestLeg ? `${c.bestLeg} Darts` : '–'),
      statTile('Bester Average', fmt.avg(c.bestAverage)),
      statTile('180er', c.c180),
      statTile('140+', c.c140),
      statTile('100+', c.c100))));

  if (c.history.length > 1) {
    root.append(h('div', { class: 'card' }, h('h3', {}, 'Average-Entwicklung'), lineChart(c.history.map((x) => x.average))));
  }
  root.append(h('div', { class: 'row', style: { marginTop: '12px' } },
    h('a', { class: 'btn', href: `#/stats/${p.id}` }, icon('chart'), 'Statistiken & Heatmap'),
    h('a', { class: 'btn', href: `#/history/${p.id}` }, icon('history'), 'Match-Historie')));
}
