// Autodarts180 – Einstieg, Navigation und Routing
import { settings, calibration, applyTheme } from './state.js';
import { h, icon, LOGO_SVG, modal, clear, toast } from './ui/dom.js';

export const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: 'home' },
  { id: 'setup', label: 'Neues Spiel', icon: 'play' },
  { id: 'camera', label: 'Kamera', icon: 'camera' },
  { id: 'training', label: 'Training', icon: 'target', soon: true },
  { id: 'players', label: 'Spieler', icon: 'users' },
  { id: 'bot', label: 'Bot', icon: 'bot' },
  { id: 'stats', label: 'Statistiken', icon: 'chart' },
  { id: 'tournaments', label: 'Turniere', icon: 'trophy', soon: true },
  { id: 'history', label: 'Match-Historie', icon: 'history' },
  { id: 'settings', label: 'Einstellungen', icon: 'settings' },
];

const VIEWS = {
  dashboard: () => import('./ui/views/dashboard.js'),
  setup: () => import('./ui/views/setup.js'),
  game: () => import('./ui/views/game.js'),
  camera: () => import('./ui/views/camera.js'),
  training: () => import('./ui/views/training.js'),
  players: () => import('./ui/views/players.js'),
  player: () => import('./ui/views/players.js'),
  bot: () => import('./ui/views/bot.js'),
  stats: () => import('./ui/views/stats.js'),
  tournaments: () => import('./ui/views/tournaments.js'),
  history: () => import('./ui/views/history.js'),
  match: () => import('./ui/views/match.js'),
  settings: () => import('./ui/views/settings.js'),
};

const NAV_PARENT = { game: 'setup', player: 'players', match: 'history' };

export function go(path) {
  location.hash = '#/' + path;
}

function buildNav() {
  const side = document.getElementById('sidebar');
  side.append(h('div', { class: 'logo', html: `${LOGO_SVG}<span>Autodarts<b>180</b></span>` }));
  for (const n of NAV) {
    side.append(h('a', { class: 'nav-link', href: `#/${n.id}`, dataset: { nav: n.id } },
      icon(n.icon), n.label, n.soon ? h('span', { class: 'soon-tag badge-soon' }, 'bald') : null));
  }
  const bottom = document.getElementById('bottomnav');
  for (const id of ['dashboard', 'setup', 'camera', 'stats']) {
    const n = NAV.find((x) => x.id === id);
    bottom.append(h('a', { href: `#/${id}`, dataset: { nav: id } }, icon(n.icon), id === 'dashboard' ? 'Start' : id === 'setup' ? 'Spiel' : id === 'stats' ? 'Statistik' : n.label));
  }
  bottom.append(h('button', { type: 'button', onclick: openMore }, icon('more'), 'Mehr'));
}

function openMore() {
  modal({
    title: 'Menü',
    body: (close) => h('div', { class: 'list' }, NAV.map((n) => h('a', {
      class: 'list-item', href: `#/${n.id}`, onclick: close,
    }, icon(n.icon), h('span', { class: 'grow title' }, n.label), n.soon ? h('span', { class: 'soon-tag' }, 'bald') : null))),
  });
}

let cleanup = null;
let routing = 0;

async function route() {
  const token = ++routing;
  const raw = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [name, ...params] = raw.split('/').map(decodeURIComponent);
  const key = VIEWS[name] ? name : 'dashboard';
  if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; }
  document.body.classList.toggle('in-game', key === 'game');
  const navId = NAV_PARENT[key] || key;
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === navId));
  const main = document.getElementById('main');
  try {
    const mod = await VIEWS[key]();
    if (token !== routing) return;
    clear(main);
    window.scrollTo(0, 0);
    cleanup = (await mod.render(main, params)) || null;
  } catch (e) {
    console.error(e);
    clear(main);
    main.append(h('div', { class: 'notice err' }, `Fehler beim Laden der Ansicht: ${e.message}`));
  }
}

async function init() {
  await settings.load();
  await calibration.load();
  applyTheme();
  settings.onChange((k) => { if (k === 'theme' || k === 'accent') applyTheme(); });
  buildNav();
  window.addEventListener('hashchange', route);
  await route();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) toast('Neue Version installiert – App neu laden, um sie zu verwenden.', 'ok');
    });
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

init().catch((e) => {
  console.error(e);
  toast(`Start fehlgeschlagen: ${e.message}`, 'err');
});
