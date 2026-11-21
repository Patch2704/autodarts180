import { h } from '../dom.js';

const PROGRAMS = [
  ['Triple-20-Training', 'Trefferquote auf T20 über eine feste Anzahl Darts.'],
  ['Triple-19-Training', 'Wie T20, für das Ausweichfeld.'],
  ['Double-Training', 'Alle Doppel der Reihe nach, mit Quote pro Doppel.'],
  ['Bullseye-Training', 'Treffer auf 25 und Bull.'],
  ['20er-Segment-Training', 'Streuung im 20er-Segment.'],
  ['Around the Clock', '1 bis 20 der Reihe nach.'],
  ['Checkout-Training', 'Zufällige Finishes unter Zeitdruck.'],
  ['121-Challenge', 'Finish von 121 in begrenzten Darts.'],
  ['Individuelle Trainingsziele', 'Eigene Ziele mit Fortschrittsverlauf.'],
];

export async function render(root) {
  root.append(h('div', { class: 'page-head' }, h('h1', {}, 'Training'), h('span', { class: 'soon-tag' }, 'noch nicht verfügbar')));
  root.append(h('div', { class: 'notice warn' },
    'Der Trainingsbereich ist noch nicht umgesetzt. Die folgenden Programme sind geplant und erscheinen hier, sobald sie fertig und getestet sind. ',
    'Bis dahin fließen alle Würfe aus Matches in Statistiken und Heatmap ein.'));
  root.append(h('div', { class: 'card', style: { marginTop: '12px' } }, h('div', { class: 'list' },
    PROGRAMS.map(([t, d]) => h('div', { class: 'list-item soon' }, h('div', { class: 'grow' }, h('div', { class: 'title' }, t), h('div', { class: 'sub' }, d)), h('span', { class: 'soon-tag' }, 'geplant'))))));
  root.append(h('div', { class: 'card soon' }, h('h3', {}, 'Autodarts180 Coach'),
    h('p', { class: 'small muted', style: { margin: 0 } }, 'Eine Grundversion des Coaches mit Hinweisen aus deinen Matchdaten findest du unter Statistiken. Trainingspläne, Wochen- und Monatsziele folgen mit dem Trainingsbereich.')));
}
