import { h, icon, segControl, toast, confirmDialog, download, fmt } from '../dom.js';
import { settings, calibration } from '../../state.js';
import { db } from '../../data/db.js';
import { speechAvailable, say, sfx } from '../../audio/sound.js';

export async function render(root) {
  root.append(h('div', { class: 'page-head' }, h('h1', {}, 'Einstellungen')));

  const toggle = (key, title, desc, after) => {
    const box = h('input', { type: 'checkbox', checked: !!settings.get(key), onchange: async () => { await settings.set(key, box.checked); after?.(box.checked); } });
    return h('label', { class: 'switch-row' }, h('div', {}, h('div', { class: 't' }, title), desc ? h('div', { class: 'd' }, desc) : null), box);
  };

  // Darstellung
  root.append(h('div', { class: 'card' }, h('h3', {}, 'Design'),
    h('div', { class: 'stack' },
      h('label', { class: 'field' }, 'Hintergrund', segControl([{ value: 'dark', label: 'Anthrazit' }, { value: 'black', label: 'Schwarz (OLED)' }], settings.get('theme'), (v) => settings.set('theme', v))),
      h('label', { class: 'field' }, 'Akzentfarbe', segControl([{ value: 'green', label: 'Grün' }, { value: 'blue', label: 'Blau' }, { value: 'orange', label: 'Orange' }], settings.get('accent'), (v) => settings.set('accent', v))))));

  // Sound
  const vol = h('input', { type: 'range', min: 0, max: 100, value: settings.get('volume'), onchange: () => { settings.set('volume', Number(vol.value)); sfx('hit'); } });
  const ev = settings.get('soundEvents') || {};
  const EVENTS = [['hit', 'Treffer'], ['oneEighty', '180'], ['highFinish', 'High Finish'], ['checkout', 'Checkout'], ['leg', 'Leg gewonnen'], ['set', 'Set gewonnen'], ['match', 'Match gewonnen'], ['bust', 'Bust']];
  root.append(h('div', { class: 'card' }, h('h3', {}, 'Sound und Sprachausgabe'),
    toggle('sounds', 'Soundeffekte', 'Kurze Töne bei Treffern und Ereignissen'),
    h('div', { class: 'switch-row' }, h('div', { class: 't' }, 'Lautstärke'), h('div', { style: { width: '50%' } }, vol)),
    h('details', { style: { padding: '8px 0' } }, h('summary', { class: 'small', style: { cursor: 'pointer' } }, 'Einzelne Soundeffekte'),
      EVENTS.map(([k, l]) => {
        const b = h('input', { type: 'checkbox', checked: ev[k] !== false, onchange: () => { const cur = { ...(settings.get('soundEvents') || {}) }; cur[k] = b.checked; settings.set('soundEvents', cur); } });
        return h('label', { class: 'switch-row' }, h('span', {}, l), h('div', { class: 'row' }, h('button', { class: 'btn sm ghost', type: 'button', onclick: (e) => { e.preventDefault(); sfx(k); } }, 'Test'), b));
      })),
    speechAvailable()
      ? [toggle('speech', 'Sprachausgabe', 'Ansagen wie „180!“, Restpunkte und Checkout-Empfehlung (nutzt die Stimmen deines Geräts)'),
        toggle('announceScores', 'Aufnahme-Punkte ansagen', null),
        h('button', { class: 'btn sm', onclick: () => { if (!settings.get('speech')) toast('Sprachausgabe ist ausgeschaltet'); say('Noch 121 Punkte. Empfehlung: Triple 20, Triple 11, Bull.'); } }, 'Ansage testen')]
      : h('div', { class: 'notice' }, 'Dieser Browser bietet keine Sprachausgabe.')));

  // Spracheingabe
  root.append(h('div', { class: 'card soon' }, h('div', { class: 'row between' }, h('h3', { style: { margin: 0 } }, 'Sprachsteuerung'), h('span', { class: 'soon-tag' }, 'noch nicht verfügbar')),
    h('p', { class: 'small muted', style: { marginBottom: 0 } }, 'Sprachbefehle („Aufnahme rückgängig“, „Spiel pausieren“ …) sind noch nicht umgesetzt. Browser-Spracherkennung läuft oft über Online-Dienste des Herstellers; eine rein lokale Lösung ist geplant.')));

  // Spiel
  const conf = h('input', { type: 'range', min: 30, max: 95, step: 5, value: Math.round(settings.get('confThreshold') * 100) });
  const confLbl = h('b', { class: 'num' }, `${conf.value} %`);
  conf.oninput = () => { confLbl.textContent = `${conf.value} %`; };
  conf.onchange = () => settings.set('confThreshold', Number(conf.value) / 100);
  const delay = h('input', { type: 'range', min: 300, max: 2000, step: 50, value: settings.get('botDelay') });
  const delayLbl = h('b', { class: 'num' }, `${(delay.value / 1000).toFixed(2)} s`);
  delay.oninput = () => { delayLbl.textContent = `${(delay.value / 1000).toFixed(2)} s`; };
  delay.onchange = () => settings.set('botDelay', Number(delay.value));
  root.append(h('div', { class: 'card' }, h('h3', {}, 'Spiel und Erkennung'),
    toggle('keepAwake', 'Display eingeschaltet lassen', 'Während eines Matches geht der Bildschirm nicht aus (wenn vom Browser unterstützt)'),
    h('div', { class: 'switch-row' }, h('div', {}, h('div', { class: 't' }, 'Sicherheitsschwelle der Erkennung ', confLbl), h('div', { class: 'd' }, 'Darunter muss ein erkannter Pfeil bestätigt werden, bevor er zählt.')), h('div', { style: { width: '40%' } }, conf)),
    h('div', { class: 'switch-row' }, h('div', {}, h('div', { class: 't' }, 'Bot-Wurftempo ', delayLbl)), h('div', { style: { width: '40%' } }, delay)),
    h('div', { class: 'switch-row' }, h('div', {}, h('div', { class: 't' }, 'Kamerakalibrierung'), h('div', { class: 'd' }, calibration.current ? `Gespeichert am ${fmt.dateTime(calibration.current.createdAt)}` : 'Nicht kalibriert')),
      h('div', { class: 'row' }, h('a', { class: 'btn sm', href: '#/camera' }, 'Öffnen'),
        calibration.current ? h('button', { class: 'btn sm danger', onclick: async () => { await calibration.clear(); toast('Kalibrierung gelöscht'); location.reload(); } }, 'Löschen') : null))));

  // Datenschutz & Daten
  const samples = (await db.all('samples')).length;
  const fileIn = h('input', { type: 'file', accept: 'application/json,.json', class: 'hidden', onchange: async () => {
    const f = fileIn.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const replace = await confirmDialog('Vorhandene Daten vor dem Import löschen? (Abbrechen = zusammenführen)', { okLabel: 'Ersetzen', danger: true, title: 'Import' });
      await db.importAll(data, { replace });
      toast('Import abgeschlossen', 'ok');
      setTimeout(() => location.reload(), 600);
    } catch (e) { toast(`Import fehlgeschlagen: ${e.message}`, 'err'); }
  } });
  root.append(h('div', { class: 'card' }, h('h3', {}, 'Datenschutz und Daten'),
    h('p', { class: 'small muted' }, 'Autodarts180 speichert alles lokal in diesem Browser (IndexedDB). Es gibt kein Benutzerkonto und keine Übertragung an Server. Kamerabilder werden nur im Arbeitsspeicher ausgewertet.'),
    toggle('collectSamples', 'Trainingsdaten bei Korrekturen sammeln', 'Bei korrigierten Kamera-Erkennungen wird lokal ein Kamerabild mit erkanntem und korrektem Feld gespeichert, um die Erkennung später zu verbessern. Standardmäßig aus.'),
    h('div', { class: 'row', style: { marginTop: '10px' } },
      h('button', { class: 'btn', onclick: async () => download(`autodarts180-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(await db.exportAll())) }, icon('download'), 'Datensicherung exportieren'),
      h('button', { class: 'btn', onclick: () => fileIn.click() }, icon('upload'), 'Sicherung importieren'), fileIn,
      h('button', { class: 'btn', disabled: !samples, onclick: async () => download(`autodarts180-trainingsdaten-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(await db.all('samples'))) }, icon('download'), `Trainingsdaten (${samples})`),
      samples ? h('button', { class: 'btn danger', onclick: async () => { if (await confirmDialog(`${samples} gespeicherte Trainingsbilder löschen?`, { okLabel: 'Löschen', danger: true })) { await db.clear('samples'); location.reload(); } } }, 'Trainingsdaten löschen') : null),
    h('div', { class: 'row', style: { marginTop: '10px' } },
      h('button', { class: 'btn danger', onclick: async () => {
        if (!(await confirmDialog('Alle Spieler, Matches, Einstellungen und die Kalibrierung endgültig löschen? Das kann nicht rückgängig gemacht werden.', { okLabel: 'Alles löschen', danger: true }))) return;
        await db.wipe();
        try { localStorage.clear(); } catch { /* ignore */ }
        location.hash = '#/dashboard';
        location.reload();
      } }, icon('trash'), 'Alle Daten löschen'))));

  root.append(h('div', { class: 'card' }, h('h3', {}, 'Über'),
    h('p', { class: 'small muted', style: { margin: 0 } }, 'Autodarts180 · Version 0.1 · Läuft offline als installierbare Web-App. ',
      h('a', { href: 'tests/index.html', target: '_blank' }, 'Regeltests ausführen'))));
}
