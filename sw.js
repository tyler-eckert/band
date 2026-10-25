/* Trailer Folk HQ — service worker.
   Keeps the app's own files on the device so it opens with no signal. Network first, so a new
   version always wins when you're online; the saved copy is used when the network is down or slow.
   Band data (Supabase) is never touched here — the app keeps its own offline copy of that. */
const CACHE = 'tfhq-app-v1';   // sw v2: adds push notifications
const KEEP_VERSIONS = 2;                       // per file name, so a half-updated page can still find its matching script
const EXTRA_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com'];
const SLOW_MS = 3500;

self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(precache()); });
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

async function precache() {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch('./', { cache: 'reload' }); const html = await res.clone().text(); await cache.put('./', res);
    const urls = new Set(['pdf.min.js', 'pdf.worker.min.js', 'assets/logo.png', 'assets/icon.png', 'assets/hero.jpg']);
    for (const m of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
      const u = m[1]; if (/^(?:data:|mailto:|#)/i.test(u)) continue;
      if (!/^(?:[a-z]+:)?\/\//i.test(u)) urls.add(u);
      else { try { if (EXTRA_HOSTS.includes(new URL(u).hostname)) urls.add(u); } catch {} }
    }
    const app = [...urls].find(u => /^app\.js/.test(u));                         // images the app refers to by name
    if (app) { try { const t = await (await fetch(app)).text(); for (const m of t.matchAll(/assets\/[\w.\-]+\.(?:png|jpe?g|svg|webp)/g)) urls.add(m[0]); } catch {} }
    await Promise.allSettled([...urls].map(async u => {
      const r = await fetch(new Request(u, { cache: 'reload' })); if (!r.ok) return; await cache.put(u, r.clone());
      if (/fonts\.googleapis\.com/.test(u)) { const css = await r.text(); await Promise.allSettled([...css.matchAll(/url\((https:[^)]+)\)/g)].map(m => cache.add(m[1]))); }   // the font files the CSS points at
    }));
  } catch {}
}

self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  let url; try { url = new URL(req.url); } catch { return; }
  const same = url.origin === self.location.origin;
  if (!same && !EXTRA_HOSTS.includes(url.hostname)) return;                   // Supabase and everything else: straight to the network
  if (same && /\/sw\.js$/.test(url.pathname)) return;
  e.respondWith(networkFirst(req));
});

async function lookup(cache, req) {
  let hit = await cache.match(req);
  if (!hit && req.mode === 'navigate') hit = (await cache.match(req, { ignoreSearch: true })) || (await cache.match('./')) || (await cache.match('index.html'));
  if (!hit && new URL(req.url).origin === self.location.origin) hit = await cache.match(req, { ignoreSearch: true });
  return hit || null;
}
async function networkFirst(req) {
  const cache = await caches.open(CACHE), cached = await lookup(cache, req);
  const net = fetch(req).then(res => {
    if (res && (res.ok || res.type === 'opaque') && res.status !== 206) cache.put(req, res.clone()).then(() => prune(cache, req)).catch(() => {});
    return res;
  });
  if (!cached) return net;
  return Promise.race([net.catch(() => cached), new Promise(r => setTimeout(() => r(cached), SLOW_MS))]);   // don't hang on a weak connection
}
async function prune(cache, req) {
  const u = new URL(req.url); if (!u.search) return;
  const same = (await cache.keys()).filter(k => { const x = new URL(k.url); return x.origin === u.origin && x.pathname === u.pathname; });
  await Promise.all(same.slice(0, Math.max(0, same.length - KEEP_VERSIONS)).map(k => cache.delete(k)));
}

/* Phone notifications (sent by the band-push Edge Function): show them, and open the right page when tapped. */
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Trailer Folk HQ', {
    body: d.body || '', tag: d.tag || undefined, data: { url: d.url || './' }, icon: 'hq-icon-192.png', badge: 'hq-icon-192.png'
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) { if ('focus' in w) { try { await w.navigate(url); } catch {} return w.focus(); } }
    return self.clients.openWindow(url);
  })());
});
