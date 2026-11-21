// Kleine DOM-Helfer (kein Framework nötig)

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function svgEl(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  return el;
}

export function icon(name, cls = '') {
  const span = document.createElement('span');
  span.innerHTML = ICONS[name] || '';
  const svg = span.firstElementChild;
  if (svg) svg.setAttribute('class', `ic ${cls}`.trim());
  return svg || span;
}

const S = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
export const ICONS = {
  home: S('<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>'),
  play: S('<circle cx="12" cy="12" r="9"/><path d="M10 8l6 4-6 4z" fill="currentColor"/>'),
  camera: S('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>'),
  target: S('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/>'),
  users: S('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.5-3.5 3.2-5.5 6.5-5.5s6 2 6.5 5.5"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.5c3 0 5 1.8 5.5 4.5"/>'),
  bot: S('<rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 4v4"/><circle cx="12" cy="3.5" r="1"/><circle cx="9" cy="13" r="1.3" fill="currentColor"/><circle cx="15" cy="13" r="1.3" fill="currentColor"/><path d="M9.5 16.5h5"/>'),
  chart: S('<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>'),
  trophy: S('<path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H4v1a4 4 0 0 0 4 4"/><path d="M16 6h4v1a4 4 0 0 1-4 4"/><path d="M12 13v4"/><path d="M8 20h8"/>'),
  history: S('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>'),
  settings: S('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  more: S('<circle cx="5" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="19" cy="12" r="1.5" fill="currentColor"/>'),
  undo: S('<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>'),
  check: S('<path d="M5 12l5 5L20 7"/>'),
  x: S('<path d="M6 6l12 12M18 6L6 18"/>'),
  plus: S('<path d="M12 5v14M5 12h14"/>'),
  edit: S('<path d="M4 20h4L19 9l-4-4L4 16z"/>'),
  trash: S('<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>'),
  pause: S('<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>'),
  refresh: S('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>'),
  download: S('<path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/>'),
  upload: S('<path d="M12 20V9"/><path d="M7 14l5-5 5 5"/><path d="M5 4h14"/>'),
  print: S('<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v7H6z"/>'),
  mic: S('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/>'),
  globe: S('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/>'),
  rotl: S('<path d="M4 4v6h6"/><path d="M4.5 15a8 8 0 1 0 1.9-8.3L4 10"/>'),
  rotr: S('<path d="M20 4v6h-6"/><path d="M19.5 15a8 8 0 1 1-1.9-8.3L20 10"/>'),
  wand: S('<path d="M4 20L16 8"/><path d="M15 4v2M19 8h2M18 5l1.5-1.5M12 3l.5 1.5"/>'),
  hand: S('<path d="M8 13V5a1.5 1.5 0 0 1 3 0v6"/><path d="M11 11V3.5a1.5 1.5 0 0 1 3 0V11"/><path d="M14 11V5a1.5 1.5 0 0 1 3 0v8"/><path d="M8 13l-1.5-1.5a1.6 1.6 0 0 0-2.3 2.3L8 18c1.5 2 3 3 6 3a5 5 0 0 0 5-5v-4"/>'),
};

export const LOGO_SVG = `<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="18" fill="#1a1d21" stroke="currentColor" stroke-width="2.5" style="color:var(--accent)"/><circle cx="20" cy="20" r="11" fill="none" stroke="#ff4d4f" stroke-width="3"/><circle cx="20" cy="20" r="4" fill="var(--accent)"/><path d="M33 7L22 18" stroke="#f2f4f5" stroke-width="2.5" stroke-linecap="round"/><path d="M31 5l4 0 0 4" fill="none" stroke="#f2f4f5" stroke-width="2" stroke-linecap="round"/></svg>`;

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

let toastBox = null;
export function toast(msg, type = '') {
  if (!toastBox) { toastBox = h('div', { class: 'toasts' }); document.body.append(toastBox); }
  const t = h('div', { class: `toast ${type}` }, msg);
  toastBox.append(t);
  setTimeout(() => t.remove(), 3200);
}

export function modal({ title, body, actions = [], onClose } = {}) {
  const box = h('div', { class: 'modal', role: 'dialog' });
  const back = h('div', { class: 'modal-back' }, box);
  const close = () => { back.remove(); onClose?.(); };
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  if (title) box.append(h('h2', {}, title));
  if (body) box.append(typeof body === 'function' ? body(close) : body);
  if (actions.length) {
    box.append(h('div', { class: 'm-actions' }, actions.map((a) => h('button', {
      class: `btn ${a.kind || ''}`,
      onclick: async () => { const r = await a.onClick?.(close); if (r !== false) close(); },
    }, a.label))));
  }
  document.body.append(back);
  return close;
}

export function confirmDialog(text, { okLabel = 'OK', danger = false, title = 'Bestätigen' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    modal({
      title,
      body: h('p', {}, text),
      onClose: () => { if (!done) resolve(false); },
      actions: [
        { label: 'Abbrechen', onClick: () => { done = true; resolve(false); } },
        { label: okLabel, kind: danger ? 'danger' : 'primary', onClick: () => { done = true; resolve(true); } },
      ],
    });
  });
}

export const fmt = {
  avg: (v) => (v == null || !Number.isFinite(v) ? '–' : v.toFixed(2).replace('.', ',')),
  pct: (v) => (v == null || !Number.isFinite(v) ? '–' : `${(v * 100).toFixed(1).replace('.', ',')} %`),
  int: (v) => (v == null ? '–' : String(v)),
  date: (ts) => new Date(ts).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }),
  dateTime: (ts) => new Date(ts).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }),
  duration: (ms) => {
    const m = Math.round(ms / 60000);
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
  },
};

export function avatar(player, cls = '') {
  const el = h('div', { class: `avatar ${cls}` });
  if (player?.avatar) el.append(h('img', { src: player.avatar, alt: '' }));
  else if (player?.isBot) el.append(icon('bot'));
  else el.textContent = (player?.name || '?').trim().charAt(0).toUpperCase();
  return el;
}

export function statTile(label, value, accent = false) {
  return h('div', { class: 'stat' }, h('div', { class: 'l' }, label), h('div', { class: `v ${accent ? 'accent' : ''}` }, value));
}

export function segControl(options, value, onChange) {
  const wrap = h('div', { class: 'seg-control' });
  const render = (val) => {
    clear(wrap);
    for (const o of options) {
      wrap.append(h('button', {
        type: 'button', class: o.value === val ? 'on' : '', disabled: !!o.disabled, title: o.title || null,
        onclick: () => { render(o.value); onChange(o.value); },
      }, o.label));
    }
  };
  render(value);
  return wrap;
}

export function download(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
