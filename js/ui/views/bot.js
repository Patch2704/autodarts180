import { h, icon, toast, fmt } from '../dom.js';
import { BOT_AVERAGES, PERSONALITIES, calibrateSigma, simulateAverage } from '../../core/bot.js';
import { settings } from '../../state.js';

export async function render(root) {
  const def = settings.get('defaultBot') || { avg: 60, personality: 'constant' };
  let avg = def.avg, pers = def.personality;

  root.append(h('div', { class: 'page-head' }, h('h1', {}, 'KI-Dart-Bot')));

  const avgLabel = h('div', { class: 'num', style: { fontSize: '44px', fontWeight: 900, color: 'var(--accent)' } }, avg);
  const slider = h('input', { type: 'range', min: 0, max: BOT_AVERAGES.length - 1, value: BOT_AVERAGES.indexOf(avg), oninput: () => { avg = BOT_AVERAGES[slider.value]; avgLabel.textContent = avg; persist(); } });
  const persList = h('div', { class: 'grid grid-2 stack-sm' });
  const drawPers = () => {
    persList.innerHTML = '';
    for (const [k, p] of Object.entries(PERSONALITIES)) {
      persList.append(h('button', {
        type: 'button', class: 'card', style: { textAlign: 'left', cursor: 'pointer', borderColor: k === pers ? 'var(--accent)' : '', background: k === pers ? 'var(--accent-soft)' : '' },
        onclick: () => { pers = k; drawPers(); persist(); },
      }, h('div', { style: { fontWeight: 750 } }, p.label), h('div', { class: 'small muted' }, p.desc)));
    }
  };
  drawPers();
  const persist = () => settings.set('defaultBot', { avg, personality: pers });

  root.append(h('div', { class: 'card' },
    h('h3', {}, 'Ziel-Average (Standard für neue Spiele)'),
    h('div', { class: 'row between' }, avgLabel, h('div', { class: 'small muted', style: { maxWidth: '360px' } }, 'In 5er-Schritten von 30 bis 120. Der Bot erreicht diesen Wert langfristig im Mittel.')),
    slider,
    h('div', { class: 'row between small muted' }, h('span', {}, '30'), h('span', {}, '120'))));

  root.append(h('div', { class: 'card' }, h('h3', {}, 'Persönlichkeit'), persList));

  const out = h('div', { class: 'small' });
  root.append(h('div', { class: 'card' },
    h('h3', {}, 'So funktioniert der Bot'),
    h('p', { class: 'small muted' },
      'Jeder Wurf wird wie ein echter Pfeil simuliert: Der Bot zielt auf ein Feld (Triple 20 beim Scoring, den empfohlenen Checkout-Weg im Finish) und trifft mit einer zufälligen Streuung um den Zielpunkt. ',
      'Die Streuung wird vorab per Simulation so bestimmt, dass der langfristige Average dem eingestellten Wert entspricht. Die Persönlichkeit verschiebt nur, wie sich Scoring- und Doppel-Genauigkeit sowie die Schwankung zwischen Aufnahmen verteilen. ',
      'Der Bot passt seine Leistung während eines Matches nie an den Spielstand an. Die Option „adaptiv“ (beim Spielstart) wählt nur den Ziel-Average passend zu deinen letzten Matches.'),
    h('p', { class: 'small muted' }, 'Hinweis: Kalibriert wird für 501 Double-Out. In anderen Modi kann der Average leicht abweichen.'),
    h('button', { class: 'btn', onclick: () => {
      out.textContent = 'Simuliere 400 Legs …';
      setTimeout(() => {
        const sigma = calibrateSigma(avg, pers);
        const real = simulateAverage(sigma, PERSONALITIES[pers], 400, (Date.now() & 0xffff) + 1);
        out.innerHTML = '';
        out.append(h('div', { class: 'notice ok' }, `Ziel ${avg} (${PERSONALITIES[pers].label}): simulierter Average über 400 Legs = `, h('b', {}, fmt.avg(real)), ` · Streuung σ = ${sigma.toFixed(1).replace('.', ',')} mm`));
      }, 30);
    } }, icon('refresh'), 'Kalibrierung prüfen (Simulation)'),
    out));

  root.append(h('div', { style: { marginTop: '12px' } },
    h('button', { class: 'btn primary big block', onclick: async () => {
      const last = settings.get('lastSetup') || {};
      const main = settings.get('mainPlayer');
      const parts = main ? [{ id: main }] : [];
      parts.push({ isBot: true, name: `Bot ${avg}`, bot: { avg, personality: pers, adaptive: false } });
      await settings.set('lastSetup', { ...last, participants: parts });
      if (!main) toast('Füge im nächsten Schritt noch dich als Spieler hinzu');
      location.hash = '#/setup';
    } }, icon('play'), 'Gegen diesen Bot spielen')));
}
