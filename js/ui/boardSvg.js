// Digitale Dartscheibe als SVG (für Heatmap und Trefferanzeige)
import { svgEl } from './dom.js';
import { R, SEGMENTS } from '../core/board.js';

const pol = (r, deg) => [r * Math.cos((deg * Math.PI) / 180), -r * Math.sin((deg * Math.PI) / 180)];

function wedge(r1, r2, a1, a2) {
  const [x1, y1] = pol(r2, a1), [x2, y2] = pol(r2, a2), [x3, y3] = pol(r1, a2), [x4, y4] = pol(r1, a1);
  return `M${x1},${y1} A${r2},${r2} 0 0 1 ${x2},${y2} L${x3},${y3} A${r1},${r1} 0 0 0 ${x4},${y4} Z`;
}

/** Erzeugt ein SVG der Scheibe. dim=true → gedämpfte Farben (für Heatmap) */
export function boardSvg({ dim = false } = {}) {
  const svg = svgEl('svg', { viewBox: '-230 -230 460 460', class: 'board-svg' });
  const op = dim ? 0.35 : 1;
  svg.append(svgEl('circle', { r: 228, fill: '#0b0c0d' }));
  SEGMENTS.forEach((seg, i) => {
    const a2 = 90 - i * 18 + 9, a1 = a2 - 18;
    const even = i % 2 === 0;
    const single = even ? '#1c1c1c' : '#e9dfc5';
    const ring = even ? '#d63a3a' : '#1f9d55';
    const add = (r1, r2, fill) => svg.append(svgEl('path', { d: wedge(r1, r2, a2, a1), fill, 'fill-opacity': op, stroke: '#888', 'stroke-opacity': 0.35, 'stroke-width': 0.6 }));
    add(R.SBULL, R.TRIPLE_IN, single);
    add(R.TRIPLE_IN, R.TRIPLE_OUT, ring);
    add(R.TRIPLE_OUT, R.DOUBLE_IN, single);
    add(R.DOUBLE_IN, R.DOUBLE_OUT, ring);
    const [tx, ty] = pol(196, 90 - i * 18);
    const t = svgEl('text', { x: tx, y: ty, fill: '#cfd5db', 'font-size': 18, 'font-weight': 700, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': 'system-ui, sans-serif' });
    t.textContent = seg;
    svg.append(t);
  });
  svg.append(svgEl('circle', { r: R.SBULL, fill: '#1f9d55', 'fill-opacity': op, stroke: '#888', 'stroke-opacity': 0.35 }));
  svg.append(svgEl('circle', { r: R.DBULL, fill: '#d63a3a', 'fill-opacity': op }));
  return svg;
}

/** Heatmap: Dichte per Gauß-Kernel auf Raster, eingefärbt (selten → häufig) */
export function heatmapSvg(darts) {
  const svg = boardSvg({ dim: true });
  if (!darts.length) return svg;
  const cell = 6, half = 230, n = Math.ceil((2 * half) / cell);
  const grid = new Float32Array(n * n);
  const sig = 7, rad = Math.ceil((3 * sig) / cell);
  for (const d of darts) {
    const cx = Math.floor((d.x + half) / cell), cy = Math.floor((half - d.y) / cell);
    for (let j = -rad; j <= rad; j++) for (let i = -rad; i <= rad; i++) {
      const x = cx + i, y = cy + j;
      if (x < 0 || y < 0 || x >= n || y >= n) continue;
      const dx = (x + 0.5) * cell - half - d.x, dy = half - (y + 0.5) * cell - d.y;
      grid[y * n + x] += Math.exp(-(dx * dx + dy * dy) / (2 * sig * sig));
    }
  }
  let max = 0;
  for (const v of grid) if (v > max) max = v;
  const g = svgEl('g', { style: 'mix-blend-mode:screen' });
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const v = grid[y * n + x] / max;
    if (v < 0.04) continue;
    g.append(svgEl('rect', { x: x * cell - half, y: y * cell - half, width: cell + 0.3, height: cell + 0.3, fill: heatColor(v), 'fill-opacity': Math.min(0.95, 0.25 + v * 0.8) }));
  }
  svg.append(g);
  if (darts.length <= 400) {
    for (const d of darts) svg.append(svgEl('circle', { cx: d.x, cy: -d.y, r: 1.6, fill: '#fff', 'fill-opacity': 0.8 }));
  }
  return svg;
}

function heatColor(v) {
  // blau → grün → gelb → rot
  const stops = [[0, [40, 90, 255]], [0.35, [47, 210, 122]], [0.65, [245, 210, 60]], [1, [255, 60, 60]]];
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const [a, ca] = stops[i - 1], [b, cb] = stops[i];
      const t = (v - a) / (b - a);
      const c = ca.map((x, k) => Math.round(x + (cb[k] - x) * t));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
  }
  return 'rgb(255,60,60)';
}

/** Einfaches Liniendiagramm (z. B. Average-Verlauf) */
export function lineChart(values, { height = 180, color = 'var(--accent)', label = (v) => v.toFixed(1) } = {}) {
  const w = 600, hgt = height, pad = 28;
  const svg = svgEl('svg', { viewBox: `0 0 ${w} ${hgt}`, class: 'chart', preserveAspectRatio: 'none' });
  if (!values.length) return svg;
  const min = Math.min(...values), max = Math.max(...values);
  const lo = Math.floor(min - 3), hi = Math.ceil(max + 3);
  const X = (i) => pad + (values.length === 1 ? (w - 2 * pad) / 2 : (i / (values.length - 1)) * (w - 2 * pad));
  const Y = (v) => hgt - pad + 6 - ((v - lo) / (hi - lo || 1)) * (hgt - 2 * pad);
  for (const v of [lo, (lo + hi) / 2, hi]) {
    svg.append(svgEl('line', { x1: pad, x2: w - 8, y1: Y(v), y2: Y(v), stroke: 'var(--border)', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }));
    const t = svgEl('text', { x: 2, y: Y(v) + 4, fill: 'var(--muted)', 'font-size': 11 });
    t.textContent = Math.round(v);
    svg.append(t);
  }
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${X(i)},${Y(v)}`).join(' ');
  svg.append(svgEl('path', { d, fill: 'none', stroke: color, 'stroke-width': 2.5, 'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round' }));
  values.forEach((v, i) => {
    const c = svgEl('circle', { cx: X(i), cy: Y(v), r: 3.5, fill: color });
    const tt = svgEl('title', {});
    tt.textContent = label(v);
    c.append(tt);
    svg.append(c);
  });
  return svg;
}
