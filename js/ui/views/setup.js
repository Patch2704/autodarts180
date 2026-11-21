import { h, icon, avatar, segControl, toast, clear } from '../dom.js';
import { players as P, matches as M } from '../../data/repo.js';
import { createMatch } from '../../core/x01.js';
import { careerStats } from '../../core/stats.js';
import { BOT_AVERAGES, PERSONALITIES } from '../../core/bot.js';
import { settings, calibration } from '../../state.js';
import { uid } from '../../core/rng.js';

const MODES = [
  { value: 'x01', label: 'X01' },
  ...['Cricket', 'Tactics', 'Around the Clock', 'Shanghai', "Bob's 27", 'Highscore', 'Killer'].map((l) => ({ value: l, label: l, disabled: true, title: 'Noch nicht verfügbar' })),
];

export async function render(root) {
  const [plist, finished] = await Promise.all([P.list(), M.finished()]);
  const last = settings.get('lastSetup') || {};
  const cfg = {
    startScore: last.startScore || 501,
    inMode: last.inMode || 'straight',
    outMode: last.outMode || 'double',
    bullIsDouble: last.bullIsDouble ?? true,
    legsToWin: last.legsToWin || 3,
    setsToWin: last.setsToWin || 1,
    inputMode: last.inputMode === 'camera' && calibration.current ? 'camera' : 'manual',
    start: 'first',
  };
  // Teilnehmer: zuletzt gewählte Spieler, sofern noch vorhanden
  let parts = (last.participants || [])
    .map((p) => (p.isBot ? { ...p, id: 'bot-' + uid() } : plist.find((x) => x.id === p.id)))
    .filter(Boolean);
  if (!parts.length && plist.length) parts = [plist.find((p) => p.id === settings.get('mainPlayer')) || plist[0]];

  root.append(h('div', { class: 'page-head' }, h('h1', {}, 'Neues Spiel')));

  const section = (title, ...content) => h('div', { class: 'card' }, h('h3', {}, title), ...content);

  root.append(section('Spielmodus', segControl(MODES, 'x01', () => {}),
    h('p', { class: 'small muted', style: { marginBottom: 0 } }, 'Cricket, Tactics, Around the Clock, Shanghai, Bob\'s 27, Highscore und Killer sind noch nicht verfügbar.')));

  const customScore = h('input', { type: 'number', min: 2, max: 9999, value: cfg.startScore, style: { maxWidth: '140px' }, oninput: () => { cfg.startScore = Math.max(2, Math.min(9999, Number(customScore.value) || 501)); } });
  const presets = [301, 501, 701, 901, 1001];
  const scoreCtl = segControl([...presets.map((v) => ({ value: v, label: String(v) })), { value: 'custom', label: 'Individuell' }],
    presets.includes(cfg.startScore) ? cfg.startScore : 'custom',
    (v) => { if (v === 'custom') { customScore.classList.remove('hidden'); customScore.focus(); } else { cfg.startScore = v; customScore.value = v; customScore.classList.add('hidden'); } });
  if (presets.includes(cfg.startScore)) customScore.classList.add('hidden');
  root.append(section('Startpunktzahl', scoreCtl, h('div', { style: { marginTop: '8px' } }, customScore)));

  const bullBox = h('input', { type: 'checkbox', checked: cfg.bullIsDouble, onchange: () => { cfg.bullIsDouble = bullBox.checked; } });
  root.append(section('Regeln',
    h('div', { class: 'stack' },
      h('label', { class: 'field' }, 'Einstieg', segControl([{ value: 'straight', label: 'Straight-In' }, { value: 'double', label: 'Double-In' }], cfg.inMode, (v) => { cfg.inMode = v; })),
      h('label', { class: 'field' }, 'Ausstieg', segControl([{ value: 'double', label: 'Double-Out' }, { value: 'master', label: 'Master-Out' }, { value: 'straight', label: 'Straight-Out' }], cfg.outMode, (v) => { cfg.outMode = v; })),
      h('label', { class: 'row', style: { fontWeight: 600 } }, bullBox, 'Bull (50) zählt als Doppel für Double-In/-Out'))));

  const bestOf = (firstTo) => firstTo * 2 - 1;
  const legsCustom = h('input', { type: 'number', min: 1, max: 50, value: cfg.legsToWin, style: { maxWidth: '120px' }, oninput: () => { cfg.legsToWin = Math.max(1, Number(legsCustom.value) || 1); } });
  const setsCustom = h('input', { type: 'number', min: 1, max: 20, value: cfg.setsToWin, style: { maxWidth: '120px' }, oninput: () => { cfg.setsToWin = Math.max(1, Number(setsCustom.value) || 1); } });
  const boOpts = [1, 3, 5, 7, 9].map((n) => ({ value: Math.ceil(n / 2), label: n === 1 ? '1 Leg' : `Best of ${n}` }));
  const legsVal = boOpts.some((o) => o.value === cfg.legsToWin) ? cfg.legsToWin : 'custom';
  const setOpts = [{ value: 1, label: 'Keine Sets' }, ...[3, 5, 7, 9].map((n) => ({ value: Math.ceil(n / 2), label: `Best of ${n}` }))];
  const setsVal = setOpts.some((o) => o.value === cfg.setsToWin) ? cfg.setsToWin : 'custom';
  if (legsVal !== 'custom') legsCustom.classList.add('hidden');
  if (setsVal !== 'custom') setsCustom.classList.add('hidden');
  root.append(section('Sets und Legs',
    h('div', { class: 'stack' },
      h('label', { class: 'field' }, 'Legs (pro Set)',
        segControl([...boOpts, { value: 'custom', label: 'First to …' }], legsVal, (v) => { if (v === 'custom') legsCustom.classList.remove('hidden'); else { cfg.legsToWin = v; legsCustom.value = v; legsCustom.classList.add('hidden'); } }),
        legsCustom),
      h('label', { class: 'field' }, 'Sets',
        segControl([...setOpts, { value: 'custom', label: 'First to …' }], setsVal, (v) => { if (v === 'custom') setsCustom.classList.remove('hidden'); else { cfg.setsToWin = v; setsCustom.value = v; setsCustom.classList.add('hidden'); } }),
        setsCustom),
      h('div', { class: 'small muted' }, '„Best of 5“ bedeutet: Wer zuerst 3 gewinnt.'))));

  // ---------- Teilnehmer ----------
  const partBox = h('div', { class: 'list' });
  const addBox = h('div', { class: 'row', style: { marginTop: '10px' } });
  const startSel = h('select', { onchange: () => { cfg.start = startSel.value; } });
  const drawParts = () => {
    clear(partBox); clear(addBox); clear(startSel);
    parts.forEach((p, i) => {
      partBox.append(h('div', { class: 'list-item' },
        h('span', { class: 'muted num', style: { width: '18px' } }, i + 1), avatar(p),
        h('div', { class: 'grow' }, h('div', { class: 'title' }, p.name), p.isBot ? h('div', { class: 'sub' }, `${PERSONALITIES[p.bot.personality].label} · Ziel-Average ${p.bot.avg}${p.bot.adaptive ? ' (adaptiv)' : ''}`) : null),
        h('button', { class: 'btn sm ghost', disabled: i === 0, title: 'Nach oben', onclick: () => { [parts[i - 1], parts[i]] = [parts[i], parts[i - 1]]; drawParts(); } }, '↑'),
        h('button', { class: 'btn sm ghost', disabled: i === parts.length - 1, title: 'Nach unten', onclick: () => { [parts[i + 1], parts[i]] = [parts[i], parts[i + 1]]; drawParts(); } }, '↓'),
        h('button', { class: 'btn sm ghost', title: 'Entfernen', onclick: () => { parts.splice(i, 1); drawParts(); } }, icon('x'))));
    });
    if (!parts.length) partBox.append(h('p', { class: 'muted' }, 'Noch keine Teilnehmer ausgewählt.'));
    for (const p of plist) {
      if (parts.some((x) => x.id === p.id)) continue;
      addBox.append(h('button', { class: 'btn sm', disabled: parts.length >= 8, onclick: () => { parts.push(p); drawParts(); } }, icon('plus'), p.name));
    }
    addBox.append(h('a', { class: 'btn sm ghost', href: '#/players' }, icon('users'), 'Spieler verwalten'));
    startSel.append(h('option', { value: 'first' }, 'Erster in der Reihenfolge'), h('option', { value: 'random' }, 'Zufällig'));
    parts.forEach((p, i) => { if (i > 0) startSel.append(h('option', { value: String(i) }, p.name)); });
    startSel.value = [...startSel.options].some((o) => o.value === cfg.start) ? cfg.start : 'first';
    cfg.start = startSel.value;
  };

  // Bot hinzufügen
  const db = settings.get('defaultBot') || { avg: 60, personality: 'constant' };
  let botAvg = db.avg, botPers = db.personality, botAdaptive = false;
  const avgLabel = h('b', { class: 'num' }, botAvg);
  const slider = h('input', { type: 'range', min: 0, max: BOT_AVERAGES.length - 1, step: 1, value: BOT_AVERAGES.indexOf(botAvg), oninput: () => { botAvg = BOT_AVERAGES[slider.value]; avgLabel.textContent = botAvg; } });
  const persSel = h('select', { onchange: () => { botPers = persSel.value; } }, Object.entries(PERSONALITIES).map(([k, v]) => h('option', { value: k, selected: k === botPers }, v.label)));
  const adaptBox = h('input', { type: 'checkbox', onchange: () => { botAdaptive = adaptBox.checked; } });
  const addBot = () => {
    let avg = botAvg, note = '';
    if (botAdaptive) {
      const human = parts.find((p) => !p.isBot);
      if (human) {
        const c = careerStats(human.id, finished);
        const recent = c.history.slice(-5).map((x) => x.average).filter((x) => x != null);
        if (recent.length) {
          const a = recent.reduce((x, y) => x + y, 0) / recent.length;
          avg = Math.max(30, Math.min(120, Math.round(a / 5) * 5));
          note = `angepasst an ${human.name}`;
        } else note = 'noch keine Daten – Reglerwert verwendet';
      }
      toast(`Adaptiver Bot: Average ${avg} (${note || 'kein menschlicher Spieler'})`);
    }
    parts.push({ id: 'bot-' + uid(), name: `Bot ${avg}`, isBot: true, bot: { avg, personality: botPers, adaptive: botAdaptive } });
    drawParts();
  };

  root.append(section('Spieler und Reihenfolge',
    partBox, addBox,
    h('div', { class: 'card', style: { marginTop: '12px', background: 'var(--surface-2)' } },
      h('div', { class: 'row between' }, h('div', { style: { fontWeight: 700 } }, icon('bot'), ' Bot als Gegner'), h('div', {}, 'Average ', avgLabel)),
      slider,
      h('div', { class: 'grid grid-2 stack-sm', style: { marginTop: '8px' } },
        h('label', { class: 'field' }, 'Persönlichkeit', persSel),
        h('label', { class: 'row', style: { fontWeight: 600, alignSelf: 'end', minHeight: '44px' } }, adaptBox, 'Adaptiv (an meine letzten 5 Matches anpassen)')),
      h('button', { class: 'btn', style: { marginTop: '10px' }, onclick: addBot }, icon('plus'), 'Bot hinzufügen')),
    h('label', { class: 'field', style: { marginTop: '12px' } }, 'Startspieler', startSel)));
  drawParts();

  // ---------- Eingabe ----------
  const hasCal = !!calibration.current;
  root.append(section('Eingabe der Würfe',
    segControl([{ value: 'manual', label: 'Manuell (Tastenfeld)' }, { value: 'camera', label: 'Kamera-Erkennung', disabled: !hasCal, title: hasCal ? '' : 'Erst Kamera kalibrieren' }], cfg.inputMode, (v) => { cfg.inputMode = v; }),
    hasCal ? h('p', { class: 'small muted', style: { marginBottom: 0 } }, 'Im Spiel kann jederzeit zwischen Kamera und Tastenfeld gewechselt werden.')
      : h('p', { class: 'small muted', style: { marginBottom: 0 } }, 'Für die automatische Erkennung zuerst ', h('a', { href: '#/camera' }, 'die Kamera kalibrieren'), '.')));

  root.append(h('div', { style: { marginTop: '16px' } }, h('button', { class: 'btn primary big block', onclick: start }, icon('play'), 'Match starten')));

  async function start() {
    if (!parts.length) { toast('Bitte mindestens einen Spieler auswählen', 'err'); return; }
    let startPlayer = 0;
    if (cfg.start === 'random') startPlayer = Math.floor(Math.random() * parts.length);
    else if (cfg.start !== 'first') startPlayer = Number(cfg.start) || 0;
    const s = { startScore: cfg.startScore, inMode: cfg.inMode, outMode: cfg.outMode, bullIsDouble: cfg.bullIsDouble, legsToWin: cfg.legsToWin, setsToWin: cfg.setsToWin, startPlayer };
    const m = createMatch({ settings: s, players: parts });
    m.inputMode = cfg.inputMode;
    await M.save(m);
    await settings.set('lastSetup', { ...s, inputMode: cfg.inputMode, participants: parts.map((p) => (p.isBot ? { isBot: true, name: p.name, bot: p.bot } : { id: p.id })) });
    location.hash = `#/game/${m.id}`;
  }
}
