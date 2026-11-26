// Live-Spielansicht X01
import { h, icon, clear, toast, modal, confirmDialog, avatar, fmt } from '../dom.js';
import { inputPad } from '../inputPad.js';
import { matches as M } from '../../data/repo.js';
import { db } from '../../data/db.js';
import { replay, addDart, endVisit, undoDart, undoVisit, clearOpenVisit, replaceDart, deleteDart } from '../../core/x01.js';
import { matchStats } from '../../core/stats.js';
import { checkoutInfo } from '../../core/checkout.js';
import { makeDart } from '../../core/board.js';
import { Bot, BOT_SPEEDS } from '../../core/bot.js';
import { settings, calibration } from '../../state.js';
import { sfx, say } from '../../audio/sound.js';
import { camera } from '../../vision/camera.js';
import { DartDetector, cropView, dartCrop } from '../../vision/detector.js';
import { healthCheck, boardCrop, cropH, uncropH, uncropPoint, refine, refineOrAuto, calibrationQuality, frameMetrics, pointsFromH, fitScore, boardShiftMm, edgeRefine } from '../../vision/calibration.js';
import { applyH } from '../../vision/homography.js';
import { zoomRect, placeVideo, sizeCanvas, drawBoard, drawMarker } from '../../vision/overlay.js';
import { uid } from '../../core/rng.js';

const spoken = (label) => {
  if (label === 'Bull') return 'Bull';
  if (label === 'Miss') return 'daneben';
  if (label === '25') return '25';
  const m = /^([SDT])(\d+)$/.exec(label);
  if (!m) return label;
  return (m[1] === 'T' ? 'Triple ' : m[1] === 'D' ? 'Doppel ' : '') + m[2];
};

// Bild der leeren Scheibe aus dem letzten Spiel (nur im Speicher, nur in dieser Sitzung): Wird beim Start schon
// geworfen, bevor die Erkennung bereit ist, lassen sich die steckenden Pfeile damit trotzdem werten
let emptyCache = null;

export async function render(root, params) {
  const match = await M.get(params[0]);
  if (!match) {
    root.append(h('div', { class: 'notice err' }, 'Match nicht gefunden.'), h('a', { class: 'btn', href: '#/setup', style: { marginTop: '12px' } }, 'Neues Spiel'));
    return;
  }

  let paused = false;
  let botTimer = null;
  let pending = []; // unsichere Kamera-Erkennungen
  const clearPending = () => { pending = []; for (const m of detector.dartMem || []) m.open = false; };
  let camWarnings = [];
  let wakeLock = null;
  let lastHealth = 0;
  let destroyed = false;
  const bots = new Map();
  const detector = new DartDetector();
  let detStatus = '';
  let lastImg = null;
  const detLog = [];
  let crop = null, cropHm = null, viewCrop = null, detMaxW = 640;
  const hasHuman = match.players.some((p) => !p.isBot);
  let inputMode = match.inputMode === 'camera' && calibration.current ? 'camera' : 'manual';

  // ---------- Grundgerüst ----------
  const top = h('div', { class: 'game-top' });
  const playersEl = h('div', { class: 'players' });
  const visitEl = h('div', { class: 'visit' });
  const checkoutEl = h('div', {});
  const pendingEl = h('div', {});
  const warnEl = h('div', {});
  const camStage = h('div', { class: 'game-cam' });
  const camCanvas = h('canvas', {});
  const camStatus = h('div', { class: 'cam-status' }, 'Kamera startet …');
  camStage.append(camCanvas, camStatus);
  const pad = inputPad((d) => commit({ ...d, source: 'manual' }));
  const padWrap = h('div', {}, pad);
  const actionsEl = h('div', { class: 'actions' });
  const logEl = h('div', { class: 'card' });
  const left = h('div', { class: 'stack' }, visitEl, checkoutEl, pendingEl, warnEl);
  const right = h('div', { class: 'stack' }, camStage, padWrap, actionsEl);
  const game = h('div', { class: 'game has-side' }, top, playersEl, left, right);
  root.append(game, h('div', { style: { marginTop: '12px' } }, logEl));

  // ---------- Hilfen ----------
  const save = () => M.save(match).catch((e) => toast(`Speichern fehlgeschlagen: ${e.message}`, 'err'));
  const isBot = (i) => match.players[i]?.isBot;
  const getBot = (i) => {
    if (!bots.has(i)) {
      const b = match.players[i].bot || { avg: 60, personality: 'constant' };
      bots.set(i, new Bot({ average: b.avg, personality: b.personality }));
    }
    return bots.get(i);
  };

  function celebrate(text, sub = '', red = false) {
    const el = h('div', { class: `celebrate ${red ? 'red' : ''}` }, h('div', { class: 'burst' }, text, sub ? h('small', {}, sub) : null));
    document.body.append(el);
    setTimeout(() => el.remove(), 1700);
  }

  // ---------- Wurf verbuchen ----------
  // Entnahme-Runde, in der die Pfeile der offenen Aufnahme stecken (detector.round zählt die Entnahmen)
  let visitRound = 0;
  // Herausgezogene Pfeile werden nicht mehr eingezeichnet: hidden = { key: Aufnahme, n: so viele Darts davon }
  let hidden = { key: '', n: 0 };
  const shownVisit = (st) => st.openVisit || st.current.visits[st.current.visits.length - 1];
  const visitKey = (st, v) => `${match.legs.length}/${st.current.visits.indexOf(v)}`;
  function hideMarkers() {
    const st = replay(match), v = shownVisit(st);
    hidden = v ? { key: visitKey(st, v), n: v.darts.length } : { key: '', n: 0 };
  }
  // Eine fertige Aufnahme bleibt in der Anzeige (Darts und aktiver Spieler), bis ihre Pfeile gezogen sind
  // bzw. beim Bot noch eine kurze Pause lang. Erst dann wird auf den nächsten Spieler umgeschaltet.
  let held = null, heldTimer = null;
  const botSpeed = () => BOT_SPEEDS[match.settings.botSpeed] || { ...BOT_SPEEDS.normal, dart: settings.get('botDelay') || BOT_SPEEDS.normal.dart };
  function heldVisit(st) {
    if (!held || st.openVisit || match.status !== 'running') return null;
    const v = st.current.visits[st.current.visits.length - 1];
    return v && visitKey(st, v) === held ? v : null;
  }
  function holdVisit(ms) {
    const st = replay(match);
    const v = !st.openVisit && st.current.visits[st.current.visits.length - 1];
    clearTimeout(heldTimer);
    held = v && match.status === 'running' ? visitKey(st, v) : null;
    if (held && ms) heldTimer = setTimeout(releaseHold, ms);
  }
  function releaseHold() {
    clearTimeout(heldTimer);
    if (!held) return;
    held = null;
    draw(); scheduleBot();
  }
  // Kamera-Treffer, die erst gezählt werden, wenn wieder ein Mensch dran ist (der Bot wirft gerade)
  let deferred = [];
  function flushDeferred() {
    if (!deferred.length) return;
    const st = replay(match);
    if (st.currentPlayer == null || isBot(st.currentPlayer)) return;
    const d = deferred.shift();
    commitCamera(d.dart, d.round);
  }
  /**
   * Kamera-Treffer verbuchen. Stammt die offene Aufnahme aus einer früheren Runde (ihre Pfeile wurden schon gezogen),
   * ist sie vorbei: Sie wird beendet, bevor der neue Pfeil zählt. Ist dann der Bot dran, wartet der Pfeil.
   */
  function commitCamera(dart, round) {
    let st = replay(match);
    if (st.openVisit && !isBot(st.currentPlayer) && st.openVisit.dartCount > 0 && visitRound < round) {
      endVisit(match); save();
      toast(`Aufnahme mit ${st.openVisit.dartCount} Dart${st.openVisit.dartCount > 1 ? 's' : ''} beendet – die Pfeile waren schon gezogen.`, 'err');
      st = replay(match);
    }
    if (st.currentPlayer != null && isBot(st.currentPlayer)) { deferred.push({ dart, round }); draw(); scheduleBot(); return; }
    commit(dart, round);
  }

  function commit(dart, round = detector.round) {
    if (paused || match.status !== 'running') return;
    held = null; clearTimeout(heldTimer);
    const before = replay(match);
    const p = before.currentPlayer;
    let res;
    try { res = addDart(match, dart); } catch (e) { toast(e.message, 'err'); return; }
    save();
    // spät bestätigt: der Pfeil ist schon herausgezogen
    if (inputMode === 'camera' && round < detector.round) hideMarkers();
    feedback(res, dart, p);
    draw();
    visitRound = before.openVisit ? Math.max(visitRound, round) : round;
    // Nur warten, wenn die Pfeile dieser Aufnahme noch nicht herausgezogen wurden (spät bestätigte Treffer)
    if (res.visit?.closed && !isBot(p) && inputMode === 'camera' && detector.round === visitRound) detector.awaitTakeout();
    if (res.visit?.closed) { holdVisit(isBot(p) ? botSpeed().hold : inputMode === 'camera' && detector.awaitingTakeout ? 0 : 1500); draw(); }
    if (match.status === 'finished') { onFinished(); return; }
    scheduleBot();
    announceTurn(res, p);
  }

  function feedback(res, dart, p) {
    const v = res.visit;
    const name = match.players[p].name;
    if (res.matchWon != null) {
      sfx('match'); celebrate('Match', `${name} gewinnt`); say(`Spiel, Satz und Sieg, ${name}`);
      return;
    }
    if (res.legWon != null) {
      if (v.scored >= 100) { sfx('highFinish'); celebrate(String(v.scored), 'High Finish'); }
      else { sfx(res.setWon ? 'set' : 'leg'); celebrate(res.setWon ? 'Set' : 'Leg', name); }
      say(`${res.setWon ? 'Satz' : 'Leg'} gewonnen, ${name}${v.scored >= 100 ? `, mit ${v.scored} Checkout` : ''}`);
      return;
    }
    if (v?.bust) { sfx('bust'); say('Bust'); return; }
    if (v?.closed) {
      if (v.scored === 180) { sfx('oneEighty'); celebrate('180', name); say('Einhundertachtzig!'); return; }
      sfx(dart.score ? 'hit' : 'miss');
      if (settings.get('announceScores')) say(String(v.scored));
      return;
    }
    sfx(dart.score ? 'hit' : 'miss');
  }

  function announceTurn(res, prevPlayer) {
    const st = replay(match);
    const p = st.currentPlayer;
    if (p == null || p === prevPlayer || isBot(p) || st.openVisit) return;
    const rem = st.current.rem[p];
    if (!st.current.isIn[p] || rem > 170) return;
    const info = checkoutInfo(rem, 3, match.settings);
    if (info.possible) setTimeout(() => say(`${match.players[p].name}, noch ${rem}. Empfehlung: ${info.routes[0].darts.map((d) => spoken(d.label)).join(', ')}`), 1200);
  }

  async function onFinished() {
    clearTimeout(botTimer);
    stopCamera();
    await save();
    draw();
    setTimeout(() => { if (!destroyed) location.hash = `#/match/${match.id}`; }, 2600);
  }

  // ---------- Bot ----------
  // Der Bot wirft erst, wenn die Pfeile der eigenen Aufnahme aus der Scheibe gezogen sind
  const botWaits = () => inputMode === 'camera' && detector.awaitingTakeout;
  function scheduleBot() {
    clearTimeout(botTimer);
    if (paused || match.status !== 'running' || destroyed) return;
    const st = replay(match);
    const p = st.currentPlayer;
    if (p == null || !isBot(p)) { flushDeferred(); return; }
    if (heldVisit(st) || botWaits()) { draw(); return; }
    const delay = botSpeed().dart;
    botTimer = setTimeout(() => {
      if (paused || destroyed) return;
      const s2 = replay(match);
      if (s2.currentPlayer !== p) return;
      const bot = getBot(p);
      if (!s2.openVisit) bot.startVisit();
      commit(bot.throwDart(s2.current.rem[p], 3 - s2.dartsInVisit, s2.current.isIn[p], match.settings));
    }, st.openVisit ? delay : delay * 1.6);
  }

  // ---------- Aktionen ----------
  function undo() {
    clearTimeout(botTimer);
    held = null; clearTimeout(heldTimer);
    clearPending();
    detector.cancelWait();
    if (!hasHuman) undoDart(match);
    else {
      let any = false;
      while (undoDart(match)) {
        any = true;
        if (!isBot(replay(match).currentPlayer)) break;
      }
      if (!any) toast('Nichts zum Rückgängigmachen');
    }
    save(); draw(); scheduleBot();
  }

  function editDart(li, vi, di) {
    const raw = match.legs[li].visits[vi].darts[di];
    const info = raw.original ? h('p', { class: 'small muted' }, `Ursprünglich erkannt: ${raw.original.label}${raw.original.conf != null ? ` (Konfidenz ${Math.round(raw.original.conf * 100)} %)` : ''}`) : null;
    const close = modal({
      title: `Dart korrigieren: ${raw.label}`,
      body: h('div', { class: 'stack' }, info,
        inputPad((d) => {
          close();
          if (raw.source === 'camera') storeSample(raw, d);
          replaceDart(match, li, vi, di, d);
          save(); draw(); scheduleBot();
          toast(`Korrigiert: ${raw.label} → ${d.label}`, 'ok');
        }),
        h('button', { class: 'btn danger', onclick: () => { close(); deleteDart(match, li, vi, di); save(); draw(); scheduleBot(); toast('Dart gelöscht'); } }, icon('trash'), 'Dart löschen')),
    });
  }

  async function storeSample(detected, corrected) {
    if (!settings.get('collectSamples') || !camera.active) return;
    try {
      await db.put('samples', {
        id: uid(), at: Date.now(), image: camera.snapshot(0.8),
        detected: { label: detected.label, x: detected.x, y: detected.y, conf: detected.conf },
        corrected: corrected.label, errorType: corrected.label === 'Miss' ? 'false-positive' : 'wrong-segment',
        calibration: calibration.current ? { H: calibration.current.H, quality: calibration.current.quality } : null,
      });
    } catch (e) { console.warn(e); }
  }

  function togglePause() {
    paused = !paused;
    clearTimeout(botTimer);
    if (!paused) scheduleBot();
    draw();
  }

  async function quit() {
    const choice = await new Promise((resolve) => {
      modal({
        title: 'Match beenden?',
        body: h('p', {}, 'Das Match ist gespeichert und kann später über das Dashboard fortgesetzt werden.'),
        onClose: () => resolve(null),
        actions: [
          { label: 'Verwerfen', kind: 'danger', onClick: () => resolve('discard') },
          { label: 'Später fortsetzen', kind: 'primary', onClick: () => resolve('later') },
        ],
      });
    });
    if (choice === 'discard') {
      if (!(await confirmDialog('Match endgültig löschen? Das kann nicht rückgängig gemacht werden.', { okLabel: 'Löschen', danger: true }))) return;
      await M.remove(match.id);
      location.hash = '#/dashboard';
    } else if (choice === 'later') {
      await save();
      location.hash = '#/dashboard';
    }
  }

  // ---------- Kamera ----------
  async function startCamera() {
    focusReady = false; focusLog.length = 0; firstSnap = null;
    const cal = calibration.current;
    if (!cal) { inputMode = 'manual'; draw(); return; }
    try {
      await camera.start(cal.deviceId || undefined, cal.label, settings.get('cameraHigh') !== false && !highOff);
      if (camera.fellBack) toast('Die gespeicherte Kamera wurde nicht gefunden – bitte unter „Kamera“ neu kalibrieren.', 'err');
      if (cal.zoom && camera.zoomInfo()) await camera.setZoom(cal.zoom);
      camera.attach(camStage);
      // Anderes Bildformat als beim Kalibrieren (z. B. 4:3 statt 16:9) → Kalibrierung passt nicht mehr
      if (cal.aspect && Math.abs(camera.aspect - cal.aspect) > 0.02) {
        toast('Die Kamera liefert ein anderes Bildformat als beim Kalibrieren – es wird automatisch neu ausgerichtet.', 'err');
        needReadjust = true;
      } else if (cal.resolution?.w && camera.resolution.w && cal.resolution.w !== camera.resolution.w) {
        // andere Auflösung: Der Bildausschnitt der Kamera kann sich leicht verschieben
        needReadjust = true;
      }
      setupCrop(cal);
      camera.startLoop(onFrame, 15);
    } catch (e) {
      toast(`Kamera nicht verfügbar: ${e.message}`, 'err');
      inputMode = 'manual';
      draw();
    }
  }

  // Gelerntes über die Pfeile (Richtung im Bild, Länge der Spitze) je Kalibrierung merken: Es soll nicht bei
  // jedem Spiel neu gelernt werden müssen
  const MODEL_KEY = 'autodarts180-pfeile';
  function loadDartModel(cal) {
    try {
      const m = JSON.parse(localStorage.getItem(MODEL_KEY) || 'null');
      if (m && m.cal === cal.createdAt) detector.setModel(m.model);
    } catch { /* ohne Speicher wird neu gelernt */ }
  }
  function saveDartModel() {
    try { localStorage.setItem(MODEL_KEY, JSON.stringify({ cal: calibration.current?.createdAt, model: detector.getModel() })); } catch { /* egal */ }
  }

  // Nur der Bildausschnitt um die Scheibe wird ausgewertet → mehr Pixel pro Millimeter
  function setupCrop(cal) {
    // Ausschnitt inkl. des Bereichs, in den Pfeile herausragen; Auflösung so, dass die Scheibe
    // so viele Pixel pro Millimeter behält wie im reinen Scheibenausschnitt (max. 960 px breit)
    const res = camera.resolution;
    const bc = boardCrop(cal.H);
    crop = res.w && res.h ? dartCrop(cal.H, res.w, res.h) : bc;
    detMaxW = Math.min(960, Math.round((640 * crop.w) / bc.w));
    ({ crop, maxW: detMaxW } = camera.snapCrop(crop, detMaxW));
    // Spitze im feinen Kamerabild nachmessen, wenn die Kamera mehr Bildpunkte liefert als ausgewertet werden
    detector.fineGrab = res.w && crop.w * res.w > 1.15 * detMaxW ? (used) => camera.grabFine(crop, used) : null;
    cropHm = cropH(cal.H, crop);
    const img = camera.grab({ crop, maxW: detMaxW });
    detector.setCalibration(cropHm, img.width, img.height, cropView(crop, img.width, img.height));
    loadDartModel(cal);
    // Anzeige: quadratischer Ausschnitt um die Scheibe statt des ganzen Kamerabilds
    viewCrop = boardCrop(cal.H, 232);
    const { w, h: vh } = camera.resolution;
    camStage.style.aspectRatio = `${(viewCrop.w * w) / (viewCrop.h * vh)}`;
  }

  function stopCamera() {
    camera.stop();
  }

  let pendingWarn = '';
  let settingsLocked = null;
  let focusReady = false; // Autofokus beim Start abwarten
  let firstSnap = null; // erstes Bild nach der Aufwärmphase: leere Scheibe, falls während des Scharfstellens schon geworfen wird
  const emptyKey = (img) => `${calibration.current?.createdAt}|${crop.x.toFixed(4)}|${crop.y.toFixed(4)}|${crop.w.toFixed(4)}|${img.width}x${img.height}`;
  const focusLog = [];
  let needReadjust = false;
  function onFrame() {
    if (destroyed || !crop) return;
    const now = performance.now();
    // Aufwärmphase: Belichtung und Fokus stellen sich noch ein → nichts auswerten
    if (now - (camera.startedAt || 0) < 2500) { detStatus = 'Kamera stellt scharf …'; drawOverlay(); return; }
    // nach der Aufwärmphase Schärfe und Weißabgleich festhalten (wo der Browser das erlaubt)
    if (settingsLocked === null) { settingsLocked = false; camera.lockSettings().then((ok) => { settingsLocked = ok; }); }
    if (needReadjust) { needReadjust = false; readjust(); return; }
    const tGrab = performance.now();
    const img = camera.grab({ crop, maxW: detMaxW });
    lastImg = img;
    checkSpeed(performance.now() - tGrab);
    // Erst anfangen, wenn der Autofokus zur Ruhe gekommen ist: Ein unscharfes Leerbild als Referenz würde
    // später überall Kantenreste ergeben
    if (!focusReady) {
      const s = frameMetrics(img).sharpness;
      if (!firstSnap) firstSnap = { data: img.data.slice(), w: img.width, h: img.height, sharp: s };
      focusLog.push(s); if (focusLog.length > 12) focusLog.shift();
      // Trend statt Schwankung: Wackeln ändert die Schärfe von Bild zu Bild, der Autofokus in eine Richtung
      const avg = (l) => l.reduce((p, q) => p + q, 0) / l.length, m1 = avg(focusLog.slice(0, 6)), m2 = avg(focusLog.slice(6).length ? focusLog.slice(6) : [0]);
      if ((focusLog.length < 12 || Math.abs(m2 - m1) > 0.06 * m1) && now - (camera.startedAt || 0) < 7000) { detStatus = 'Kamera stellt scharf …'; drawOverlay(); return; }
      focusReady = true;
      detector.rebase(img);
      // schon vor „bereit“ geworfen? Gegen ein Bild der leeren Scheibe prüfen (erstes Bild, falls gleich scharf, sonst
      // das aus dem letzten Spiel); die steckenden Pfeile werden dann gleich erkannt
      const sNow = frameMetrics(img).sharpness, key = emptyKey(img);
      const cands = [firstSnap && Math.abs(firstSnap.sharp - sNow) < 0.1 * sNow ? firstSnap : null, emptyCache && emptyCache.key === key && Date.now() - emptyCache.at < 30 * 60e3 ? emptyCache.snap : null];
      if (cands.some((c) => c && detector.adoptEmpty(c))) toast('Es stecken schon Pfeile – sie werden gewertet.');
      firstSnap = null;
    }
    const events = paused ? [] : detector.process(img);
    for (const ev of events) {
      // für „Erkennung speichern“: Bild vorher/nachher der letzten Pfeile (bleibt nur im Speicher)
      if ((ev.type === 'dart' || ev.type === 'reveal') && detector.lastRefBefore) {
        detLog.push({ fine: cutFine(ev, img), before: detector.lastRawBefore || detector.lastRefBefore, after: img, mask: detector.mask.slice(), state: `${ev.type === 'reveal' ? 'nachgewertet (gegen leere Scheibe), ' : ''}Pfeile davor ${Math.max(0, detector.dartsOnBoard - 1)}, ${ev.axis.fine ? `fein Stärke ${ev.axis.fine.strength.toFixed(1)} Spitze ${ev.axis.fine.m.toFixed(1)} mm verschoben ${ev.axis.fine.move.toFixed(1)} mm${ev.axis.fineUsed ? '' : ' (nicht übernommen)'}, ` : ''}Ausrichtung ${detector.lastShift ? detector.lastShift.tx.toFixed(2) + '/' + detector.lastShift.ty.toFixed(2) + ' Maßstab ' + (detector.lastShift.a || 0).toFixed(5) : '–'}, Schärfe ${(detector.sharpRatio || 1).toFixed(2)}, Rauschen ${detector.noise}`, tip: { ...ev.tip }, far: ev.far ? { ...ev.far } : null, round: detector.round, label: ev.hit.label, conf: ev.conf, reasons: ev.reasons, board: ev.board, at: Date.now() });
        if (detLog.length > 3) detLog.shift();
      }
      if (ev.type === 'takeout') { saveDartModel(); const snap = detector.emptySnapshot(); if (snap) emptyCache = { key: emptyKey(img), snap, at: Date.now() }; }
      if (ev.tip) ev.tip = uncropPoint(ev.tip, crop);
      handleDetection(ev);
    }
    detStatus = detector.status;
    // Kontrolle nur in ruhigen Momenten bei leerer, freier Scheibe – sie rechnet länger und darf das Spiel nicht
    // aufhalten (nicht direkt nach dem Herausziehen): beim Start einmal, danach höchstens alle 20 s
    const quiet = detector.stable > (trackedOnce ? 60 : 8);
    if (quiet && now - lastHealth > (trackedOnce ? 20000 : 1500)) {
      lastHealth = now;
      if (detector.isClear(img)) checkHealth(img);
    }
    drawOverlay();
  }

  // Kommt das Gerät mit der hohen Auflösung nicht mit, auf die normale umstellen. Die ersten Bilder nach dem Start sind oft langsam (Fokus, Speicher anlegen): erst danach messen, und zwar den
  // Median über viele Bilder, damit einzelne Ausreißer nicht umschalten. Umgestellt wird nur für diese Sitzung.
  let grabN = 0, grabMs = 0, highOff = false;
  const grabList = [];
  function checkSpeed(ms) {
    grabN++; grabMs += (ms - grabMs) / Math.min(grabN, 20);
    if (grabN <= 60 || grabList.length >= 90) return;
    grabList.push(ms);
    if (grabList.length < 90 || !camera.high || camera.resolution.w * camera.resolution.h < 4e6) return;
    const med = [...grabList].sort((a, b) => a - b)[45];
    camera.grabMedian = med;
    if (med < 80) return;
    highOff = true;
    toast(`Hohe Kameraauflösung für dieses Spiel ausgeschaltet: ein Bild zu holen dauerte ${Math.round(med)} ms. Die Erkennung läuft mit normaler Auflösung weiter.`);
    startCamera();
  }

  /** Ausschnitt um den Pfeil in Kameraauflösung
 (davor und danach) für „Erkennung speichern“ */
  const FINE = 672;
  function cutFine(ev, img, before = detector.lastFineBefore, after = detector.curFine) {
    if (!before || !after) return null;
    try {
      const k = after.w / img.width, cx = ev ? ((ev.tip.x * img.width + ev.far.x) / 2) * k : after.w / 2, cy = ev ? ((ev.tip.y * img.height + ev.far.y) / 2) * k : after.h / 2;
      const s = Math.min(FINE, after.w, after.h), x = Math.max(0, Math.min(after.w - s, Math.round(cx - s / 2))), y = Math.max(0, Math.min(after.h - s, Math.round(cy - s / 2)));
      const cut = (f) => f.canvas.getContext('2d').getImageData(x, y, s, s);
      return { k, s, x, y, before: cut(before), after: cut(after) };
    } catch { return null; }
  }

  const warnStreak = {};

  let trackFails = 0, trackedUntil = 0, trackedOnce = false;
  function checkHealth(img) {
    const cal = calibration.current;
    const refQ = cal.cropQuality ?? (cal.version >= 2 ? cal.quality : null);
    // Dauerhaft exakt: bei jeder freien Scheibe still um Bruchteile von Millimetern nachführen
    // Die Erkennung gleicht kleine Verschiebungen selbst aus; nachkalibriert wird beim Start und erst wieder,
    // wenn die Scheibe im Bild deutlich gewandert ist
    const tracked = !trackedOnce || detector.drift() > 3 ? autoTrack(img, refQ) : false;
    trackedOnce = true;
    const hc = healthCheck(img, cropHm, { quality: refQ, brightness: cal.version >= 2 ? cal.brightness : null });
    if (refQ != null && hc.quality < refQ - 0.03) {
      trackFails = tracked ? 0 : trackFails + 1;
      if (trackFails < 2) return; // erst nach mehreren erfolglosen Versuchen warnen
    } else trackFails = 0;
    // Warnung erst, wenn sie dreimal hintereinander (≈ 12 s) bei freier Scheibe auftritt
    const codes = new Set(hc.warnings.map((w) => w.code));
    for (const k of Object.keys(warnStreak)) if (!codes.has(k)) delete warnStreak[k];
    for (const c of codes) warnStreak[c] = (warnStreak[c] || 0) + 1;
    const show = hc.warnings.filter((w) => warnStreak[w.code] >= 3);
    const before = camWarnings.map((w) => w.text).join();
    camWarnings = show;
    if (before !== camWarnings.map((w) => w.text).join()) drawWarnings();
  }

  // Kleine Lageänderung automatisch ausgleichen (nur bei leerer Scheibe)
  function autoTrack(img, refQ) {
    // erst grob über die Farben, dann präzise über die gemessenen Ring- und Drahtkanten
    const before = fitScore(img, cropHm, 1);
    const r = refine(img, pointsFromH(cropHm), { maxEvals: 600, rotationScan: 0 });
    let Hn = r?.H && r.score >= before - 0.002 ? r.H : cropHm;
    const er = edgeRefine(img, Hn);
    if (er) Hn = er.H;
    const move = boardShiftMm(cropHm, Hn);
    if (move < 0.3 || move > 25) return false; // winzig: unnötig; sehr groß: nicht still übernehmen
    const q = calibrationQuality(img, Hn).score;
    if (refQ != null && q < refQ - 0.03) return false;
    const cal = calibration.current;
    const H = uncropH(Hn, crop);
    const updated = { ...cal, H, points: pointsFromH(H), trackedAt: Date.now() };
    calibration.save(updated);
    if (move < 8) {
      // gleicher Bildausschnitt: nur die Lage nachführen
      cropHm = Hn;
      detector.updateCalibration(cropHm, img, cropView(crop, img.width, img.height));
    } else {
      setupCrop(updated);
      detector.rebase(camera.grab({ crop, maxW: detMaxW }));
    }
    camWarnings = []; drawWarnings();
    if (move >= 1) trackedUntil = performance.now() + 4000; // Hinweis nur bei spürbarer Korrektur
    return true;
  }

  // Kalibrierung im laufenden Spiel nachjustieren (z. B. Handy minimal verrutscht)
  let adjusting = false;
  async function readjust() {
    if (adjusting || !camera.active) return;
    adjusting = true;
    toast('Justiere nach …');
    await new Promise((r) => setTimeout(r, 30));
    try {
      const cal = calibration.current;
      const full = camera.grab({ maxW: 1280 });
      const r = refineOrAuto(full, cal.points);
      const q = r?.H ? calibrationQuality(full, r.H).score : 0;
      if (q < 0.85) { toast(`Nachjustieren hat nicht gereicht (${Math.round(q * 100)} %) – bitte unter „Kamera“ neu kalibrieren.`, 'err'); return; }
      const c = boardCrop(r.H);
      const cropImg = camera.grab({ crop: c, maxW: 640 });
      const updated = { ...cal, H: r.H, points: r.points, aspect: camera.aspect, resolution: camera.resolution, quality: q, cropQuality: calibrationQuality(cropImg, cropH(r.H, c)).score, brightness: frameMetrics(cropImg).brightness, createdAt: Date.now(), version: 3 };
      await calibration.save(updated);
      setupCrop(updated);
      detector.rebase(camera.grab({ crop, maxW: detMaxW }));
      camWarnings = []; pendingWarn = ''; trackFails = 0;
      for (const k of Object.keys(warnStreak)) delete warnStreak[k];
      drawWarnings();
      toast(`Kalibrierung nachjustiert (${Math.round(q * 100)} %)`, 'ok');
    } finally { adjusting = false; }
  }

  function handleDetection(ev) {
    const st = replay(match);
    const p = st.currentPlayer;
    if (ev.type === 'takeout') {
      hideMarkers();
      held = null; clearTimeout(heldTimer);
      if (st.openVisit && p != null && !isBot(p) && st.openVisit.dartCount < 3) {
        toast(`Pfeile entfernt, aber nur ${st.openVisit.dartCount} Dart(s) erkannt – fehlenden Dart eintragen oder „Aufnahme beenden“.`, 'err');
      } else toast(pending.length ? `Pfeile entfernt – noch ${pending.length} Treffer bestätigen` : 'Pfeile entfernt – bereit');
      // offene Pfeile, die nicht freigelegt wurden: jetzt doch nachfragen
      if (pending.some((pd) => pd.open)) { for (const pd of pending) pd.open = false; sfx('miss'); }
      draw();
      scheduleBot();
      return;
    }
    if (ev.type === 'lighting') { toast('Lichtveränderung erkannt – Referenzbild aktualisiert'); return; }
    if (ev.type === 'reveal') { onReveal(ev); return; }
    if (ev.type !== 'dart') return;
    if (match.status !== 'running' || p == null) return;
    const d = makeDart(ev.hit.seg, ev.hit.mult);
    const dart = { ...d, x: ev.board.x, y: ev.board.y, conf: ev.conf, source: 'camera' };
    const thr = settings.get('confThreshold') ?? 0.6;
    const sure = ev.conf >= thr;
    if (sure && !pending.length) {
      commitCamera(dart, detector.round);
    } else {
      // Unsicher: nicht nachfragen, solange die Pfeile stecken. Der Pfeil bleibt offen und wird nachgewertet, sobald
      // die Pfeile, die ihn verdecken, gezogen sind (sichere Pfeile danach warten nur wegen der Reihenfolge)
      const later = !sure && settings.get('revealLater') !== false;
      pending.push({ dart, ev, round: detector.round, sure, open: later });
      if (later) detector.setOpen(ev.id, true);
      else if (!sure) sfx('miss');
      // drei Pfeile geworfen (gezählt + offen): Die Aufnahme ist vorbei, es geht ans Ziehen
      if (!isBot(p) && (st.openVisit ? st.openVisit.dartCount : 0) + pending.length >= 3) detector.awaitTakeout();
      draw();
    }
  }

  /** Pfeile in der Warteschlange, die feststehen, der Reihe nach verbuchen */
  function flushPending() {
    while (pending.length && pending[0].sure) { const pd = pending.shift(); commitCamera(pd.dart, pd.round); }
    draw();
  }

  /** Ein offener Pfeil ist freigelegt und neu ausgewertet */
  function onReveal(ev) {
    const pd = pending.find((q) => q.ev.id === ev.id);
    if (!pd) return;
    const d = makeDart(ev.hit.seg, ev.hit.mult);
    pd.dart = { ...d, x: ev.board.x, y: ev.board.y, conf: ev.conf, source: 'camera', revealed: true };
    pd.ev = { ...ev, reasons: ['nachgewertet', ...(ev.reasons || [])] };
    if (ev.conf >= (settings.get('confThreshold') ?? 0.6)) {
      pd.sure = true; pd.open = false; detector.setOpen(ev.id, false);
      toast(`Nachgewertet: ${d.label}`, 'ok');
      flushPending();
    } else {
      toast(`Nachgewertet, aber noch unsicher: ${d.label}`);
      draw();
    }
  }

  function drawOverlay() {
    const cal = calibration.current;
    if (!cal || inputMode !== 'camera') return;
    const rect = zoomRect(camStage, camera.aspect, viewCrop);
    placeVideo(camera.video, rect);
    const ctx = sizeCanvas(camCanvas, camStage);
    drawBoard(ctx, cal.H, rect, { color: 'rgba(61,220,132,0.35)', numbers: false });
    const st = replay(match);
    const v = shownVisit(st);
    // Würfe des Bots stecken nicht in der Scheibe
    const skip = v && isBot(v.p) ? Infinity : v && visitKey(st, v) === hidden.key ? hidden.n : 0;
    for (const [i, d] of (v?.darts || []).entries()) {
      if (i < skip || !Number.isFinite(d.x)) continue;
      const q = applyH(cal.H, d.x, d.y);
      drawMarker(ctx, rect, q.x, q.y, `${d.label} – ${d.score}`);
    }
    for (const pd of pending) if (pd.round === undefined || pd.round === detector.round) drawMarker(ctx, rect, pd.ev.tip.x, pd.ev.tip.y, `${pd.dart.label}?`, '#f5b83d');
    camStatus.textContent = `Erkennung: ${detStatus || '…'}${performance.now() < trackedUntil ? ' · Kalibrierung nachgeführt' : ''}${settingsLocked ? ' · Fokus fixiert' : ''}`;
  }

  // ---------- Darstellung ----------
  /** Was als Nächstes zu treffen ist (für die freien Dart-Felder): ab 170 Rest der beste Weg zum Finish */
  function targetPlan(st) {
    const p = st.currentPlayer;
    if (match.status !== 'running' || p == null || isBot(p)) return [];
    if (!st.current.isIn[p]) return [{ label: 'D', note: 'Einstieg' }];
    const rem = st.current.rem[p], left = 3 - st.dartsInVisit;
    if (rem > 180 || left < 1) return [];
    const info = checkoutInfo(rem, left, match.settings);
    if (info.possible) return info.routes[0].darts.map((d, i, l) => ({ label: d.label, note: i === l.length - 1 ? 'Finish' : null }));
    // mit den restlichen Darts nicht zu beenden: Feld, das einen guten Rest stehen lässt
    return rem <= 170 && info.setup ? [{ label: info.setup.dart.label, note: `lässt ${info.setup.leave}` }] : [];
  }

  function draw() {
    if (destroyed) return;
    const st = replay(match);
    const ms = matchStats(match);
    const s = match.settings;
    const cur = st.current;
    const p = st.currentPlayer;
    const hv = heldVisit(st); // fertige Aufnahme, die noch angezeigt wird
    const shownP = hv ? hv.p : p;

    // Kopfzeile
    clear(top);
    const legInfo = s.setsToWin > 1 ? `Set ${cur.set} · Leg ${cur.leg}` : `Leg ${cur.leg}`;
    top.append(
      h('div', { class: 'info' }, `${s.startScore} · ${s.inMode === 'double' ? 'Double-In · ' : ''}${s.outMode === 'double' ? 'Double-Out' : s.outMode === 'master' ? 'Master-Out' : 'Straight-Out'} · ${legInfo}`),
      h('div', { class: 'row' },
        h('button', { class: 'btn sm', onclick: togglePause, title: 'Pause' }, icon(paused ? 'play' : 'pause'), paused ? 'Weiter' : 'Pause'),
        h('button', { class: 'btn sm ghost', onclick: quit }, icon('x'))));

    // Spielerkarten
    clear(playersEl);
    match.players.forEach((pl, i) => {
      const ps = ms.players[i];
      const lastV = [...cur.visits].reverse().find((v) => v.p === i && v.closed);
      const legsTxt = s.setsToWin > 1 ? `S ${st.setsWon[i]} · L ${st.legsInSet[i]}` : `Legs ${st.legsInSet[i]}`;
      playersEl.append(h('div', { class: `pcard ${i === shownP ? 'active' : ''}` },
        h('div', { class: 'name' }, pl.isBot ? icon('bot') : null, pl.name, cur.starter === i ? h('span', { class: 'badge', title: 'Hat das Leg begonnen' }, '●') : null),
        h('div', { class: 'legs' }, legsTxt),
        h('div', { class: 'rem' }, cur.rem[i]),
        h('div', { class: 'meta' },
          h('span', {}, 'Ø ', h('b', {}, fmt.avg(ps.average))),
          h('span', {}, 'F9 ', h('b', {}, fmt.avg(ps.first9))),
          h('span', {}, 'Darts ', h('b', {}, ps.darts))),
        h('div', { class: 'last' }, lastV ? `Letzte: ${lastV.bust ? 'Bust' : lastV.scored} (${lastV.darts.map((d) => d.label).join(' ')})` : ' ')));
    });

    // Aktuelle Aufnahme
    clear(visitEl);
    const ov = st.openVisit, sv = ov || hv;
    const li = match.legs.length - 1;
    const vi = sv ? match.legs[li].visits.length - 1 : -1;
    // geworfene Darts; in den freien Feldern steht der Weg zum Finish (nach jedem Wurf neu berechnet)
    const plan = hv ? [] : targetPlan(st);
    const thrown = sv?.darts.length || 0;
    // noch nicht verbuchte Kamera-Pfeile dieser Aufnahme (offen oder in der Reihe wartend)
    const pend = !hv && p != null && !isBot(p) && !pending.some((q) => q.replaces) ? pending : [];
    for (let k = 0; k < 3; k++) {
      const d = sv?.darts[k], q = !d && pend[k - thrown], t = plan[k - thrown - pend.length];
      if (q) {
        visitEl.append(h('div', { class: 'dslot empty target', title: q.open ? 'Wird nachgewertet, sobald die verdeckenden Pfeile gezogen sind' : 'Wartet auf die Pfeile davor' }, `${q.dart.label}${q.sure ? '' : '?'}`, h('small', {}, q.open ? 'offen' : q.sure ? 'wartet' : 'bestätigen')));
      } else if (d) {
        visitEl.append(h('div', { class: `dslot pop ${d.bust ? 'bust' : ''}`, title: 'Antippen zum Korrigieren', onclick: () => editDart(li, vi, k) },
          d.source === 'camera' ? icon('camera', 'cam') : null, d.label, h('small', {}, d.points)));
      } else if (t) {
        visitEl.append(h('div', { class: 'dslot empty target', title: 'Vorgeschlagenes Feld' }, t.label, h('small', {}, t.note || `Dart ${k + 1} · Ziel`)));
      } else {
        visitEl.append(h('div', { class: 'dslot empty' }, '–', h('small', {}, `Dart ${k + 1}`)));
      }
    }
    visitEl.append(h('div', { class: 'vsum' }, sv ? (sv.bust ? 'Bust' : sv.scored) : 0, h('small', {}, hv ? `Aufnahme ${match.players[hv.p].name}` : 'Aufnahme')));

    // Match beendet
    clear(checkoutEl);
    if (match.status === 'finished') {
      checkoutEl.append(h('div', { class: 'checkout' }, h('span', { class: 'lbl' }, 'Match beendet'), h('span', { class: 'route' }, `${match.players[match.winner].name} gewinnt`)));
    }

    drawPending();
    drawWarnings();

    // Eingabe
    const botTurn = p != null && isBot(p);
    camStage.classList.toggle('hidden', inputMode !== 'camera');
    pad.style.pointerEvents = botTurn || paused ? 'none' : '';
    pad.style.opacity = botTurn || paused ? '0.4' : '';

    clear(actionsEl);
    const waitingTakeout = inputMode === 'camera' && detector.awaitingTakeout;
    actionsEl.append(...[
      h('button', { class: 'btn', onclick: undo, disabled: paused }, icon('undo'), 'Rückgängig'),
      h('button', { class: 'btn', disabled: !ov || !ov.dartCount || botTurn || paused, onclick: () => { endVisit(match); if (inputMode === 'camera') { detector.awaitTakeout(); holdVisit(0); } save(); draw(); scheduleBot(); } }, icon('check'), 'Aufnahme beenden'),
      h('button', { class: 'btn', disabled: !ov || botTurn || paused, onclick: () => { clearOpenVisit(match); clearPending(); detector.cancelWait(); save(); draw(); } }, icon('refresh'), 'Aufnahme wiederholen'),
      h('button', { class: 'btn', disabled: botTurn || paused, onclick: async () => { if (!(await confirmDialog('Die komplette letzte Aufnahme entfernen?'))) return; clearTimeout(botTimer); undoVisit(match); clearPending(); detector.cancelWait(); save(); draw(); scheduleBot(); } }, icon('undo'), 'Aufnahme löschen'),
      calibration.current ? h('button', { class: 'btn', onclick: () => { held = null; inputMode = inputMode === 'camera' ? 'manual' : 'camera'; match.inputMode = inputMode; save(); if (inputMode === 'camera') startCamera(); else stopCamera(); draw(); } }, icon(inputMode === 'camera' ? 'hand' : 'camera'), inputMode === 'camera' ? 'Nur Tastenfeld' : 'Kamera an') : null,
      inputMode === 'camera' ? h('button', { class: `btn ${waitingTakeout ? 'primary' : ''}`, onclick: resetReference }, icon('hand'), waitingTakeout ? 'Pfeile entfernt' : 'Referenz neu') : null,
      inputMode === 'camera' ? h('button', { class: 'btn', disabled: !lastImg || botTurn, onclick: redetect }, icon('refresh'), 'Erneut erkennen') : null,
      inputMode === 'camera' ? h('button', { class: 'btn', onclick: exportDetections, title: 'Bilder der letzten erkannten Pfeile (vorher/nachher mit erkannter Spitze) speichern, z. B. zur Fehleranalyse' }, icon('download'), 'Erkennung speichern') : null,
    ].filter(Boolean));
    if (waitingTakeout && botTurn && match.status === 'running') {
      actionsEl.append(h('div', { class: 'notice', style: { gridColumn: '1 / -1' } }, 'Der Bot wirft, sobald deine Pfeile aus der Scheibe gezogen sind.'));
    } else if (waitingTakeout && !botTurn && match.status === 'running') {
      actionsEl.append(h('div', { class: 'notice', style: { gridColumn: '1 / -1' } }, 'Bitte Pfeile aus der Scheibe ziehen – die Kamera erkennt das automatisch.'));
    }
    if (paused) actionsEl.append(h('div', { class: 'notice warn', style: { gridColumn: '1 / -1' } }, 'Match pausiert.'));

    drawLog(st);
    drawOverlay();
  }

  // Diagnosebilder der letzten (bis zu 3) erkannten Pfeile und des aktuellen Zustands, je ein Bild (2048 px breit):
  // Ausschnitte in Kameraauflösung ohne eingezeichnete Linien, darunter die Übersicht. Bleibt lokal, bis du es selbst weitergibst.
  async function exportDetections() {
    const now = lastImg && detector.diagnose(lastImg);
    const rows = detLog.slice();
    if (now) rows.push({ before: now.empty, after: lastImg, mask: now.mask, state: now.text, now: true, fine: detector.fineGrab && detector.emptyFine ? cutFine(null, lastImg, detector.emptyFine, camera.grabFine(crop, [detector.refFine, detector.emptyFine])) : null });
    if (!rows.length) { toast('Noch kein Bild vorhanden'); return; }
    const version = (await globalThis.caches?.keys?.().catch(() => []) || []).filter((k) => k.startsWith('autodarts180')).join(' ');
    const toCanvas = (data, w, hh) => { const c = document.createElement('canvas'); c.width = w; c.height = hh; c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data), w, hh), 0, 0); return c; };
    const files = [], stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    let nr = 0;
    for (const e of rows) {
      const old = !e.now && e.round !== detector.round && !(detector.awaitingTakeout && e.round === detector.round);
      const title = e.now ? '' : old ? 'aus voriger Aufnahme' : `${++nr}. erkannt`;
      const w = e.after.width, hh = e.after.height;
      const before = toCanvas(e.before, w, hh), after = toCanvas(e.after.data, w, hh);
      const m = new Uint8ClampedArray(e.after.data);
      for (let p = 0; p < e.mask.length; p++) if (e.mask[p]) { m[p * 4] = 255; m[p * 4 + 1] = 0; m[p * 4 + 2] = 255; }
      const mask = toCanvas(m, w, hh);
      // oben: Ausschnitte um den Pfeil (bzw. die Scheibenmitte) in Kameraauflösung, sonst in Auswerteauflösung
      const S = 672, head = 64, ov = 1016, oh = Math.round((ov * hh) / w), c = document.createElement('canvas');
      c.width = 2048; c.height = head + S + 16 + oh;
      const g = c.getContext('2d');
      g.fillStyle = '#111'; g.fillRect(0, 0, c.width, c.height);
      const cx = e.tip ? (e.tip.x * w + (e.far ? e.far.x : e.tip.x * w)) / 2 : w / 2, cy = e.tip ? (e.tip.y * hh + (e.far ? e.far.y : e.tip.y * hh)) / 2 : hh / 2;
      let x0, y0, s, k = 1; // Ausschnitt in Auswertepixeln
      g.imageSmoothingEnabled = false;
      if (e.fine) {
        k = e.fine.k; s = e.fine.s / k; x0 = e.fine.x / k; y0 = e.fine.y / k;
        const b = toCanvas(e.fine.before.data, e.fine.s, e.fine.s), f = toCanvas(e.fine.after.data, e.fine.s, e.fine.s);
        [b, f, f].forEach((img, n) => g.drawImage(img, 0, 0, e.fine.s, e.fine.s, n * (S + 16), head, S, S));
      } else {
        s = 336; x0 = Math.max(0, Math.min(w - s, Math.round(cx - s / 2))); y0 = Math.max(0, Math.min(hh - s, Math.round(cy - s / 2)));
        [before, after, after].forEach((img, n) => g.drawImage(img, x0, y0, s, s, n * (S + 16), head, S, S));
      }
      // rechts die erkannte Veränderung darübergelegt
      const only = new Uint8ClampedArray(w * hh * 4);
      for (let p = 0; p < e.mask.length; p++) if (e.mask[p]) { only[p * 4] = 255; only[p * 4 + 2] = 255; only[p * 4 + 3] = 150; }
      g.drawImage(toCanvas(only, w, hh), x0, y0, s, s, 2 * (S + 16), head, S, S);
      g.imageSmoothingEnabled = true;
      // unten: Übersicht, die Spitze nur hier eingezeichnet
      g.drawImage(after, 0, 0, w, hh, 0, head + S + 16, ov, oh);
      g.drawImage(mask, 0, 0, w, hh, ov + 16, head + S + 16, ov, oh);
      if (e.tip) { const tx = e.tip.x * ov, ty = head + S + 16 + e.tip.y * oh; g.strokeStyle = '#00e5ff'; g.lineWidth = 2; g.beginPath(); g.arc(tx, ty, 16, 0, 2 * Math.PI); g.stroke(); }
      g.fillStyle = '#fff'; g.font = 'bold 20px system-ui, sans-serif';
      g.fillText(e.now ? `Jetzt (links: leere Scheibe) · ${version}` : `${title}: ${e.label} (${Math.round(e.conf * 100)} %)  x ${e.board.x.toFixed(1)} / y ${e.board.y.toFixed(1)} mm · Spitze im Ausschnitt ${Math.round(((e.tip.x * w - x0) * S) / s)}, ${Math.round(((e.tip.y * hh - y0) * S) / s)} · ${version}`, 8, 20, 2032);
      g.font = '15px system-ui, sans-serif';
      if (!e.now) g.fillText(e.reasons.join(', ') || 'keine Auffälligkeiten', 8, 40, 2032);
      g.fillText(`${w}×${hh} · Kamera ${camera.resolution.w}×${camera.resolution.h}, Bild holen ${Math.round(grabMs)} ms · Ausschnitt ab ${x0.toFixed(1)}, ${y0.toFixed(1)}, ${(S / s).toFixed(2)}× · ${e.state || ''}`, 8, 59, 2032);
      const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.95));
      const name = e.now ? 'jetzt' : old ? `vorher-${files.length + 1}` : nr;
      if (blob) files.push(new File([blob], `autodarts180-${stamp}-${name}.jpg`, { type: 'image/jpeg' }));
      // dazu die Spitze in Kameraauflösung, so groß, dass beim Teilen nichts verkleinert wird (800 px breit)
      if (e.fine && e.tip) {
        const T = 384, d = document.createElement('canvas'); d.width = 800; d.height = 32 + T;
        const q = d.getContext('2d'); q.fillStyle = '#111'; q.fillRect(0, 0, d.width, d.height);
        const tx = e.tip.x * w * e.fine.k - e.fine.x, ty = e.tip.y * hh * e.fine.k - e.fine.y, sx = Math.max(0, Math.min(e.fine.s - T, Math.round(tx - T / 2))), sy = Math.max(0, Math.min(e.fine.s - T, Math.round(ty - T / 2)));
        const b = toCanvas(e.fine.before.data, e.fine.s, e.fine.s), f = toCanvas(e.fine.after.data, e.fine.s, e.fine.s);
        q.drawImage(b, sx, sy, T, T, 0, 32, T, T); q.drawImage(f, sx, sy, T, T, T + 32, 32, T, T);
        q.strokeStyle = '#00e5ff'; q.lineWidth = 1.5; q.beginPath(); q.arc(T + 32 + tx - sx, 32 + ty - sy, 10, 0, 2 * Math.PI); q.stroke();
        q.fillStyle = '#fff'; q.font = '14px system-ui, sans-serif';
        q.fillText(`${e.now ? 'Jetzt' : title}: ${e.label || ''} · Spitze vorher | nachher, 1:1 Kamerabild ab ${(e.fine.x + sx)}, ${(e.fine.y + sy)} (Faktor ${e.fine.k.toFixed(2)})`, 6, 21, 788);
        const bl = await new Promise((res) => d.toBlob(res, 'image/jpeg', 0.95));
        if (bl) files.push(new File([bl], `autodarts180-${stamp}-${name}-spitze.jpg`, { type: 'image/jpeg' }));
      }
    }
    try {
      if (navigator.canShare?.({ files })) { await navigator.share({ files, title: 'Autodarts180 Erkennung' }); return; }
    } catch (e) { if (e?.name === 'AbortError') return; }
    for (const f of files) {
      const a = h('a', { href: URL.createObjectURL(f), download: f.name });
      document.body.append(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    }
    toast('Erkennungsbilder gespeichert');
  }

  // „Pfeile entfernt“ bzw. „Referenz neu“. Stecken offenbar noch Pfeile, erst beim zweiten Druck übernehmen:
  // Ein Leerbild mit Pfeilen darin würde jede weitere Erkennung stören.
  let resetAsked = 0;
  function resetReference() {
    if (!lastImg) return;
    if (!detector.seemsEmpty(lastImg) && performance.now() - resetAsked > 6000) {
      resetAsked = performance.now();
      toast('Es scheinen noch Pfeile zu stecken – bitte zuerst herausziehen. Nochmal drücken übernimmt das Bild trotzdem.', 'err');
      return;
    }
    detector.rebase(lastImg); pending = []; hideMarkers(); held = null; clearTimeout(heldTimer);
    toast('Referenzbild neu gesetzt'); draw(); scheduleBot();
  }

  function redetect() {
    const det = detector.redetectLast(lastImg);
    if (!det) { toast('Kein zuletzt erkannter Pfeil zum erneuten Auswerten'); return; }
    det.tip = uncropPoint(det.tip, crop);
    const st = replay(match);
    const ov = st.openVisit;
    const li = match.legs.length - 1;
    const v = match.legs[li].visits[match.legs[li].visits.length - 1];
    const lastD = v?.darts[v.darts.length - 1];
    const nd = { ...makeDart(det.hit.seg, det.hit.mult), x: det.board.x, y: det.board.y, conf: det.conf, source: 'camera' };
    if (ov && lastD && lastD.source === 'camera') {
      if (lastD.label === nd.label) { toast(`Erneute Erkennung bestätigt: ${nd.label}`); return; }
      pending.push({ dart: nd, ev: det, replaces: { li, vi: match.legs[li].visits.length - 1, di: v.darts.length - 1 } });
      drawPending();
      toast(`Neue Erkennung: ${nd.label} – bitte bestätigen`);
    } else toast('Der letzte Pfeil gehört nicht zur aktuellen Aufnahme');
  }

  function drawPending() {
    clear(pendingEl);
    if (!pending.length) return;
    const pd = pending.find((q) => !q.sure) || pending[0];
    if (pd.open) {
      // kein Rückfrage-Fenster: nur ein Hinweis; bestätigen kann man trotzdem schon
      pendingEl.append(h('div', { class: 'notice' },
        h('div', {}, `Pfeil offen (Vorschlag ${pd.dart.label}, ${Math.round(pd.ev.conf * 100)} %): Zieh zuerst die Pfeile, die ihn verdecken – dann wird er nachgewertet.`),
        h('div', { class: 'row', style: { marginTop: '6px' } },
          h('button', { class: 'btn sm', onclick: () => resolvePending('confirm', pd) }, icon('check'), `${pd.dart.label} stimmt`),
          h('button', { class: 'btn sm', onclick: () => resolvePending('correct', pd) }, icon('edit'), 'Korrigieren'))));
      return;
    }
    const reasons = pd.ev.reasons?.length ? pd.ev.reasons.join(', ') : 'geringe Sicherheit';
    pendingEl.append(h('div', { class: 'pending-box' },
      h('div', { style: { fontWeight: 750 } }, `Unsichere Erkennung: ${pd.dart.label} (${pd.dart.score} Punkte)`),
      h('div', { class: 'small muted' }, `Konfidenz ${Math.round(pd.ev.conf * 100)} % – ${reasons}${pending.length > 1 ? ` · ${pending.length - 1} weitere wartend` : ''}`),
      h('div', { class: 'row', style: { marginTop: '8px' } },
        h('button', { class: 'btn primary sm', onclick: () => resolvePending('confirm') }, icon('check'), 'Bestätigen'),
        h('button', { class: 'btn sm', onclick: () => resolvePending('correct') }, icon('edit'), 'Korrigieren'),
        h('button', { class: 'btn sm ghost', onclick: () => resolvePending('discard') }, icon('x'), 'Kein Pfeil'))));
  }

  function resolvePending(action, which = null) {
    const pd = which || pending.find((q) => !q.sure) || pending[0];
    if (!pd || !pending.includes(pd)) return;
    if (pd.ev.id != null) detector.setOpen(pd.ev.id, false);
    const finish = (dart) => {
      if (pd.replaces) {
        pending.splice(pending.indexOf(pd), 1);
        const { li, vi, di } = pd.replaces;
        replaceDart(match, li, vi, di, dart);
        save(); draw(); scheduleBot();
      } else {
        // steht fest; verbucht wird in der Reihenfolge der Würfe
        pd.dart = dart; pd.sure = true; pd.open = false;
        flushPending();
      }
    };
    if (action === 'discard') pending.splice(pending.indexOf(pd), 1);
    // bestätigte Pfeile zeigen der Erkennung, in welche Richtung die Pfeile im Bild stecken
    if (action === 'confirm') detector.learnDirection({ ...pd.ev, conf: 1 });
    if (action === 'discard') detector.forget(pd.ev);
    if (action === 'confirm') finish({ ...pd.dart, confirmed: true });
    else if (action === 'discard') { flushPending(); }
    else {
      const close = modal({
        title: `Erkannt: ${pd.dart.label} – richtiges Feld wählen`,
        body: inputPad((d) => {
          close();
          storeSample(pd.dart, d);
          finish({ ...d, source: 'camera', corrected: true, original: { label: pd.dart.label, x: pd.dart.x, y: pd.dart.y, conf: pd.dart.conf, source: 'camera' } });
        }),
      });
    }
    drawPending();
  }

  function drawWarnings() {
    clear(warnEl);
    if (inputMode !== 'camera' || !camWarnings.length) return;
    warnEl.append(h('div', { class: 'notice warn' },
      camWarnings.map((w) => h('div', {}, w.text)),
      h('div', { class: 'row', style: { marginTop: '8px' } },
        camWarnings.some((w) => w.code === 'moved') ? h('button', { class: 'btn sm primary', onclick: readjust }, icon('target'), 'Jetzt nachjustieren') : null,
        h('a', { class: 'btn sm', href: '#/camera' }, icon('camera'), 'Neu kalibrieren'))));
  }

  function drawLog(st) {
    clear(logEl);
    const cur = st.current;
    logEl.append(h('h3', {}, `Aufnahmen ${match.settings.setsToWin > 1 ? `Set ${cur.set} · ` : ''}Leg ${cur.leg}`));
    if (!cur.visits.length) { logEl.append(h('div', { class: 'small muted' }, 'Noch keine Würfe in diesem Leg.')); return; }
    const li = match.legs.length - 1;
    const rows = cur.visits.map((v, vi) => h('tr', {},
      h('td', {}, match.players[v.p].name),
      h('td', {}, v.darts.map((d, di) => h('button', { class: 'btn sm ghost', style: { minHeight: '28px', padding: '0 6px' }, title: d.original ? `korrigiert (vorher ${d.original.label})` : 'Korrigieren', onclick: () => editDart(li, vi, di) }, d.label, d.corrected ? '*' : ''))),
      h('td', { class: 'r num' }, v.bust ? h('span', { class: 'badge red' }, 'Bust') : v.scored),
      h('td', { class: 'r num muted' }, v.remAfter))).reverse();
    logEl.append(h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Spieler'), h('th', {}, 'Darts'), h('th', { class: 'r' }, 'Punkte'), h('th', { class: 'r' }, 'Rest'))),
      h('tbody', {}, rows))),
    h('div', { class: 'small muted', style: { marginTop: '6px' } }, '* = manuell korrigiert. Darts antippen zum Korrigieren.'));
  }

  // ---------- Wake Lock ----------
  async function lockScreen() {
    if (!settings.get('keepAwake') || !('wakeLock' in navigator)) return;
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* nicht erlaubt */ }
  }
  const onVis = () => { if (document.visibilityState === 'visible') lockScreen(); };
  document.addEventListener('visibilitychange', onVis);
  lockScreen();

  // ---------- Tastatur (Desktop) ----------
  const onKey = (e) => {
    if (e.target.matches('input, textarea, select') || document.querySelector('.modal-back')) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
    else if (e.key === 'Enter') { const st = replay(match); if (st.openVisit?.dartCount) { endVisit(match); save(); draw(); scheduleBot(); } }
    else if (e.key === 'd' || e.key === 'D') pad.setMult(2);
    else if (e.key === 't' || e.key === 'T') pad.setMult(3);
    else if (e.key === 's' || e.key === 'S') pad.setMult(1);
  };
  document.addEventListener('keydown', onKey);
  const onResize = () => drawOverlay();
  window.addEventListener('resize', onResize);

  draw();
  if (inputMode === 'camera') startCamera();
  if (match.status === 'finished') onFinished();
  else scheduleBot();

  return () => {
    destroyed = true;
    clearTimeout(botTimer);
    stopCamera();
    document.removeEventListener('visibilitychange', onVis);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    wakeLock?.release?.().catch(() => {});
    save();
  };
}
