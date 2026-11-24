// Live-Spielansicht X01
import { h, icon, clear, toast, modal, confirmDialog, avatar, fmt } from '../dom.js';
import { inputPad } from '../inputPad.js';
import { matches as M } from '../../data/repo.js';
import { db } from '../../data/db.js';
import { replay, addDart, endVisit, undoDart, undoVisit, clearOpenVisit, replaceDart, deleteDart } from '../../core/x01.js';
import { matchStats } from '../../core/stats.js';
import { checkoutInfo } from '../../core/checkout.js';
import { makeDart } from '../../core/board.js';
import { Bot } from '../../core/bot.js';
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

export async function render(root, params) {
  const match = await M.get(params[0]);
  if (!match) {
    root.append(h('div', { class: 'notice err' }, 'Match nicht gefunden.'), h('a', { class: 'btn', href: '#/setup', style: { marginTop: '12px' } }, 'Neues Spiel'));
    return;
  }

  let paused = false;
  let botTimer = null;
  let pending = []; // unsichere Kamera-Erkennungen
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
  function commit(dart) {
    if (paused || match.status !== 'running') return;
    const before = replay(match);
    const p = before.currentPlayer;
    let res;
    try { res = addDart(match, dart); } catch (e) { toast(e.message, 'err'); return; }
    save();
    feedback(res, dart, p);
    draw();
    if (res.visit?.closed && !isBot(p) && inputMode === 'camera') detector.awaitTakeout();
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
  function scheduleBot() {
    clearTimeout(botTimer);
    if (paused || match.status !== 'running' || destroyed) return;
    const st = replay(match);
    const p = st.currentPlayer;
    if (p == null || !isBot(p)) return;
    const delay = settings.get('botDelay') || 750;
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
    pending = [];
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
    focusReady = false; focusLog.length = 0;
    const cal = calibration.current;
    if (!cal) { inputMode = 'manual'; draw(); return; }
    try {
      await camera.start(cal.deviceId || undefined, cal.label);
      if (camera.fellBack) toast('Die gespeicherte Kamera wurde nicht gefunden – bitte unter „Kamera“ neu kalibrieren.', 'err');
      if (cal.zoom && camera.zoomInfo()) await camera.setZoom(cal.zoom);
      camera.attach(camStage);
      // Anderes Bildformat als beim Kalibrieren (z. B. 4:3 statt 16:9) → Kalibrierung passt nicht mehr
      if (cal.aspect && Math.abs(camera.aspect - cal.aspect) > 0.02) {
        toast('Die Kamera liefert ein anderes Bildformat als beim Kalibrieren – es wird automatisch neu ausgerichtet.', 'err');
        needReadjust = true;
      }
      setupCrop(cal);
      camera.startLoop(onFrame, 10);
    } catch (e) {
      toast(`Kamera nicht verfügbar: ${e.message}`, 'err');
      inputMode = 'manual';
      draw();
    }
  }

  // Nur der Bildausschnitt um die Scheibe wird ausgewertet → mehr Pixel pro Millimeter
  function setupCrop(cal) {
    // Ausschnitt inkl. des Bereichs, in den Pfeile herausragen; Auflösung so, dass die Scheibe
    // so viele Pixel pro Millimeter behält wie im reinen Scheibenausschnitt (max. 960 px breit)
    const res = camera.resolution;
    const bc = boardCrop(cal.H);
    crop = res.w && res.h ? dartCrop(cal.H, res.w, res.h) : bc;
    detMaxW = Math.min(960, Math.round((640 * crop.w) / bc.w));
    cropHm = cropH(cal.H, crop);
    const img = camera.grab({ crop, maxW: detMaxW });
    detector.setCalibration(cropHm, img.width, img.height, cropView(crop, img.width, img.height));
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
    const img = camera.grab({ crop, maxW: detMaxW });
    lastImg = img;
    // Erst anfangen, wenn der Autofokus zur Ruhe gekommen ist: Ein unscharfes Leerbild als Referenz würde
    // später überall Kantenreste ergeben
    if (!focusReady) {
      const s = frameMetrics(img).sharpness;
      focusLog.push(s); if (focusLog.length > 12) focusLog.shift();
      // Trend statt Schwankung: Wackeln ändert die Schärfe von Bild zu Bild, der Autofokus in eine Richtung
      const avg = (l) => l.reduce((p, q) => p + q, 0) / l.length, m1 = avg(focusLog.slice(0, 6)), m2 = avg(focusLog.slice(6).length ? focusLog.slice(6) : [0]);
      if ((focusLog.length < 12 || Math.abs(m2 - m1) > 0.06 * m1) && now - (camera.startedAt || 0) < 7000) { detStatus = 'Kamera stellt scharf …'; drawOverlay(); return; }
      focusReady = true;
      detector.rebase(img);
    }
    const events = paused ? [] : detector.process(img);
    for (const ev of events) {
      // für „Erkennung speichern“: Bild vorher/nachher der letzten Pfeile (bleibt nur im Speicher)
      if (ev.type === 'dart' && detector.lastRefBefore) {
        detLog.push({ before: detector.lastRawBefore || detector.lastRefBefore, after: img, mask: detector.mask.slice(), state: `Pfeile davor ${Math.max(0, detector.dartsOnBoard - 1)}, Ausrichtung ${detector.lastShift ? detector.lastShift.tx.toFixed(2) + '/' + detector.lastShift.ty.toFixed(2) + ' Maßstab ' + (detector.lastShift.a || 0).toFixed(5) : '–'}, Schärfe ${(detector.sharpRatio || 1).toFixed(2)}, Rauschen ${detector.noise}`, H: cropHm, tip: { ...ev.tip }, label: ev.hit.label, conf: ev.conf, reasons: ev.reasons, board: ev.board, at: Date.now() });
        if (detLog.length > 3) detLog.shift();
      }
      if (ev.tip) ev.tip = uncropPoint(ev.tip, crop);
      handleDetection(ev);
    }
    detStatus = detector.status;
    // Kontrolle nur bei leerer, freier Scheibe (keine Pfeile, niemand davor, keine Bewegung)
    if (now - lastHealth > 4000 && detector.isClear(img)) {
      lastHealth = now;
      checkHealth(img);
    }
    drawOverlay();
  }

  const warnStreak = {};
  let trackFails = 0, trackedUntil = 0;
  function checkHealth(img) {
    const cal = calibration.current;
    const refQ = cal.cropQuality ?? (cal.version >= 2 ? cal.quality : null);
    // Dauerhaft exakt: bei jeder freien Scheibe still um Bruchteile von Millimetern nachführen
    const tracked = autoTrack(img, refQ);
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
    setupCrop(updated);
    detector.rebase(camera.grab({ crop, maxW: detMaxW }));
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
      const updated = { ...cal, H: r.H, points: r.points, aspect: camera.aspect, quality: q, cropQuality: calibrationQuality(cropImg, cropH(r.H, c)).score, brightness: frameMetrics(cropImg).brightness, createdAt: Date.now(), version: 3 };
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
      if (st.openVisit && p != null && !isBot(p) && st.openVisit.dartCount < 3) {
        toast(`Pfeile entfernt, aber nur ${st.openVisit.dartCount} Dart(s) erkannt – fehlenden Dart eintragen oder „Aufnahme beenden“.`, 'err');
      } else toast('Pfeile entfernt – bereit');
      draw();
      return;
    }
    if (ev.type === 'lighting') { toast('Lichtveränderung erkannt – Referenzbild aktualisiert'); return; }
    if (ev.type !== 'dart') return;
    if (match.status !== 'running' || p == null || isBot(p)) return;
    const d = makeDart(ev.hit.seg, ev.hit.mult);
    const dart = { ...d, x: ev.board.x, y: ev.board.y, conf: ev.conf, source: 'camera' };
    const thr = settings.get('confThreshold') ?? 0.6;
    if (ev.conf >= thr && !pending.length) {
      commit(dart);
    } else {
      pending.push({ dart, ev });
      sfx('miss');
      drawPending();
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
    const v = st.openVisit || st.current.visits[st.current.visits.length - 1];
    for (const d of v?.darts || []) {
      if (!Number.isFinite(d.x)) continue;
      const q = applyH(cal.H, d.x, d.y);
      drawMarker(ctx, rect, q.x, q.y, `${d.label} – ${d.score}`);
    }
    for (const pd of pending) drawMarker(ctx, rect, pd.ev.tip.x, pd.ev.tip.y, `${pd.dart.label}?`, '#f5b83d');
    camStatus.textContent = `Erkennung: ${detStatus || '…'}${performance.now() < trackedUntil ? ' · Kalibrierung nachgeführt' : ''}${settingsLocked ? ' · Fokus fixiert' : ''}`;
  }

  // ---------- Darstellung ----------
  function draw() {
    if (destroyed) return;
    const st = replay(match);
    const ms = matchStats(match);
    const s = match.settings;
    const cur = st.current;
    const p = st.currentPlayer;

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
      playersEl.append(h('div', { class: `pcard ${i === p ? 'active' : ''}` },
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
    const ov = st.openVisit;
    const li = match.legs.length - 1;
    const vi = ov ? match.legs[li].visits.length - 1 : -1;
    for (let k = 0; k < 3; k++) {
      const d = ov?.darts[k];
      if (d) {
        visitEl.append(h('div', { class: `dslot pop ${d.bust ? 'bust' : ''}`, title: 'Antippen zum Korrigieren', onclick: () => editDart(li, vi, k) },
          d.source === 'camera' ? icon('camera', 'cam') : null, d.label, h('small', {}, d.points)));
      } else {
        visitEl.append(h('div', { class: 'dslot empty' }, '–', h('small', {}, `Dart ${k + 1}`)));
      }
    }
    visitEl.append(h('div', { class: 'vsum' }, ov ? ov.scored : 0, h('small', {}, 'Aufnahme')));

    // Checkout
    clear(checkoutEl);
    if (match.status === 'finished') {
      checkoutEl.append(h('div', { class: 'checkout' }, h('span', { class: 'lbl' }, 'Match beendet'), h('span', { class: 'route' }, `${match.players[match.winner].name} gewinnt`)));
    } else if (p != null) {
      const rem = cur.rem[p];
      const dartsLeft = 3 - st.dartsInVisit;
      if (!cur.isIn[p]) {
        checkoutEl.append(h('div', { class: 'checkout none' }, h('span', { class: 'lbl' }, 'Double-In'), h('span', { class: 'route' }, 'Doppel zum Einstieg treffen')));
      } else if (rem <= 180) {
        const info = checkoutInfo(rem, dartsLeft, s);
        if (info.possible) {
          const [best, ...alts] = info.routes;
          checkoutEl.append(h('div', { class: 'checkout' },
            h('span', { class: 'lbl' }, `Checkout ${rem}`),
            h('span', { class: 'route' }, best.darts.map((d) => d.label).join(' → ')),
            alts.length ? h('div', { class: 'alts' }, 'Alternativen: ', alts.map((r) => r.darts.map((d) => d.label).join(' → ')).join('  ·  ')) : null));
        } else {
          checkoutEl.append(h('div', { class: 'checkout none' },
            h('span', { class: 'lbl' }, `Rest ${rem}`),
            h('span', { class: 'route', style: { fontSize: '17px' } }, `Kein Checkout mit ${dartsLeft} Dart${dartsLeft > 1 ? 's' : ''}${info.setup ? ` – Vorschlag: ${info.setup.dart.label} (Rest ${info.setup.leave})` : ''}`)));
        }
      } else {
        checkoutEl.append(h('div', { class: 'checkout none' }, h('span', { class: 'lbl' }, `${match.players[p].name} ist dran`), h('span', { class: 'route', style: { fontSize: '17px' } }, `Noch ${rem - 170} Punkte bis zum Finish-Bereich`)));
      }
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
      h('button', { class: 'btn', disabled: !ov || !ov.dartCount || botTurn || paused, onclick: () => { endVisit(match); if (inputMode === 'camera') detector.awaitTakeout(); save(); draw(); scheduleBot(); } }, icon('check'), 'Aufnahme beenden'),
      h('button', { class: 'btn', disabled: !ov || botTurn || paused, onclick: () => { clearOpenVisit(match); pending = []; save(); draw(); } }, icon('refresh'), 'Aufnahme wiederholen'),
      h('button', { class: 'btn', disabled: botTurn || paused, onclick: async () => { if (!(await confirmDialog('Die komplette letzte Aufnahme entfernen?'))) return; clearTimeout(botTimer); undoVisit(match); save(); draw(); scheduleBot(); } }, icon('undo'), 'Aufnahme löschen'),
      calibration.current ? h('button', { class: 'btn', onclick: () => { inputMode = inputMode === 'camera' ? 'manual' : 'camera'; match.inputMode = inputMode; save(); if (inputMode === 'camera') startCamera(); else stopCamera(); draw(); } }, icon(inputMode === 'camera' ? 'hand' : 'camera'), inputMode === 'camera' ? 'Nur Tastenfeld' : 'Kamera an') : null,
      inputMode === 'camera' ? h('button', { class: `btn ${waitingTakeout ? 'primary' : ''}`, onclick: () => { if (lastImg) detector.rebase(lastImg); pending = []; toast('Referenzbild neu gesetzt'); draw(); } }, icon('hand'), waitingTakeout ? 'Pfeile entfernt' : 'Referenz neu') : null,
      inputMode === 'camera' ? h('button', { class: 'btn', disabled: !lastImg || botTurn, onclick: redetect }, icon('refresh'), 'Erneut erkennen') : null,
      inputMode === 'camera' ? h('button', { class: 'btn', disabled: !lastImg, onclick: exportDetections, title: 'Bilder der letzten erkannten Pfeile (vorher/nachher mit erkannter Spitze) speichern, z. B. zur Fehleranalyse' }, icon('download'), 'Erkennung speichern') : null,
    ].filter(Boolean));
    if (waitingTakeout && !botTurn && match.status === 'running') {
      actionsEl.append(h('div', { class: 'notice', style: { gridColumn: '1 / -1' } }, 'Bitte Pfeile aus der Scheibe ziehen – die Kamera erkennt das automatisch.'));
    }
    if (paused) actionsEl.append(h('div', { class: 'notice warn', style: { gridColumn: '1 / -1' } }, 'Match pausiert.'));

    drawLog(st);
    drawOverlay();
  }

  // Diagnosebild der letzten (bis zu 3) erkannten Pfeile: links Bild davor, rechts danach mit
  // erkannter Spitze und Ringen der Kalibrierung. Bleibt lokal, bis du es selbst weitergibst.
  async function exportDetections() {
    const now = lastImg && detector.diagnose(lastImg);
    if (!detLog.length && !now) return;
    const w = lastImg ? lastImg.width : detLog[0].after.width, hh = lastImg ? lastImg.height : detLog[0].after.height;
    const rows = detLog.filter((e) => e.after.width === w && e.after.height === hh);
    if (now) rows.push({ before: now.empty, after: lastImg, H: cropHm, mask: now.mask, state: now.text, now: true });
    if (!rows.length) return;
    const version = (await globalThis.caches?.keys?.().catch(() => []) || []).filter((k) => k.startsWith('autodarts180')).join(' ');
    const c = document.createElement('canvas');
    c.width = w * 3; c.height = hh * rows.length;
    const g = c.getContext('2d');
    rows.forEach((e, i) => {
      const y0 = i * hh;
      g.putImageData(new ImageData(new Uint8ClampedArray(e.before), w, hh), 0, y0);
      g.putImageData(e.after, w, y0);
      if (e.mask) {
        // dritte Spalte: was die Erkennung als verändert ansieht
        const m = new ImageData(new Uint8ClampedArray(e.after.data), w, hh);
        for (let p = 0; p < e.mask.length; p++) if (e.mask[p]) { m.data[p * 4] = 255; m.data[p * 4 + 1] = 0; m.data[p * 4 + 2] = 255; }
        g.putImageData(m, w * 2, y0);
      }
      // Ringe der Kalibrierung (dünn), nur links, damit das Nachher-Bild unverändert bleibt
      g.strokeStyle = 'rgba(61,220,132,0.6)'; g.lineWidth = 1;
      for (const off of [0]) for (const r of [6.35, 15.9, 99, 107, 162, 170]) {
        g.beginPath();
        for (let k = 0; k <= 72; k++) {
          const t = (k * 5 * Math.PI) / 180, p = applyH(e.H, r * Math.cos(t), r * Math.sin(t));
          const px = off + p.x * w, py = y0 + p.y * hh;
          if (k) g.lineTo(px, py); else g.moveTo(px, py);
        }
        g.stroke();
      }
      if (e.tip) {
        const tx = w + e.tip.x * w, ty = y0 + e.tip.y * hh;
        g.strokeStyle = '#ff3b3b'; g.lineWidth = 2;
        g.beginPath(); g.arc(tx, ty, 7, 0, 2 * Math.PI); g.moveTo(tx - 12, ty); g.lineTo(tx + 12, ty); g.moveTo(tx, ty - 12); g.lineTo(tx, ty + 12); g.stroke();
      }
      g.font = 'bold 16px system-ui, sans-serif'; g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillRect(w, y0, w * 2, 44);
      g.fillStyle = '#fff';
      g.fillText(e.now ? `Jetzt (Vergleich mit der leeren Scheibe) ${version}` : `${i + 1}. erkannt: ${e.label} (${Math.round(e.conf * 100)} %)  x ${e.board.x.toFixed(1)} / y ${e.board.y.toFixed(1)} mm`, w + 8, y0 + 18);
      g.font = '13px system-ui, sans-serif';
      if (!e.now) g.fillText(e.reasons.join(', ') || 'keine Auffälligkeiten', w + 8, y0 + 36);
      g.font = '12px system-ui, sans-serif'; g.fillText(e.state || '', e.now ? w + 8 : w * 2 + 8, e.now ? y0 + 36 : y0 + 18, e.now ? w * 2 - 16 : w - 16);
      g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillRect(0, y0, 70, 24); g.fillStyle = '#fff'; g.fillText(e.now ? 'leer' : 'vorher', 8, y0 + 17);
    });
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.92));
    if (!blob) return;
    const name = `autodarts180-erkennung-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.jpg`;
    const file = new File([blob], name, { type: 'image/jpeg' });
    try {
      if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: 'Autodarts180 Erkennung' }); return; }
    } catch (e) { if (e?.name === 'AbortError') return; }
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast('Erkennungsbilder gespeichert');
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
    const pd = pending[0];
    const reasons = pd.ev.reasons?.length ? pd.ev.reasons.join(', ') : 'geringe Sicherheit';
    pendingEl.append(h('div', { class: 'pending-box' },
      h('div', { style: { fontWeight: 750 } }, `Unsichere Erkennung: ${pd.dart.label} (${pd.dart.score} Punkte)`),
      h('div', { class: 'small muted' }, `Konfidenz ${Math.round(pd.ev.conf * 100)} % – ${reasons}${pending.length > 1 ? ` · ${pending.length - 1} weitere wartend` : ''}`),
      h('div', { class: 'row', style: { marginTop: '8px' } },
        h('button', { class: 'btn primary sm', onclick: () => resolvePending('confirm') }, icon('check'), 'Bestätigen'),
        h('button', { class: 'btn sm', onclick: () => resolvePending('correct') }, icon('edit'), 'Korrigieren'),
        h('button', { class: 'btn sm ghost', onclick: () => resolvePending('discard') }, icon('x'), 'Kein Pfeil'))));
  }

  function resolvePending(action) {
    const pd = pending.shift();
    if (!pd) return;
    const finish = (dart) => {
      if (pd.replaces) {
        const { li, vi, di } = pd.replaces;
        replaceDart(match, li, vi, di, dart);
        save(); draw(); scheduleBot();
      } else commit(dart);
    };
    // bestätigte Pfeile zeigen der Erkennung, in welche Richtung die Pfeile im Bild stecken
    if (action === 'confirm') detector.learnDirection({ ...pd.ev, conf: 1 });
    if (action === 'discard') detector.forget(pd.ev);
    if (action === 'confirm') finish({ ...pd.dart, confirmed: true });
    else if (action === 'discard') { draw(); }
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
