// Service Worker: Offline-Betrieb. Netzwerk zuerst (immer aktuell), sonst Cache.
const CACHE = 'autodarts180-v7';
const CORE = [
  './', './index.html', './css/app.css', './manifest.webmanifest', './icon.svg',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png',
  './js/app.js', './js/state.js', './js/data/db.js', './js/data/repo.js', './js/audio/sound.js',
  './js/core/board.js', './js/core/checkout.js', './js/core/x01.js', './js/core/stats.js', './js/core/bot.js', './js/core/rng.js', './js/core/coach.js',
  './js/vision/homography.js', './js/vision/calibration.js', './js/vision/detector.js', './js/vision/camera.js', './js/vision/overlay.js',
  './js/ui/dom.js', './js/ui/boardSvg.js', './js/ui/inputPad.js',
  './js/ui/views/dashboard.js', './js/ui/views/setup.js', './js/ui/views/game.js', './js/ui/views/camera.js',
  './js/ui/views/training.js', './js/ui/views/players.js', './js/ui/views/bot.js', './js/ui/views/stats.js',
  './js/ui/views/tournaments.js', './js/ui/views/history.js', './js/ui/views/match.js', './js/ui/views/settings.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    // cache: 'no-cache' → beim Server nachfragen (ETag), damit Updates sofort ankommen
    fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('./index.html'))),
  );
});
