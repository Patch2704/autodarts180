// Kamera: Kalibrierung (Homographie per 4 Punkten, Auto-Erkennung, Feinjustierung, Qualität) und Erkennungstest
import { h, icon, clear, toast, segControl } from '../dom.js';
import { camera } from '../../vision/camera.js';
import { calibration } from '../../state.js';
import {
  CAL_LABELS, homographyFromPoints, pointsFromH, rotateH, scaleH, autoCalibrate, refineOrAuto,
  calibrationQuality, boardVisibility, frameMetrics, boardCrop, cropH, uncropPoint, trackFrame, sharpness, edgeRefine,
} from '../../vision/calibration.js';
import { videoRect, sizeCanvas, drawBoard, drawMarker } from '../../vision/overlay.js';
import { DartDetector } from '../../vision/detector.js';

const CAL_W = 1280; // Auflösung für Kalibrierung und Qualitätsmessung
const VIEW_R = 232; // Radius (mm) des angezeigten Ausschnitts: Scheibe inkl. Zahlenring

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
  let drag = -1, dragScreen = null;
  let quality = null, visibility = null, metrics = null;
  let detector = null, crop = null, lastCropImg = null;
  const detections = [];
  let destroyed = false;
  let busy = false;
  let viewZoom = !!H; // Ansicht auf die Scheibe vergrößern
  let lockedView = null;

  // Angezeigter Videobereich; mit viewZoom wird der Bereich um die Scheibe formatfüllend dargestellt
  function displayRect() {
    const base = videoRect(stage, camera.aspect);
    if (!viewZoom || !H) return base;
    // beim Ziehen eines Punktes bleibt der Bildausschnitt stehen
    if (drag < 0 || !lockedView) lockedView = boardCrop(H, VIEW_R);
    const vc = lockedView;
    const sw = stage.clientWidth, sh = stage.clientHeight;
    const s = Math.max(1, Math.min(sw / (vc.w * base.w), sh / (vc.h * base.h)));
    const w = base.w * s, hh = base.h * s;
    return { x: sw / 2 - (vc.x + vc.w / 2) * w, y: sh / 2 - (vc.y + vc.h / 2) * hh, w, h: hh };
  }
  function placeVideo(rect) {
    Object.assign(camera.video.style, { inset: 'auto', left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px`, objectFit: 'fill' });
  }

  const stage = h('div', { class: 'cam-stage' });
  const canvas = h('canvas', {});
  const empty = h('div', { class: 'cam-empty' }, h('div', {},
    icon('camera'), h('p', {}, 'Stelle das Smartphone seitlich neben die Scheibe, sodass die komplette Scheibe im Bild ist.'),
    h('button', { class: 'btn primary', onclick: () => start() }, icon('camera'), 'Kamera starten')));
  stage.append(canvas, empty);

  const devSel = h('select', { onchange: () => start(devSel.value) });
  const zoomBox = h('div', {});
  const resInfo = h('div', { class: 'small muted' });
  const qText = h('div', { class: 'small' });
  const qBar = h('div', { class: 'qbar' }, h('i', { style: { width: '0%' } }));
  const tools = h('div', { class: 'stack' });
  const testBox = h('div', { class: 'stack' });
  const statusEl = h('div', { class: 'small muted' });

  root.append(
    h('div', { class: 'card', style: { marginBottom: '12px' } },
      segControl([{ value: 'calibrate', label: 'Kalibrierung' }, { value: 'test', label: 'Erkennung testen' }], mode, (v) => { mode = v; setupMode(); })),
    stage,
    h('div', { class: 'card', style: { marginTop: '12px' } },
      h('div', { class: 'grid grid-2 stack-sm' }, h('label', { class: 'field' }, 'Kamera', devSel), zoomBox),
      resInfo,
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

  function fitStage() {
    let a = camera.aspect;
    if (viewZoom && H && camera.active) {
      const vc = boardCrop(H, VIEW_R);
      const { w, h: vh } = camera.resolution;
      a = (vc.w * w) / (vc.h * vh);
    }
    stage.style.aspectRatio = `${a}`;
    stage.style.height = 'auto';
    stage.style.maxWidth = `min(100%, calc(78dvh * ${a}))`;
  }

  async function start(deviceId) {
    try {
      if (deviceId) await camera.start(deviceId);
      else await camera.start(calibration.current?.deviceId || undefined, calibration.current?.label);
    } catch (e) {
      toast(`Kamera konnte nicht gestartet werden: ${e.message}`, 'err');
      return;
    }
    if (destroyed) return;
    empty.remove();
    camera.attach(stage);
    fitStage();
    if (calibration.current?.zoom && camera.zoomInfo()) await camera.setZoom(calibration.current.zoom);
    const devs = await camera.devices();
    clear(devSel);
    devs.forEach((d, i) => devSel.append(h('option', { value: d.deviceId, selected: d.deviceId === camera.deviceId }, d.label || `Kamera ${i + 1}`)));
    drawZoom();
    const { w, h: hh } = camera.resolution;
    resInfo.textContent = `Auflösung ${w}×${hh}`;
    if (!points) { points = defaultPoints(); H = homographyFromPoints(points); }
    setupMode();
    camera.startLoop(onFrame, 8);
  }

  function drawZoom() {
    clear(zoomBox);
    const z = camera.zoomInfo();
    if (!z) {
      zoomBox.append(h('div', { class: 'small muted', style: { alignSelf: 'end' } }, 'Diese Kamera bietet keinen Zoom an. Ist die Scheibe zu klein, das Handy näher stellen oder unter „Kamera“ ein anderes Objektiv wählen.'));
      return;
    }
    const lbl = h('b', { class: 'num' }, `${z.value.toFixed(1)}×`);
    const sl = h('input', { type: 'range', min: z.min, max: Math.min(z.max, 10), step: z.step, value: z.value });
    sl.oninput = async () => { lbl.textContent = `${Number(sl.value).toFixed(1)}×`; await camera.setZoom(Number(sl.value)); };
    sl.onchange = () => toast('Zoom geändert – bitte neu kalibrieren („Automatisch erkennen“)');
    zoomBox.append(h('label', { class: 'field' }, h('span', {}, 'Zoom ', lbl), sl));
  }

  let lastQ = 0;
  // Kontur mitführen (Handy in der Hand): Bewegung von Bild zu Bild verfolgen
  let follow = true, prevTrack = null, lastTrack = 0, sharpPeak = 0;
  function trackStep(now) {
    if (!follow || !H || busy || drag >= 0 || now - lastTrack < 220) return;
    lastTrack = now;
    const img = camera.grab({ maxW: 640 });
    const s = sharpness(img);
    sharpPeak = Math.max(sharpPeak * 0.97, s);
    if (prevTrack) {
      const nh = trackFrame(prevTrack, img, H, { fine: s >= 0.6 * sharpPeak, maxMs: 100 });
      if (nh) { H = nh; points = pointsFromH(H); }
    }
    prevTrack = img;
  }

  function onFrame() {
    if (destroyed) return;
    const now = performance.now();
    if (mode === 'calibrate') trackStep(now);
    if (mode === 'calibrate' && H && now - lastQ > 500 && drag < 0 && !busy) {
      lastQ = now;
      const img = camera.grab({ maxW: CAL_W });
      const q = calibrationQuality(img, H);
      quality = q;
      visibility = boardVisibility(H);
      metrics = frameMetrics(img);
      drawQuality();
    }
    if (mode === 'test' && detector) {
      const img = camera.grab({ crop, maxW: 640 });
      lastCropImg = img;
      const evs = detector.process(img);
      for (const ev of evs) {
        if (ev.type === 'dart') { ev.tipFull = uncropPoint(ev.tip, crop); detections.push(ev); drawTest(); }
        if (ev.type === 'takeout') { detections.length = 0; toast('Pfeile entfernt'); drawTest(); }
        if (ev.type === 'lighting') toast('Lichtveränderung – Referenz aktualisiert');
      }
      statusEl.textContent = `Status: ${detector.status} · Auswertung ${img.width}×${img.height} px`;
    }
    drawOverlay();
  }

  function drawQuality() {
    const q = quality?.score ?? 0;
    qBar.className = `qbar ${q >= 0.85 ? '' : q >= 0.65 ? 'mid' : 'bad'}`;
    qBar.firstChild.style.width = `${Math.round(q * 100)}%`;
    const verdict = q >= 0.85 ? 'gut' : q >= 0.65 ? 'mittel – „Feinjustieren“ drücken oder Punkte nachziehen' : 'schlecht – Kontur liegt nicht auf der Scheibe';
    const parts = [`${Math.round(q * 100)} % (${verdict}). Ringe ${Math.round((quality?.ringScore ?? 0) * 100)} %, Felder ${Math.round((quality?.singleScore ?? 0) * 100)} %.`];
    if (visibility != null && visibility < 0.98) parts.push('⚠ Die Scheibe ist nicht vollständig im Bild.');
    if (metrics && metrics.sharpness < 8) parts.push('⚠ Bild unscharf oder zu dunkel.');
    if (H) {
      const { w, h: vh } = camera.resolution;
      const c = boardCrop(H, 170);
      const px = Math.round(Math.max(c.w * w, c.h * vh));
      if (px < 150) parts.push(`⚠ Die Scheibe ist im Bild nur ca. ${px} px groß – zu klein für eine zuverlässige Kalibrierung (mindestens 150 px, besser über 300 px). Bitte näher stellen oder zoomen.`);
      else if (px < 250) parts.push(`Hinweis: Die Scheibe ist im Bild ca. ${px} px groß. Für eine genaue Pfeilerkennung sind über 300 px besser (näher stellen oder zoomen).`);
    }
    qText.textContent = parts.join(' ');
  }

  function drawOverlay() {
    if (!camera.active || !H) return;
    const rect = displayRect();
    placeVideo(rect);
    const ctx = sizeCanvas(canvas, stage);
    drawBoard(ctx, H, rect, { color: mode === 'test' ? 'rgba(61,220,132,0.35)' : 'rgba(61,220,132,0.95)' });
    if (mode === 'calibrate') {
      points.forEach((p, i) => {
        const x = rect.x + p.x * rect.w, y = rect.y + p.y * rect.h;
        ctx.save();
        ctx.fillStyle = i === drag ? 'rgba(255,77,79,0.35)' : 'rgba(255,77,79,0.85)';
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
        ctx.font = '700 12px system-ui'; ctx.fillStyle = '#fff'; ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.lineWidth = 3;
        ctx.strokeText(CAL_LABELS[i], x + 14, y - 12); ctx.fillText(CAL_LABELS[i], x + 14, y - 12);
        ctx.restore();
      });
      if (drag >= 0) drawLoupe(ctx, rect);
    } else {
      detections.forEach((d) => drawMarker(ctx, rect, d.tipFull.x, d.tipFull.y, `${d.hit.label} – ${d.hit.score}`, d.conf >= 0.6 ? '#3ddc84' : '#f5b83d'));
    }
  }

  // Lupe: zeigt die Umgebung des gezogenen Punktes vergrößert, damit der Finger nicht verdeckt
  function drawLoupe(ctx, rect) {
    const p = points[drag];
    const { w: vw, h: vh } = camera.resolution;
    const SW = stage.clientWidth, SH = stage.clientHeight;
    const L = Math.min(150, SW * 0.4, SH * 0.6), zoom = 4;
    const sx = p.x * vw, sy = p.y * vh;
    const sw = (L / zoom / rect.w) * vw, sh = (L / zoom / rect.h) * vh;
    const px = rect.x + p.x * rect.w;
    const lx = px > SW / 2 ? 10 : SW - L - 10;
    const ly = 10;
    ctx.save();
    ctx.beginPath(); ctx.arc(lx + L / 2, ly + L / 2, L / 2, 0, Math.PI * 2); ctx.clip();
    ctx.drawImage(camera.video, sx - sw / 2, sy - sh / 2, sw, sh, lx, ly, L, L);
    // Kontur in der Lupe
    ctx.translate(lx + L / 2, ly + L / 2); ctx.scale(zoom, zoom); ctx.translate(-px, -(rect.y + p.y * rect.h));
    drawBoard(ctx, H, rect, { color: 'rgba(61,220,132,0.9)', numbers: false, lineWidth: 1.2 / zoom });
    ctx.restore();
    ctx.save();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(lx + L / 2, ly + L / 2, L / 2, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = '#ff4d4f'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(lx + L / 2 - 12, ly + L / 2); ctx.lineTo(lx + L / 2 + 12, ly + L / 2);
    ctx.moveTo(lx + L / 2, ly + L / 2 - 12); ctx.lineTo(lx + L / 2, ly + L / 2 + 12); ctx.stroke();
    ctx.restore();
  }

  // ---------- Ziehen der Kalibrierpunkte (relativ, damit der Finger den Punkt nicht verdeckt) ----------
  const screenPos = (e) => { const b = stage.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };
  let dragStart = null;
  stage.addEventListener('pointerdown', (e) => {
    if (mode !== 'calibrate' || !points || !camera.active) return;
    const rect = displayRect();
    const s = screenPos(e);
    let best = -1, bd = e.pointerType === 'touch' ? 48 : 30;
    points.forEach((q, i) => {
      const d = Math.hypot(rect.x + q.x * rect.w - s.x, rect.y + q.y * rect.h - s.y);
      if (d < bd) { bd = d; best = i; }
    });
    if (best >= 0) {
      drag = best; dragStart = { s, p: { ...points[best] } };
      try { stage.setPointerCapture(e.pointerId); } catch { /* ignorieren */ }
      e.preventDefault();
      drawOverlay();
    }
  });
  stage.addEventListener('pointermove', (e) => {
    if (drag < 0) return;
    const rect = displayRect();
    const s = screenPos(e);
    // Feinsteuerung: Fingerbewegung wird halbiert übertragen
    const k = e.pointerType === 'touch' ? 0.5 : 1;
    const nx = dragStart.p.x + ((s.x - dragStart.s.x) / rect.w) * k;
    const ny = dragStart.p.y + ((s.y - dragStart.s.y) / rect.h) * k;
    const np = points.map((q, i) => (i === drag ? { x: Math.min(1.2, Math.max(-0.2, nx)), y: Math.min(1.2, Math.max(-0.2, ny)) } : q));
    const nh = homographyFromPoints(np);
    if (nh) { points = np; H = nh; drawOverlay(); }
  });
  const endDrag = () => { if (drag >= 0) { drag = -1; prevTrack = null; drawOverlay(); } };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);

  const apply = (nh) => { if (nh) { H = nh; points = pointsFromH(H); drawOverlay(); } };

  async function runAuto(fromCurrent) {
    if (busy || !camera.active) return;
    busy = true;
    try {
      // Etwa eine Sekunde lang Bilder sammeln und das schärfste nehmen (wichtig mit Handy in der Hand)
      toast('Handy kurz ruhig halten …');
      let img = null, best = -1;
      for (let k = 0; k < 9 && !destroyed; k++) {
        const f = camera.grab({ maxW: CAL_W });
        const s = sharpness(f);
        if (s > best) { best = s; img = new ImageData(new Uint8ClampedArray(f.data), f.width, f.height); }
        await new Promise((r) => setTimeout(r, 110));
      }
      if (!img || destroyed) return;
      toast(fromCurrent ? 'Feinjustierung läuft …' : 'Suche Scheibe …');
      await new Promise((r) => setTimeout(r, 30));
      const r = fromCurrent ? refineOrAuto(img, points) : autoCalibrate(img);
      if (!r || !r.H) { toast('Keine Scheibe gefunden – Punkte grob von Hand setzen und dann „Feinjustieren“', 'err'); return; }
      const before = fromCurrent ? calibrationQuality(img, H).score : 0;
      const after = calibrationQuality(img, r.H).score;
      if (fromCurrent && after < before) { toast('Keine Verbesserung gefunden'); return; }
      // Während der Berechnung kann sich das Handy bewegt haben → auf das aktuelle Bild übertragen
      const now = camera.grab({ maxW: 640 });
      const Hnow = trackFrame(img, now, r.H, { maxMs: 250 }) || r.H;
      H = Hnow; points = pointsFromH(H); lastQ = 0;
      prevTrack = now;
      viewZoom = true;
      setupMode();
      drawOverlay();
      toast(`Qualität ${Math.round(after * 100)} % – prüfe, ob die 20 oben liegt`, after >= 0.85 ? 'ok' : '');
    } finally { busy = false; }
  }

  // ---------- Werkzeuge ----------
  function setupMode() {
    clear(tools); clear(testBox);
    if (camera.active) fitStage();
    if (mode === 'calibrate') {
      detector = null;
      tools.append(
        h('div', { class: 'small muted' }, 'Am einfachsten: „Automatisch erkennen“ – das Handy dabei aufrecht stellen (nicht seitlich gekippt), dann landet die 20 automatisch oben. Steht die 20 trotzdem an der falschen Stelle, mit „20 ◀ / 20 ▶“ korrigieren. Liegt die Kontur noch nicht genau, die vier roten Punkte grob auf die Stellen ziehen, an denen die Drähte zwischen 20|1, 6|10, 3|19 und 11|14 den äußeren Rand des Doppelrings treffen, und dann „Feinjustieren“ drücken. Beim Ziehen zeigt eine Lupe die Stelle vergrößert.'),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', disabled: !camera.active, onclick: () => runAuto(false) }, icon('wand'), 'Automatisch erkennen'),
          h('button', { class: 'btn', disabled: !camera.active, onclick: () => runAuto(true) }, icon('target'), 'Feinjustieren'),
          h('button', { class: 'btn', disabled: !camera.active, onclick: () => { viewZoom = !viewZoom; setupMode(); drawOverlay(); } }, viewZoom ? 'Ganzes Bild zeigen' : 'Auf Scheibe zoomen'),
          h('button', { class: `btn ${follow ? 'primary' : ''}`, title: 'Kontur folgt dem Bild, wenn sich das Handy bewegt (z. B. in der Hand gehalten)', onclick: () => { follow = !follow; prevTrack = null; setupMode(); } }, follow ? 'Kontur folgt: an' : 'Kontur folgt: aus')),
        h('div', { class: 'row' },
          h('button', { class: 'btn', title: 'Zahlen um zwei Segmente nach links drehen', onclick: () => apply(rotateH(H, 36)) }, icon('rotl'), '20 ◀'),
          h('button', { class: 'btn', title: 'Zahlen um zwei Segmente nach rechts drehen', onclick: () => apply(rotateH(H, -36)) }, '20 ▶', icon('rotr')),
          h('button', { class: 'btn', onclick: () => apply(rotateH(H, 1)) }, icon('rotl'), '1°'),
          h('button', { class: 'btn', onclick: () => apply(rotateH(H, -1)) }, icon('rotr'), '1°'),
          h('button', { class: 'btn', onclick: () => apply(scaleH(H, 1.01)) }, '+ Größer'),
          h('button', { class: 'btn', onclick: () => apply(scaleH(H, 1 / 1.01)) }, '− Kleiner'),
          h('button', { class: 'btn ghost', onclick: () => { points = defaultPoints(); H = homographyFromPoints(points); drawOverlay(); } }, 'Zurücksetzen')),
        h('div', { class: 'row' },
          h('button', { class: 'btn ghost sm', disabled: !camera.active, onclick: exportFrame, title: 'Unbearbeitetes Kamerabild speichern, z. B. um es zur Fehleranalyse weiterzugeben' }, icon('download'), 'Kamerabild speichern')),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', disabled: !camera.active, onclick: saveCal }, icon('check'), 'Kalibrierung speichern'),
          calibration.current ? h('span', { class: 'small muted' }, `Gespeichert: ${new Date(calibration.current.createdAt).toLocaleString('de-DE')} · Qualität ${Math.round((calibration.current.quality || 0) * 100)} %`) : h('span', { class: 'small muted' }, 'Noch keine Kalibrierung gespeichert.')));
    } else {
      if (!camera.active) { tools.append(h('div', { class: 'notice' }, 'Bitte zuerst die Kamera starten.')); return; }
      detector = new DartDetector();
      crop = boardCrop(H);
      const img = camera.grab({ crop, maxW: 640 });
      detector.setCalibration(cropH(H, crop), img.width, img.height);
      detections.length = 0;
      tools.append(
        h('div', { class: 'small muted' }, 'Wirf Pfeile auf die Scheibe. Jeder neue Pfeil wird nach dem Stillstand des Bildes ausgewertet und markiert. Nach dem Herausziehen setzt sich die Erkennung automatisch zurück. Ausgewertet wird nur der Bildausschnitt um die Scheibe.'),
        statusEl,
        h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => { if (lastCropImg) detector.rebase(lastCropImg); detections.length = 0; drawTest(); } }, icon('hand'), 'Referenz neu setzen')));
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

  // Unbearbeitetes Kamerabild (ohne Linien/Punkte) – bleibt lokal, bis du es selbst weitergibst
  async function exportFrame() {
    const blob = await camera.rawFrameBlob();
    if (!blob) return;
    const name = `autodarts180-kamerabild-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.jpg`;
    const file = new File([blob], name, { type: 'image/jpeg' });
    try {
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Autodarts180 Kamerabild' });
        return;
      }
    } catch (e) {
      if (e?.name === 'AbortError') return;
    }
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast('Kamerabild gespeichert');
  }

  async function saveCal() {
    if (!H || !camera.active) return;
    const full = camera.grab({ maxW: CAL_W });
    // Vor dem Speichern: Ring- und Drahtkanten auf dem vollen Bild vermessen (höchste Genauigkeit)
    const er = edgeRefine(full, H);
    if (er) { H = er.H; points = pointsFromH(H); }
    const q = calibrationQuality(full, H).score;
    const vis = boardVisibility(H);
    if (vis < 0.98) toast('Achtung: Die Scheibe ist nicht vollständig im Bild', 'err');
    // Vergleichswerte genau so messen, wie es die Kamerakontrolle im Spiel tut (Ausschnitt, 640 px)
    const c = boardCrop(H);
    const cropImg = camera.grab({ crop: c, maxW: 640 });
    const cm = frameMetrics(cropImg);
    const cropQuality = calibrationQuality(cropImg, cropH(H, c)).score;
    const z = camera.zoomInfo();
    await calibration.save({
      H, points, quality: q, cropQuality, brightness: cm.brightness, sharpness: cm.sharpness,
      deviceId: camera.deviceId, label: camera.label, aspect: camera.aspect, resolution: camera.resolution,
      zoom: z ? z.value : null, createdAt: Date.now(), version: 3,
    });
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
