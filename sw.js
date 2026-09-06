/* CityWalker — service worker : rendre le site installable et utilisable hors ligne.
 *
 * Stratégie volontairement simple et sans piège de cache périmé :
 *  - navigation (la page elle-même) : réseau d'abord, cache en secours ;
 *  - ressources statiques : cache d'abord, avec rafraîchissement en arrière-plan ;
 *  - le nom du cache porte une version : publier une nouvelle version purge l'ancienne.
 */
const VERSION = 'cw-v3';
const ASSETS = [
  './', './index.html', './manifest.webmanifest',
  './assets/app.css',
  './assets/js/config.js', './assets/js/util.js', './assets/js/model.js', './assets/js/store.js',
  './assets/js/exif.js', './assets/js/photos.js', './assets/js/import.js',
  './assets/js/cloud.js', './assets/js/share.js',
  './assets/js/tiles.js', './assets/js/map.js', './assets/js/france.js', './assets/js/ui.js', './assets/js/main.js',
  './data/paris.json', './data/montpellier.json', './data/lyon.json', './data/france.json',
  './assets/icons/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())   // une ressource manquante ne doit pas bloquer l'install
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put('./index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
