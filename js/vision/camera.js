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

  async start(deviceId) {
    if (!this.supported) throw new Error('Dieser Browser unterstützt keinen Kamerazugriff (HTTPS erforderlich).');
    if (this.stream && this.track?.readyState === 'live' && (!deviceId || deviceId === this.deviceId)) return;
    this.stop();
    const size = { width: { ideal: 1920 }, height: { ideal: 1080 } };
    const video = deviceId ? { deviceId: { exact: deviceId }, ...size } : { facingMode: { ideal: 'environment' }, ...size };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (e) {
      if (!deviceId) throw e;
      // gespeicherte Kamera nicht mehr vorhanden → Standardkamera
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, ...size }, audio: false });
    }
    this.deviceId = this.track?.getSettings?.().deviceId || deviceId || null;
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

  get resolution() {
    return { w: this.video.videoWidth, h: this.video.videoHeight };
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
    const c = crop || { x: 0, y: 0, w: 1, h: 1 };
    const sx = c.x * vw, sy = c.y * vh, sw = c.w * vw, sh = c.h * vh;
    const scale = Math.min(1, maxW / sw);
    const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.ctx.drawImage(this.video, sx, sy, sw, sh, 0, 0, w, h);
    return this.ctx.getImageData(0, 0, w, h);
  }

  /** JPEG-Schnappschuss in voller Auflösung (nur lokal, z. B. für Trainingsdaten) */
  snapshot(quality = 0.85) {
    if (!this.active) return null;
    const c = document.createElement('canvas');
    c.width = this.video.videoWidth; c.height = this.video.videoHeight;
    c.getContext('2d').drawImage(this.video, 0, 0);
    return c.toDataURL('image/jpeg', quality);
  }

  /** Ruft fn() periodisch auf, solange die Kamera läuft */
  startLoop(fn, fps = 10) {
    this.stopLoop();
    const tick = () => {
      if (this.active) { try { fn(); } catch (e) { console.error(e); } }
      this.loopTimer = setTimeout(tick, 1000 / fps);
    };
    tick();
  }

  stopLoop() {
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
