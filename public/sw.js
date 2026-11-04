'use strict';
/* Service worker de StockVoz: guarda la interfaz para que la app abra sin conexión.
   NUNCA guarda respuestas de /api/: el stock y las ventas se leen siempre del servidor,
   porque mostrar un stock viejo sería peor que no mostrar nada. */

// Al cambiar la interfaz, subir el número: así se borra la copia anterior.
const CACHE = 'stockvoz-v1';
const BASICOS = ['./', 'index.html', 'app.css', 'app.js', 'logo.svg',
  'manifest.webmanifest', 'icono-192.png', 'icono-512.png', 'icono-512-maskable.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE)
    .then(function (c) { return c.addAll(BASICOS); })
    .then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys()
    .then(function (nombres) {
      return Promise.all(nombres.filter(function (n) { return n !== CACHE; })
        .map(function (n) { return caches.delete(n); }));
    })
    .then(function () { return self.clients.claim(); }));
});

// Primero la red; la copia guardada solo se usa si no hay conexión. Así nadie se queda
// trabajando con una versión vieja de la app después de que la actualicemos.
self.addEventListener('fetch', function (e) {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.indexOf('/api/') === 0) { return; }
  e.respondWith(
    fetch(e.request).then(function (r) {
      if (r.ok) {
        const copia = r.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copia); });
      }
      return r;
    }).catch(function () {
      return caches.match(e.request).then(function (guardada) {
        // Sin conexión y sin copia exacta: se devuelve la página, que es de una sola pantalla.
        return guardada || caches.match('./');
      });
    })
  );
});
