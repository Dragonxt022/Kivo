/*
  Service worker do Kivo Web.

  Escopo restrito a /m/ (a concessão é registrada com `{ scope: '/m/' }`), então o painel
  admin e as rotas de API ficam fora daqui por construção.

  O que ele faz — e o que deliberadamente NÃO faz:

  - Assets estáticos (CSS, JS, ícones): stale-while-revalidate. A tela abre na hora com o
    que está no cache e a próxima visita pega a versão nova.
  - Navegação (HTML autenticado): network-only. Guardar a página de um usuário no cache
    mostraria a tela dele para quem abrisse o mesmo aparelho depois do logout — e o painel
    mostra dado financeiro. Sem rede, cai numa tela de "sem conexão" genérica.
  - /api/: nunca cacheado. A resposta carrega dado da empresa.
*/
const CACHE = 'kivo-m-v1';
const OFFLINE_URL = '/m-offline.html';
const PRECACHE = [
  OFFLINE_URL,
  '/css/mobile.css',
  '/css/mobile-pro.css',
  '/logo_kivo-icon.svg',
  '/img/icon-192.png',
  '/img/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname === '/sw.js' || url.pathname.startsWith('/admin')) return;

  // Navegação: sempre rede. Offline vira a tela estática, nunca uma página em cache.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match(OFFLINE_URL)));
    return;
  }

  // Estático: entrega o cache e revalida em segundo plano.
  const estatico = /\.(?:css|js|mjs|png|jpe?g|svg|webp|woff2?|ico|webmanifest)$/i.test(url.pathname);
  if (!estatico) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      const rede = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copia = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copia));
          }
          return res;
        })
        .catch(() => cached);
      return cached || rede;
    }),
  );
});
