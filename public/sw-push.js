/* Service worker SÓ de notificação push (TASK36 item 3). Não faz cache nem intercepta requisições.
 * O payload traz apenas { type, conversation_id }: o texto da notificação é fixo aqui (nada de mensagem nem dado pessoal). */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let id = null;
  try {
    const data = event.data ? event.data.json() : null;
    if (data && data.type === "conversation_pending" && typeof data.conversation_id === "string") id = data.conversation_id;
  } catch (_) {
    /* payload ilegível: mostra o aviso genérico */
  }
  event.waitUntil(
    self.registration.showNotification("Nova conversa em espera", {
      body: "Abra o Inbox para atender.",
      tag: id ? "conv-" + id : "conv-pending",
      data: { conversationId: id },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const id = event.notification.data && event.notification.data.conversationId;
  const target = new URL(id ? "/inbox?c=" + encodeURIComponent(id) : "/inbox", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (new URL(client.url).origin === self.location.origin && "navigate" in client) {
          return client.navigate(target).then((c) => c && c.focus());
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
