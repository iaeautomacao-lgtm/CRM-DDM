/* eslint-disable @typescript-eslint/no-explicit-any -- cliente admin com schema wacrm */
import "server-only";
// Notificação push do navegador (TASK36 item 3, migration 298): chaves VAPID por conta, inscrições e envio do aviso
// "Nova conversa em espera". Segurança: o payload leva SÓ o tipo e o id da conversa (nada de texto da mensagem nem dado pessoal);
// a privada VAPID fica cifrada em tabela fechada; o endpoint só vale se for de um serviço de push conhecido (anti-SSRF).

import { decrypt, encrypt } from "@/lib/whatsapp/encryption";
import { generateVapidKeys, isAllowedPushEndpoint, sendWebPush } from "./web-push";

type Db = any;

export class PushUnavailableError extends Error {
  constructor() {
    super("Notificações push indisponíveis: aplique a migration 298");
    this.name = "PushUnavailableError";
  }
}
const isMissingTable = (e: { code?: string; message?: string } | null | undefined) =>
  !!e && (e.code === "42P01" || e.code === "PGRST205" || e.code === "PGRST202" || e.code === "42883");

/** Remetente do VAPID (obrigatório pelo protocolo): a URL do próprio app, que já é config de infra. */
export function vapidSubject(): string {
  const url = process.env.NEXT_PUBLIC_APP_URL?.trim();
  return url && /^https:\/\//i.test(url) ? url : "mailto:push@invalid.example";
}

/** Chave pública da conta (cria o par na primeira vez). A privada nunca sai do servidor. */
export async function getOrCreateVapidPublicKey(db: Db, accountId: string): Promise<string> {
  const { data, error } = await db.from("push_vapid_keys").select("public_key").eq("account_id", accountId).limit(1);
  if (error) {
    if (isMissingTable(error)) throw new PushUnavailableError();
    throw error;
  }
  if (data?.[0]?.public_key) return data[0].public_key as string;

  const pair = generateVapidKeys();
  const { error: insertError } = await db.from("push_vapid_keys").insert({ account_id: accountId, public_key: pair.publicKey, private_key_enc: encrypt(pair.privateKeyPem) });
  if (insertError) {
    // Corrida (duas abas ativando juntas): o par de quem ganhou vale.
    if (insertError.code === "23505") {
      const again = await db.from("push_vapid_keys").select("public_key").eq("account_id", accountId).limit(1);
      if (again.data?.[0]?.public_key) return again.data[0].public_key as string;
    }
    if (isMissingTable(insertError)) throw new PushUnavailableError();
    throw insertError;
  }
  return pair.publicKey;
}

async function loadVapid(db: Db, accountId: string): Promise<{ publicKey: string; privateKeyPem: string; subject: string } | null> {
  const { data, error } = await db.from("push_vapid_keys").select("public_key, private_key_enc").eq("account_id", accountId).limit(1);
  if (error || !data?.[0]) return null;
  return { publicKey: data[0].public_key, privateKeyPem: decrypt(data[0].private_key_enc), subject: vapidSubject() };
}

export interface SubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Valida o corpo de POST /api/push/subscriptions (formato do PushSubscription.toJSON()). */
export function parseSubscription(body: unknown): SubscriptionInput | null {
  const b = body as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  const endpoint = typeof b?.endpoint === "string" ? b.endpoint : "";
  const p256dh = typeof b?.keys?.p256dh === "string" ? b.keys.p256dh : "";
  const auth = typeof b?.keys?.auth === "string" ? b.keys.auth : "";
  if (!isAllowedPushEndpoint(endpoint) || endpoint.length > 2048) return null;
  if (!/^[A-Za-z0-9_-]{86,88}$/.test(p256dh) || Buffer.from(p256dh, "base64url").length !== 65) return null;
  if (!/^[A-Za-z0-9_-]{22,24}$/.test(auth) || Buffer.from(auth, "base64url").length !== 16) return null;
  return { endpoint, p256dh, auth };
}

/** Grava (ou reaponta ao usuário atual) a inscrição deste navegador. */
export async function saveSubscription(db: Db, args: { accountId: string; userId: string; sub: SubscriptionInput; userAgent: string | null }): Promise<void> {
  const { error } = await db.from("push_subscriptions").upsert(
    {
      account_id: args.accountId,
      user_id: args.userId,
      endpoint: args.sub.endpoint,
      p256dh: args.sub.p256dh,
      auth: args.sub.auth,
      user_agent: args.userAgent?.slice(0, 200) ?? null,
    },
    { onConflict: "endpoint" },
  );
  if (error) {
    if (isMissingTable(error)) throw new PushUnavailableError();
    throw error;
  }
}

/** Remove a inscrição (só a do próprio usuário na conta). */
export async function deleteSubscription(db: Db, args: { accountId: string; userId: string; endpoint: string }): Promise<void> {
  const { error } = await db.from("push_subscriptions").delete().eq("account_id", args.accountId).eq("user_id", args.userId).eq("endpoint", args.endpoint);
  if (error) {
    if (isMissingTable(error)) throw new PushUnavailableError();
    throw error;
  }
}

export const PUSH_PAYLOAD_TYPE = "conversation_pending" as const;

interface OutboxRow {
  id: string;
  account_id: string;
  conversation_id: string;
  team_id: string | null;
}

export interface DrainSummary {
  claimed: number;
  sent: number;
  removed: number;
  failed: number;
}

/**
 * Entrega os avisos pendentes: para cada conversa que entrou em espera, notifica os membros da EQUIPE da conversa que tenham
 * inscrição. Conversa sem equipe não notifica ninguém. Assíncrono e tolerante: erro de envio só é registrado (o aviso já foi
 * reservado; entrega "no máximo uma vez") e nada aqui lança para quem chamou (webhook/cron).
 */
export async function drainPushOutbox(db: Db, options: { limit?: number; sender?: typeof sendWebPush } = {}): Promise<DrainSummary> {
  const summary: DrainSummary = { claimed: 0, sent: 0, removed: 0, failed: 0 };
  try {
    const { data, error } = await db.rpc("claim_push_outbox", { p_limit: options.limit ?? 50 });
    if (error) {
      if (!isMissingTable(error)) console.error("[Push] falha ao reservar avisos:", error.message);
      return summary;
    }
    const rows = (data ?? []) as OutboxRow[];
    summary.claimed = rows.length;
    const send = options.sender ?? sendWebPush;
    const vapidCache = new Map<string, Awaited<ReturnType<typeof loadVapid>>>();

    for (const row of rows) {
      if (!row.team_id) continue;
      const { data: members } = await db.from("team_members").select("user_id").eq("team_id", row.team_id).limit(500);
      const userIds = ((members ?? []) as Array<{ user_id: string }>).map((m) => m.user_id);
      if (userIds.length === 0) continue;
      const { data: subs } = await db.from("push_subscriptions").select("endpoint, p256dh, auth").eq("account_id", row.account_id).in("user_id", userIds).limit(500);
      if (!subs?.length) continue;
      if (!vapidCache.has(row.account_id)) vapidCache.set(row.account_id, await loadVapid(db, row.account_id));
      const vapid = vapidCache.get(row.account_id);
      if (!vapid) continue;

      const payload = { type: PUSH_PAYLOAD_TYPE, conversation_id: row.conversation_id };
      const gone: string[] = [];
      const queue = [...(subs as Array<{ endpoint: string; p256dh: string; auth: string }>)];
      await Promise.all(
        Array.from({ length: Math.min(5, queue.length) }, async () => {
          for (let sub = queue.shift(); sub; sub = queue.shift()) {
            try {
              const result = await send(sub, payload, vapid);
              if (result.gone) gone.push(sub.endpoint);
              else if (result.status >= 200 && result.status < 300) summary.sent++;
              else {
                summary.failed++;
                console.error(`[Push] provedor respondeu ${result.status}`);
              }
            } catch (err) {
              summary.failed++;
              console.error("[Push] falha no envio:", err instanceof Error ? err.message : String(err));
            }
          }
        }),
      );
      if (gone.length > 0) {
        const { error: delError } = await db.from("push_subscriptions").delete().in("endpoint", gone);
        if (!delError) summary.removed += gone.length;
      }
    }
  } catch (err) {
    console.error("[Push] drenagem falhou:", err instanceof Error ? err.message : String(err));
  }
  return summary;
}
