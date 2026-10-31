/*
  Service worker do Kivo servido pela máquina da loja.

  A função principal é deixar o Kivo instalável como aplicativo (tela cheia, sem a barra
  do navegador) quando ele é aberto por HTTPS ou por localhost. Em acesso pela rede local
  via http:// o navegador nem registra o worker — e o app continua funcionando igual.

  Deliberadamente NÃO guarda HTML autenticado nem resposta de /api/: o servidor é a própria
  máquina da loja, então cachear tela de usuário só criaria risco de mostrar dado antigo
  (ou de outro usuário) sem necessidade.
*/
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/* Handler de fetch obrigatório para o critério de instalação do Chrome. Passa tudo
   direto para a rede: não intercepta, não cacheia. */
self.addEventListener('fetch', () => {});

/* Clique no aviso de "pedido pronto" (ou em qualquer notificação do Kivo): foca a aba
   já aberta e leva para a tela de mesas. Sem aba aberta, abre uma nova. */
self.addEventListener('notificationclick', (event) => {
  const target = (event.notification && event.notification.data && event.notification.data.url) || '/app/comandas/mesas';
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const win of wins) {
        if ('focus' in win) {
          win.focus();
          if ('navigate' in win) win.navigate(target).catch(() => {});
          return;
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
