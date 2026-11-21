// Kameradienst: ein gemeinsamer Videostream für Kalibrierung und Spiel.
// Die Bilder bleiben auf dem Gerät – es gibt keine Übertragung an Server.

const PROC_W = 480;

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

  async start(deviceId) {
    if (!this.supported) throw new Error('Dieser Browser unterstützt keinen Kamerazugriff (HTTPS erforderlich).');
    if (this.stream && (!deviceId || deviceId === this.deviceId)) return;
    this.stop();
    const video = deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
      : { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } };
    this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    this.deviceId = this.stream.getVideoTracks()[0]?.getSettings?.().deviceId || deviceId || null;
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

  get procSize() {
    const w = PROC_W;
    return { w, h: Math.round(w / this.aspect) };
  }

  /** Aktuelles Frame in Verarbeitungsauflösung */
  grab() {
    if (!this.active) return null;
    const { w, h } = this.procSize;
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.ctx.drawImage(this.video, 0, 0, w, h);
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

  startLoop(fn, fps = 10) {
    this.stopLoop();
    const tick = () => {
      if (this.active) {
        const img = this.grab();
        if (img) { try { fn(img); } catch (e) { console.error(e); } }
      }
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
    container.prepend(this.video);
    if (this.stream && this.video.paused) this.video.play().catch(() => {});
  }
}

export const camera = new CameraService();
