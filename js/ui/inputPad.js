// Tastenfeld zur manuellen Eingabe einzelner Darts
import { h, toast } from './dom.js';
import { makeDart } from '../core/board.js';

const ORDER = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];

export function inputPad(onDart, { numeric = true } = {}) {
  let mult = 1;
  const modBtns = [1, 2, 3].map((m) => h('button', {
    type: 'button', dataset: { m: String(m) }, class: m === 1 ? 'on' : '',
    onclick: () => setMult(mult === m && m !== 1 ? 1 : m),
  }, m === 1 ? 'Single' : m === 2 ? 'Double' : 'Triple'));
  const setMult = (m) => { mult = m; modBtns.forEach((b) => b.classList.toggle('on', Number(b.dataset.m) === m)); };
  const fire = (seg) => {
    if (seg === 25 && mult === 3) { toast('Triple-Bull gibt es nicht', 'err'); return; }
    const d = seg === 0 ? makeDart(0) : makeDart(seg, seg === 25 ? Math.min(mult, 2) : mult);
    setMult(1);
    onDart(d);
  };
  const nums = (numeric ? Array.from({ length: 20 }, (_, i) => i + 1) : ORDER).map((n) => h('button', { type: 'button', onclick: () => fire(n) }, n));
  const el = h('div', { class: 'pad' },
    h('div', { class: 'mods' }, modBtns),
    h('div', { class: 'nums' }, nums,
      h('button', { type: 'button', onclick: () => fire(25) }, '25'),
      h('button', { type: 'button', class: 'special', onclick: () => { setMult(2); fire(25); } }, 'Bull'),
      h('button', { type: 'button', class: 'special miss', onclick: () => fire(0) }, 'Miss')));
  // Tastaturkürzel: d/t + Zahl über Eingabe ist umständlich – nur S/D/T-Umschalter per Taste
  el.setMult = setMult;
  return el;
}
