/*
 * Service worker de Hábitos
 *  1. Caché del "app shell" para instalación y uso offline.
 *  2. Notificaciones: push desde el servidor, comprobación periódica en
 *     segundo plano (donde el navegador la soporta) y clic en la notificación.
 */
importScripts('kv.js');

const CACHE = 'habitos-v1'; // Sube la versión al publicar cambios para limpiar cachés antiguas
const SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'config.js',
  'kv.js',
  'manifest.json',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png'
];
const CDN_HOST = 'cdn.jsdelivr.net';
const NETWORK_TIMEOUT = 3000;

/* ---------- Ciclo de vida ---------- */

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* ---------- Estrategias de caché ---------- */

// Red primero (con límite de tiempo) y caché como respaldo: siempre fresco, y usable sin conexión.
async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
  const network = fetch(request).then((res) => {
    if (res.ok) cache.put(request, res.clone());
    return res;
  });
  if (!cached) {
    return network.catch(() => cache.match('index.html'));
  }
  const timeout = new Promise((resolve) => setTimeout(() => resolve(cached), NETWORK_TIMEOUT));
  return Promise.race([network.catch(() => cached), timeout]);
}

// Caché primero y actualización en segundo plano (para la librería del CDN).
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const network = fetch(request).then((res) => {
    if (res.ok || res.type === 'opaque') cache.put(request, res.clone());
    return res;
  });
  if (cached) {
    network.catch(() => {});
    return cached;
  }
  return network;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request));
  } else if (url.hostname === CDN_HOST) {
    event.respondWith(staleWhileRevalidate(request));
  }
  // El resto (API de Supabase) va siempre directo a la red: nunca se cachea.
});

/* ---------- Notificaciones ---------- */

const pad = (n) => String(n).padStart(2, '0');
const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function showReminder(day, title, body) {
  return self.registration.showNotification(title || 'Hábitos: ayer quedó sin registrar', {
    body: body || 'Toca para completar el registro de ayer. Solo te llevará un momento.',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: `recordatorio-${day}`, // misma etiqueta = no se duplica si llega por dos vías
    data: { day }
  });
}

// Push enviado por la Edge Function "morning-reminder" (el servidor ya ha
// comprobado que el día anterior no tiene registro).
self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (_) { /* push sin cuerpo */ }
  const now = new Date();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const day = payload.day || toISO(yesterday);
  event.waitUntil(
    showReminder(day, payload.title, payload.body)
      .then(() => KV.set('lastNotified', toISO(now)))
      .catch(() => {})
  );
});

// Comprobación local: ¿tiene registro el día de ayer?
async function morningCheck() {
  const ctx = await KV.get('ctx');
  if (!ctx || !ctx.enabled) return;
  const now = new Date();
  if (now.getHours() < ctx.hour) return;
  const todayISO = toISO(now);
  if ((await KV.get('lastNotified')) === todayISO) return;

  const day = toISO(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  let done = (ctx.recent || []).includes(day);
  if (!done && ctx.url && ctx.space) {
    // Puede haberse registrado desde otro dispositivo: se pregunta a la nube.
    try {
      const res = await fetch(`${ctx.url}/rest/v1/rpc/habitos_day_done`, {
        method: 'POST',
        headers: {
          apikey: ctx.key,
          Authorization: `Bearer ${ctx.key}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ p_space: ctx.space, p_day: day })
      });
      if (res.ok) done = (await res.json()) === true;
    } catch (_) { /* sin conexión: se usa el dato local */ }
  }
  if (done) return;
  await showReminder(day);
  await KV.set('lastNotified', todayISO);
}

// Periodic Background Sync (Chrome/Edge con la PWA instalada).
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'morning-check') event.waitUntil(morningCheck());
});

// Al tocar la notificación se abre la app en el día pendiente.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const day = event.notification.data && event.notification.data.day;
  const hash = day ? `#dia=${day}` : '#dia';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.length) {
      const win = wins[0];
      await win.focus();
      win.postMessage({ type: 'open-day', day });
      return;
    }
    await self.clients.openWindow(new URL(`./${hash}`, self.registration.scope).href);
  })());
});
