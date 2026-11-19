const CACHE = "finforme-v1.1";
const FILES = ["./", "./index.html", "./app.js", "./parsers.js", "./icons.js", "./manifest.json",
  "./lib/react.js", "./lib/react-dom.js", "./lib/htm.js", "./lib/pdf.js", "./lib/pdf.worker.js",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png", "./icons/logo-icon.png", "./icons/logo.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(fetch(e.request).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {}); return res; }).catch(() => caches.match(e.request)));
});
