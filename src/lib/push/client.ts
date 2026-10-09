// Ativar/desativar o push no NAVEGADOR (TASK36 item 3). Chamar SOMENTE a partir de uma ação do usuário (clique no botão
// "Ativar notificações"): é a única hora em que o navegador aceita pedir a permissão.

export type PushState = "unsupported" | "denied" | "off" | "on";

const supported = () =>
  typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function toKey(base64Url: string): Uint8Array {
  const pad = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const raw = atob((base64Url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Estado atual (não pede permissão). */
export async function getPushState(): Promise<PushState> {
  if (!supported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.getRegistration("/sw-push.js");
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === "granted" ? "on" : "off";
}

/** Pede permissão, registra o service worker, inscreve e manda a inscrição ao servidor. */
export async function enablePush(): Promise<PushState> {
  if (!supported()) return "unsupported";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";
  const keyRes = await fetch("/api/push/vapid-key", { cache: "no-store" });
  if (!keyRes.ok) throw new Error("Notificações indisponíveis no momento.");
  const { public_key } = (await keyRes.json()) as { public_key: string };
  const reg = await navigator.serviceWorker.register("/sw-push.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(public_key) as BufferSource }));
  const res = await fetch("/api/push/subscriptions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sub.toJSON()) });
  if (!res.ok) throw new Error("Não foi possível ativar as notificações.");
  return "on";
}

export async function disablePush(): Promise<PushState> {
  if (!supported()) return "unsupported";
  const reg = await navigator.serviceWorker.getRegistration("/sw-push.js");
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await fetch("/api/push/subscriptions", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => undefined);
    await sub.unsubscribe();
  }
  return Notification.permission === "denied" ? "denied" : "off";
}
