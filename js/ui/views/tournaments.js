import { h, icon } from '../dom.js';

export async function render(root) {
  root.append(h('div', { class: 'page-head' }, h('h1', {}, 'Turniere & Online'), h('span', { class: 'soon-tag' }, 'noch nicht verfügbar')));
  root.append(h('div', { class: 'notice warn' }, 'Turniere, Ligen und Online-Funktionen sind noch nicht umgesetzt. Hier steht, was geplant ist.'));
  const block = (ic, title, items) => h('div', { class: 'card soon', style: { marginTop: '12px' } },
    h('div', { class: 'row' }, icon(ic), h('h2', { style: { margin: 0 } }, title)),
    h('ul', { class: 'small muted' }, items.map((i) => h('li', {}, i))));
  root.append(
    block('trophy', 'Turniermodus', ['Turnier anlegen mit Name, Spielmodus, Startpunkten, Sets/Legs', 'Gruppenphase und K.-o.-System bis zum Finale', 'Automatischer Spielplan und Ergebniseintragung aus gespielten Matches']),
    block('chart', 'Ligamodus', ['Spielergruppen, Spieltage und Saisonhistorie', 'Tabelle mit Punkten, Siegen, Niederlagen, Leg-Differenz und Average', 'Automatische Aktualisierung nach jedem Match']),
    block('globe', 'Online-Multiplayer', ['Benutzerkonten (optional – lokale Spiele bleiben ohne Konto möglich)', 'Freundesliste, private Spielräume, Einladung per Code', 'Ranglisten und monatliche Wettbewerbe', 'Kamera-Erkennung bleibt lokal; übertragen werden nur Spielereignisse, verschlüsselt und mit Wiederaufnahme nach Verbindungsabbruch']));
}
