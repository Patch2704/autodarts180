// Kamera: Kalibrierung (Homographie per 4 Punkten, Auto-Schätzung, Qualität) und Erkennungstest
import { h, icon, clear, toast, segControl } from '../dom.js';
import { camera } from '../../vision/camera.js';
import { calibration } from '../../state.js';
import {
  CAL_LABELS, homographyFromPoints, pointsFromH, rotateH, scaleH, autoGuess,
  calibrationQuality, boardVisibility, frameMetrics,
} from '../../vision/calibration.js';
import { videoRect, sizeCanvas, drawBoard, drawMarker } from '../../vision/overlay.js';
import { DartDetector } from '../../vision/detector.js';

export async function render(root) {
  root.append(h('div', { class: 'page-head' }, h('h1', {}, 'Kamera'),
    h('span', { class: 'small muted' }, 'Bilder werden ausschließlich lokal auf diesem Gerät verarbeitet.')));

  if (!camera.supported) {
    root.append(h('div', { class: 'notice err' },
      'Kein Kamerazugriff möglich. Browser erlauben die Kamera nur über HTTPS (oder localhost). ',
      'Öffne Autodarts180 über eine HTTPS-Adresse oder als installierte App.'));
    return;
  }

  let mode = 'calibrate';
  let H = calibration.current?.H || null;
  let points = H ? pointsFromH(H) : null;
  let drag = -1;
  let quality = null, visibility = null, metrics = null;
  let lastImg = null;
  let detector = null;
  const detections = [];
  let destroyed = false;

  const stage = h('div', { class: 'cam-stage' });
  const canvas = h('canvas', {});
  const empty = h('div', { class: 'cam-empty' }, h('div', {},
    icon('camera'), h('p', {}, 'Stelle das Smartphone seitlich neben die Scheibe, sodass die komplette Scheibe im Bild ist.'),
    h('button', { class: 'btn primary', onclick: () => start() }, icon('camera'), 'Kamera starten')));
  stage.append(canvas, empty);

  const devSel = h('select', { onchange: () => start(devSel.value) });
  const qText = h('div', { class: 'small' });
  const qBar = h('div', { class: 'qbar' }, h('i', { style: { width: '0%' } }));
  const tools = h('div', { class: 'stack' });
  const testBox = h('div', { class: 'stack' });

  root.append(
    h('div', { class: 'card', style: { marginBottom: '12px' } },
      segControl([{ value: 'calibrate', label: 'Kalibrierung' }, { value: 'test', label: 'Erkennung testen' }], mode, (v) => { mode = v; setupMode(); })),
    stage,
    h('div', { class: 'card', style: { marginTop: '12px' } },
      h('div', { class: 'row between' }, h('label', { class: 'field', style: { flex: 1, minWidth: '200px' } }, 'Kamera', devSel)),
      h('div', { class: 'quality', style: { marginTop: '12px' } }, h('span', { class: 'small muted', style: { width: '120px' } }, 'Kalibrierqualität'), qBar),
      qText),
    h('div', { class: 'card' }, tools, testBox));

  function defaultPoints() {
    const a = camera.aspect, r = 0.36;
    return [81, -9, 261, 171].map((deg) => {
      const t = (deg * Math.PI) / 180;
      return { x: 0.5 + (r * Math.cos(t)) / a, y: 0.5 - r * Math.sin(t) };
    });
  }

  async function start(deviceId) {
    try {
      await camera.start(deviceId || calibration.current?.deviceId || undefined);
    } catch (e) {
      toast(`Kamera konnte nicht gestartet werden: ${e.message}`, 'err');
      return;
    }
    if (destroyed) return;
    empty.remove();
    camera.attach(stage);
    const devs = await camera.devices();
    clear(devSel);
    devs.forEach((d, i) => devSel.append(h('option', { value: d.deviceId, selected: d.deviceId === camera.deviceId }, d.label || `Kamera ${i + 1}`)));
    if (!points) { points = defaultPoints(); H = homographyFromPoints(points); }
    setupMode();
    camera.startLoop(onFrame, 8);
  }

  let lastQ = 0;
  function onFrame(img) {
    if (destroyed) return;
    lastImg = img;
    const now = performance.now();
    if (H && now - lastQ > 400) {
      lastQ = now;
      quality = calibrationQuality(img, H).score;
      visibility = boardVisibility(H);
      metrics = frameMetrics(img);
      drawQuality();
    }
    if (mode === 'test' && detector) {
      const evs = detector.process(img);
      for (const ev of evs) {
        if (ev.type === 'dart') { detections.push(ev); drawTest(); }
        if (ev.type === 'takeout') { detections.length = 0; toast('Pfeile entfernt'); drawTest(); }
        if (ev.type === 'lighting') toast('Lichtveränderung – Referenz aktualisiert');
      }
      statusEl.textContent = `Status: ${detector.status}`;
    }
    drawOverlay();
  }

  function drawQuality() {
    const q = quality ?? 0;
    qBar.className = `qbar ${q >= 0.85 ? '' : q >= 0.65 ? 'mid' : 'bad'}`;
    qBar.firstChild.style.width = `${Math.round(q * 100)}%`;
    const parts = [`${Math.round(q * 100)} % der Prüfpunkte passen (${q >= 0.85 ? 'gut' : q >= 0.65 ? 'mittel – Punkte nachjustieren' : 'schlecht – Kontur liegt nicht auf der Scheibe'})`];
    if (visibility != null && visibility < 0.98) parts.push('⚠ Die Scheibe ist nicht vollständig im Bild.');
    if (metrics && metrics.sharpness < 15) parts.push('⚠ Bild unscharf oder zu dunkel.');
    qText.textContent = parts.join(' ');
    qText.className = `small ${q >= 0.85 ? 'muted' : ''}`;
  }

  function drawOverlay() {
    if (!camera.active || !H) return;
    const rect = videoRect(stage, camera.aspect);
    const ctx = sizeCanvas(canvas, stage);
    drawBoard(ctx, H, rect, { color: mode === 'test' ? 'rgba(61,220,132,0.35)' : 'rgba(61,220,132,0.95)' });
    if (mode === 'calibrate') {
      points.forEach((p, i) => {
        const x = rect.x + p.x * rect.w, y = rect.y + p.y * rect.h;
        ctx.save();
        ctx.fillStyle = i === drag ? '#ff4d4f' : 'rgba(255,77,79,0.85)';
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
        ctx.font = '700 12px system-ui'; ctx.fillStyle = '#fff'; ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.lineWidth = 3;
        ctx.strokeText(CAL_LABELS[i], x + 14, y - 12); ctx.fillText(CAL_LABELS[i], x + 14, y - 12);
        ctx.restore();
      });
    } else {
      detections.forEach((d) => drawMarker(ctx, rect, d.tip.x, d.tip.y, `${d.hit.label} – ${d.hit.score}`, d.conf >= 0.6 ? '#3ddc84' : '#f5b83d'));
    }
  }

  // ---------- Ziehen der Kalibrierpunkte ----------
  const toNorm = (e) => {
    const rect = videoRect(stage, camera.aspect);
    const b = stage.getBoundingClientRect();
    return { x: (e.clientX - b.left - rect.x) / rect.w, y: (e.clientY - b.top - rect.y) / rect.h, rect };
  };
  stage.addEventListener('pointerdown', (e) => {
    if (mode !== 'calibrate' || !points || !camera.active) return;
    const p = toNorm(e);
    let best = -1, bd = 40;
    points.forEach((q, i) => {
      const d = Math.hypot((q.x - p.x) * p.rect.w, (q.y - p.y) * p.rect.h);
      if (d < bd) { bd = d; best = i; }
    });
    if (best >= 0) { drag = best; stage.setPointerCapture(e.pointerId); e.preventDefault(); }
  });
  stage.addEventListener('pointermove', (e) => {
    if (drag < 0) return;
    const p = toNorm(e);
    const np = points.map((q, i) => (i === drag ? { x: Math.min(1.2, Math.max(-0.2, p.x)), y: Math.min(1.2, Math.max(-0.2, p.y)) } : q));
    const nh = homographyFromPoints(np);
    if (nh) { points = np; H = nh; drawOverlay(); }
  });
  const endDrag = () => { drag = -1; drawOverlay(); };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);

  const apply = (nh) => { if (nh) { H = nh; points = pointsFromH(H); drawOverlay(); } };

  // ---------- Werkzeuge ----------
  const statusEl = h('div', { class: 'small muted' });
  function setupMode() {
    clear(tools); clear(testBox);
    if (mode === 'calibrate') {
      detector = null;
      tools.append(
        h('div', { class: 'small muted' }, 'Ziehe die vier roten Punkte auf die Stellen, an denen die Drähte zwischen 20|1, 6|10, 3|19 und 11|14 auf den äußeren Rand des Doppelrings treffen. Die grüne Kontur muss danach genau auf der Scheibe liegen.'),
        h('div', { class: 'row' },
          h('button', { class: 'btn', disabled: !camera.active, onclick: () => {
            if (!lastImg) return;
            const g = autoGuess(lastImg);
            if (!g) { toast('Keine Scheibe erkannt – bitte Punkte manuell setzen', 'err'); return; }
            const nh = homographyFromPoints(g);
            if (nh) { points = g; H = nh; drawOverlay(); toast('Scheibe gefunden – Drehung und Punkte prüfen'); }
          } }, icon('wand'), 'Automatisch erkennen'),
          h('button', { class: 'btn', onclick: () => apply(rotateH(H, 18)) }, icon('rotl'), '18°'),
          h('button', { class: 'btn', onclick: () => apply(rotateH(H, 1)) }, icon('rotl'), '1°'),
          h('button', { class: 'btn', onclick: () => apply(rotateH(H, -1)) }, icon('rotr'), '1°'),
          h('button', { class: 'btn', onclick: () => apply(rotateH(H, -18)) }, icon('rotr'), '18°'),
          h('button', { class: 'btn', onclick: () => apply(scaleH(H, 1.01)) }, '+ Größer'),
          h('button', { class: 'btn', onclick: () => apply(scaleH(H, 1 / 1.01)) }, '− Kleiner'),
          h('button', { class: 'btn ghost', onclick: () => { points = defaultPoints(); H = homographyFromPoints(points); drawOverlay(); } }, 'Zurücksetzen')),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', disabled: !camera.active, onclick: saveCal }, icon('check'), 'Kalibrierung speichern'),
          calibration.current ? h('span', { class: 'small muted' }, `Gespeichert: ${new Date(calibration.current.createdAt).toLocaleString('de-DE')} · Qualität ${Math.round((calibration.current.quality || 0) * 100)} %`) : h('span', { class: 'small muted' }, 'Noch keine Kalibrierung gespeichert.')));
    } else {
      if (!camera.active) { tools.append(h('div', { class: 'notice' }, 'Bitte zuerst die Kamera starten.')); return; }
      detector = new DartDetector();
      const { w, h: hh } = camera.procSize;
      detector.setCalibration(H, w, hh);
      detections.length = 0;
      tools.append(
        h('div', { class: 'small muted' }, 'Wirf Pfeile auf die Scheibe. Jeder neue Pfeil wird nach dem Stillstand des Bildes ausgewertet und markiert. Nach dem Herausziehen setzt sich die Erkennung automatisch zurück.'),
        statusEl,
        h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => { if (lastImg) detector.rebase(lastImg); detections.length = 0; drawTest(); } }, icon('hand'), 'Referenz neu setzen')));
      drawTest();
    }
  }

  function drawTest() {
    clear(testBox);
    if (mode !== 'test') return;
    if (!detections.length) { testBox.append(h('div', { class: 'small muted' }, 'Noch keine Pfeile erkannt.')); return; }
    testBox.append(h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Feld'), h('th', { class: 'r' }, 'Punkte'), h('th', { class: 'r' }, 'Konfidenz'), h('th', {}, 'Hinweise'))),
      h('tbody', {}, detections.map((d, i) => h('tr', {},
        h('td', {}, i + 1), h('td', {}, h('b', {}, d.hit.label)), h('td', { class: 'r' }, d.hit.score),
        h('td', { class: 'r' }, `${Math.round(d.conf * 100)} %`), h('td', { class: 'small muted' }, d.reasons.join(', ') || '–'))))));
  }

  async function saveCal() {
    if (!lastImg || !H) return;
    const q = calibrationQuality(lastImg, H).score;
    const m = frameMetrics(lastImg);
    const vis = boardVisibility(H);
    if (vis < 0.98) toast('Achtung: Die Scheibe ist nicht vollständig im Bild', 'err');
    await calibration.save({ H, points, quality: q, brightness: m.brightness, sharpness: m.sharpness, deviceId: camera.deviceId, aspect: camera.aspect, createdAt: Date.now() });
    toast(`Kalibrierung gespeichert (Qualität ${Math.round(q * 100)} %)`, 'ok');
    setupMode();
  }

  const onResize = () => drawOverlay();
  window.addEventListener('resize', onResize);
  if (camera.stream) start();
  setupMode();

  return () => {
    destroyed = true;
    camera.stop();
    window.removeEventListener('resize', onResize);
  };
}
