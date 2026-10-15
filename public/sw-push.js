/* Service worker SÓ de notificação push (TASK36 item 3). Não faz cache nem intercepta requisições.
 * O payload traz apenas { type, conversation_id } (conversa em espera) ou { type: "ops_alert", kind, tag } (alertas do Disparador para
 * admin/proprietário): o texto da notificação é fixo aqui, por tipo (nada de mensagem nem dado pessoal). */
var OPS_ALERTS = {
  campaign_auto_paused: "Campanha pausada automaticamente",
  channel_quality_changed: "Qualidade de um número mudou",
  cron_stalled: "Um processo do Disparador parou",
};
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let id = null;
  let ops = null;
  let pause = null;
  try {
    const data = event.data ? event.data.json() : null;
    if (data && data.type === "conversation_pending" && typeof data.conversation_id === "string") id = data.conversation_id;
    if (data && data.type === "ops_alert" && Object.prototype.hasOwnProperty.call(OPS_ALERTS, data.kind)) {
      ops = { title: OPS_ALERTS[data.kind], tag: typeof data.tag === "string" ? data.tag.slice(0, 80) : data.kind };
    }
    if (data && data.type === "pause_exceeded") pause = { tag: typeof data.tag === "string" ? data.tag.slice(0, 80) : "pause" };
  } catch (_) {
    /* payload ilegível: mostra o aviso genérico */
  }
  if (pause) {
    // Pausa acima do tempo (supervisor da equipe): texto fixo, sem nome de atendente.
    event.waitUntil(
      self.registration.showNotification("Pausa acima do tempo", {
        body: "Um atendente da sua equipe passou do tempo da pausa. Abra o Monitoramento.",
        tag: "pause-" + pause.tag,
        data: { path: "/monitoramento" },
      }),
    );
    return;
  }
  if (ops) {
    event.waitUntil(
      self.registration.showNotification(ops.title, {
        body: "Abra o Disparador para ver o detalhe.",
        tag: "ops-" + ops.tag,
        data: { path: "/disparador" },
      }),
    );
    return;
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
  const nd = event.notification.data || {};
  const id = nd.conversationId;
  const path = nd.path === "/disparador" ? "/disparador" : nd.path === "/monitoramento" ? "/monitoramento" : id ? "/inbox?c=" + encodeURIComponent(id) : "/inbox";
  const target = new URL(path, self.location.origin).href;
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
