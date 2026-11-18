// Service worker: keeps the app itself available with no connection.
// It only caches the app's own files. Requests to Apps Script (your data) are
// never cached or touched here.
//
// When you change any app file, bump VERSION so phones pick up the update.
var VERSION = '1';
var CACHE = 'seizure-log-' + VERSION;
var SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k.indexOf('seizure-log-') === 0 && k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

// The app is a single page, so any navigation is answered with index.html.
function fromCache(request) {
  return caches.match('./index.html').then(function (r) {
    return r || caches.match(request, { ignoreSearch: true });
  });
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    // Try the network briefly so updates arrive; fall back to the cached app.
    event.respondWith(new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () {
        if (!done) { done = true; resolve(fromCache(req)); }
      }, 4000);
      fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put('./index.html', copy); });
        }
        if (!done) { done = true; clearTimeout(timer); resolve(res); }
      }).catch(function () {
        if (!done) { done = true; clearTimeout(timer); resolve(fromCache(req)); }
      });
    }));
    return;
  }

  event.respondWith(
    caches.match(req).then(function (hit) {
      return hit || fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      });
    })
  );
});
