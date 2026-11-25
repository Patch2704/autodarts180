// Kameradienst: ein gemeinsamer Videostream für Kalibrierung und Spiel.
// Die Bilder bleiben auf dem Gerät – es gibt keine Übertragung an Server.

class CameraService {
  constructor() {
    this.stream = null;
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.setAttribute('playsinline', '');
    this.video.className = 'cam-video';
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.loopTimer = null;
    this.deviceId = null;
  }

  get supported() {
    return !!navigator.mediaDevices?.getUserMedia;
  }

  get active() {
    return !!this.stream && this.video.readyState >= 2;
  }

  get track() {
    return this.stream?.getVideoTracks()[0] || null;
  }

  /**
   * Startet die Kamera. deviceId/label: gespeicherte Kamera. Manche Browser (v. a. iOS) vergeben
   * Geräte-IDs pro Sitzung neu – dann wird die Kamera über ihren Namen wiedergefunden.
   * this.fellBack = true, wenn die gewünschte Kamera nicht gefunden wurde.
   */
  async start(deviceId, label) {
    if (!this.supported) throw new Error('Dieser Browser unterstützt keinen Kamerazugriff (HTTPS erforderlich).');
    if (this.stream && this.track?.readyState === 'live' && (!deviceId || deviceId === this.deviceId)) return;
    this.stop();
    this.fellBack = false;
    const size = { width: { ideal: 1920 }, height: { ideal: 1080 } };
    const open = (video) => navigator.mediaDevices.getUserMedia({ video: { ...video, ...size }, audio: false });
    if (!deviceId) {
      this.stream = await open({ facingMode: { ideal: 'environment' } });
    } else {
      try {
        this.stream = await open({ deviceId: { exact: deviceId } });
      } catch (e) {
        let found = null;
        if (label) {
          // Berechtigung besteht bereits → Namen sind sichtbar
          const tmp = await open({ facingMode: { ideal: 'environment' } });
          const devs = (await this.devices()).filter((d) => d.label === label);
          if (devs.length && devs[0].deviceId !== tmp.getVideoTracks()[0]?.getSettings?.().deviceId) {
            tmp.getTracks().forEach((t) => t.stop());
            try { found = await open({ deviceId: { exact: devs[0].deviceId } }); } catch { found = null; }
          } else if (devs.length) found = tmp;
          else tmp.getTracks().forEach((t) => t.stop());
        }
        if (!found) { found = await open({ facingMode: { ideal: 'environment' } }); this.fellBack = true; }
        this.stream = found;
      }
    }
    this.deviceId = this.track?.getSettings?.().deviceId || deviceId || null;
    this.startedAt = performance.now();
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    await new Promise((res) => {
      if (this.video.readyState >= 2) return res();
      this.video.onloadeddata = () => res();
    });
  }

  stop() {
    this.stopLoop();
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  async devices() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'videoinput');
  }

  get aspect() {
    return this.video.videoWidth && this.video.videoHeight ? this.video.videoWidth / this.video.videoHeight : 16 / 9;
  }

  get label() {
    return this.track?.label || '';
  }

  get resolution() {
    return { w: this.video.videoWidth, h: this.video.videoHeight };
  }

  /**
   * Hält Schärfe und Weißabgleich auf dem aktuellen Stand fest, damit das Bild im Spiel
   * nicht „pumpt“. Nur wenn der Browser es unterstützt (v. a. Chrome/Android); sonst false.
   */
  async lockSettings() {
    const t = this.track;
    const caps = t?.getCapabilities?.() || {};
    const adv = {};
    if (caps.focusMode?.includes('manual')) adv.focusMode = 'manual';
    if (caps.whiteBalanceMode?.includes('manual')) adv.whiteBalanceMode = 'manual';
    if (!Object.keys(adv).length) return false;
    try { await t.applyConstraints({ advanced: [adv] }); return true; } catch { return false; }
  }

  /** Kamera-Zoom (falls das Gerät ihn anbietet, v. a. Android/Chrome) */
  zoomInfo() {
    const t = this.track;
    const caps = t?.getCapabilities?.();
    if (!caps?.zoom || caps.zoom.max <= caps.zoom.min) return null;
    return { min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step || 0.1, value: t.getSettings().zoom ?? caps.zoom.min };
  }

  async setZoom(z) {
    const t = this.track;
    if (!t || !this.zoomInfo()) return false;
    try { await t.applyConstraints({ advanced: [{ zoom: z }] }); return true; } catch { return false; }
  }

  /**
   * Aktuelles Frame als ImageData.
   * crop: normierter Ausschnitt {x,y,w,h} (Standard: ganzes Bild); maxW: maximale Breite des Ergebnisses.
   */
  grab({ crop = null, maxW = 640 } = {}) {
    if (!this.active) return null;
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    // Erst das komplette Videobild zeichnen (5-Argument-Form ist auf allen Browsern
    // korrekt ausgerichtet; Quell-Rechtecke direkt aus dem Video werden auf iOS teils verzerrt),
    // dann aus dieser Kopie ausschneiden.
    if (!this.full) {
      this.full = document.createElement('canvas');
      this.fullCtx = this.full.getContext('2d', { willReadFrequently: false });
    }
    if (this.full.width !== vw || this.full.height !== vh) { this.full.width = vw; this.full.height = vh; }
    this.fullCtx.drawImage(this.video, 0, 0, vw, vh);
    const c = crop || { x: 0, y: 0, w: 1, h: 1 };
    const sx = c.x * vw, sy = c.y * vh, sw = c.w * vw, sh = c.h * vh;
    const scale = Math.min(1, maxW / sw);
    const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.ctx.drawImage(this.full, sx, sy, sw, sh, 0, 0, w, h);
    return this.ctx.getImageData(0, 0, w, h);
  }

  /** Unbearbeitetes Vollbild als JPEG-Blob (für Diagnose-Export) */
  async rawFrameBlob(quality = 0.92) {
    if (!this.active) return null;
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    const c = document.createElement('canvas');
    c.width = vw; c.height = vh;
    c.getContext('2d').drawImage(this.video, 0, 0, vw, vh);
    return new Promise((res) => c.toBlob(res, 'image/jpeg', quality));
  }

  /** JPEG-Schnappschuss in voller Auflösung (nur lokal, z. B. für Trainingsdaten) */
  snapshot(quality = 0.85) {
    if (!this.active) return null;
    const c = document.createElement('canvas');
    c.width = this.video.videoWidth; c.height = this.video.videoHeight;
    c.getContext('2d').drawImage(this.video, 0, 0);
    return c.toDataURL('image/jpeg', quality);
  }

  /**
   * Zählt neue Videobilder (wo der Browser das meldet). Ohne das würde dasselbe Bild mehrfach ausgewertet, wenn die
   * Kamera stockt – ein Pfeil im Flug sähe dann aus, als stünde er still.
   */
  watchFrames() {
    const v = this.video;
    if (!v.requestVideoFrameCallback) return;
    const run = (this.watchRun = (this.watchRun || 0) + 1); // jeder Start zählt neu, alte Rückrufe laufen aus
    const cb = () => { if (run !== this.watchRun || !this.loopOn) return; this.frameNo = (this.frameNo || 0) + 1; this.frameAt = performance.now(); v.requestVideoFrameCallback(cb); };
    v.requestVideoFrameCallback(cb);
  }

  /** Neues Bild seit dem letzten Aufruf? (meldet der Browser keine Bilder: immer ja) */
  nextFrame() {
    const now = performance.now();
    if (!this.frameAt || now - this.frameAt > 700) return true;
    if (this.frameNo === this.usedNo) return false;
    this.usedNo = this.frameNo;
    return true;
  }

  /** Ruft fn() periodisch auf, solange die Kamera läuft; die Rechenzeit zählt zum Takt */
  startLoop(fn, fps = 10) {
    this.stopLoop();
    this.loopOn = true; this.frameAt = 0;
    this.watchFrames();
    const tick = () => {
      const t0 = performance.now();
      let wait = 15;
      if (this.active && this.nextFrame()) {
        try { fn(); } catch (e) { console.error(e); }
        wait = Math.max(10, 1000 / fps - (performance.now() - t0));
      }
      if (this.loopOn) this.loopTimer = setTimeout(tick, wait);
    };
    tick();
  }

  stopLoop() {
    this.loopOn = false;
    clearTimeout(this.loopTimer);
    this.loopTimer = null;
  }

  /** Video in einen Container einhängen (wird beim Ansichtswechsel umgehängt) */
  attach(container) {
    this.video.removeAttribute('style');
    container.prepend(this.video);
    if (this.stream && this.video.paused) this.video.play().catch(() => {});
  }
}

export const camera = new CameraService();
