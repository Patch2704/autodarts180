// Zeichnet die digitale Scheibenkontur und Erkennungen über das Live-Bild.
import { applyH } from './homography.js';
import { R, SEGMENTS } from '../core/board.js';

/** Angezeigter Videobereich innerhalb eines Containers (object-fit: contain) */
export function videoRect(container, aspect) {
  const cw = container.clientWidth, ch = container.clientHeight;
  let w = cw, h = cw / aspect;
  if (h > ch) { h = ch; w = ch * aspect; }
  return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
}

/** Wie videoRect, aber so vergrößert, dass der normierte Ausschnitt vc den Container füllt */
export function zoomRect(container, aspect, vc) {
  const base = videoRect(container, aspect);
  if (!vc) return base;
  const sw = container.clientWidth, sh = container.clientHeight;
  const s = Math.max(1, Math.min(sw / (vc.w * base.w), sh / (vc.h * base.h)));
  const w = base.w * s, h = base.h * s;
  return { x: sw / 2 - (vc.x + vc.w / 2) * w, y: sh / 2 - (vc.y + vc.h / 2) * h, w, h };
}

export function placeVideo(video, rect) {
  Object.assign(video.style, { inset: 'auto', left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px`, objectFit: 'fill' });
}

export function sizeCanvas(canvas, container) {
  const dpr = window.devicePixelRatio || 1;
  const w = container.clientWidth, h = container.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

const toScreen = (H, rect, bx, by) => {
  const p = applyH(H, bx, by);
  return { x: rect.x + p.x * rect.w, y: rect.y + p.y * rect.h };
};

export function drawBoard(ctx, H, rect, { color = 'rgba(61,220,132,0.9)', numbers = true, lineWidth = 1.4 } = {}) {
  ctx.save();
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = color;
  for (const r of [R.DBULL, R.SBULL, R.TRIPLE_IN, R.TRIPLE_OUT, R.DOUBLE_IN, R.DOUBLE_OUT]) {
    ctx.beginPath();
    for (let k = 0; k <= 96; k++) {
      const t = (k / 96) * Math.PI * 2;
      const p = toScreen(H, rect, r * Math.cos(t), r * Math.sin(t));
      if (k) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
    }
    ctx.stroke();
  }
  for (let i = 0; i < 20; i++) {
    const t = ((90 - i * 18 + 9) * Math.PI) / 180;
    const a = toScreen(H, rect, R.SBULL * Math.cos(t), R.SBULL * Math.sin(t));
    const b = toScreen(H, rect, R.DOUBLE_OUT * Math.cos(t), R.DOUBLE_OUT * Math.sin(t));
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  if (numbers) {
    ctx.fillStyle = '#fff';
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    SEGMENTS.forEach((s, i) => {
      const t = ((90 - i * 18) * Math.PI) / 180;
      const p = toScreen(H, rect, 192 * Math.cos(t), 192 * Math.sin(t));
      ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.lineWidth = 3;
      ctx.strokeText(String(s), p.x, p.y);
      ctx.fillText(String(s), p.x, p.y);
    });
  }
  ctx.restore();
}

export function drawMarker(ctx, rect, nx, ny, label, color = '#3ddc84') {
  const x = rect.x + nx * rect.w, y = rect.y + ny * rect.h;
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x - 12, y); ctx.lineTo(x + 12, y); ctx.moveTo(x, y - 12); ctx.lineTo(x, y + 12); ctx.stroke();
  if (label) {
    ctx.font = '700 14px system-ui, sans-serif';
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(x + 10, y - 26, tw + 12, 22);
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + 16, y - 15);
  }
  ctx.restore();
}
