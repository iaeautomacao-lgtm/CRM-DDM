// Falha de autenticação de webhook de ENTRADA → system_logs (revisão de segurança 13/10, fase 3). Amostrado: no máximo
// 1 registro por minuto por (origem, motivo) e por processo, para uma enxurrada de requisições forjadas não encher a
// tabela. Nunca registra assinatura, segredo, token nem corpo — só a origem, o motivo e identificadores de canal.
import { writeLog } from "@/lib/logger";

export type WebhookSource = "webhook_meta" | "webhook_meta_social" | "webhook_waha";
export type WebhookRejectReason =
  | "malformed_signature" // sem X-Hub-Signature-256 bem formada
  | "invalid_signature" // HMAC não confere
  | "missing_secret" // canal sem app_secret configurado
  | "invalid_channel_secret" // WAHA: x-webhook-secret não confere com o canal
  | "invalid_legacy_secret"; // WAHA: sessão antiga sem ?channel= e segredo global não confere

const WINDOW_MS = 60_000;
const lastLogged = new Map<string, number>();

/** true se este (origem, motivo) ainda não foi registrado na janela; marca o registro. */
export function shouldLogWebhookRejection(key: string, now: number = Date.now()): boolean {
  const last = lastLogged.get(key);
  if (last !== undefined && now - last < WINDOW_MS) return false;
  lastLogged.set(key, now);
  if (lastLogged.size > 500) lastLogged.clear(); // teto de memória (chaves por canal)
  return true;
}

/** Só para testes. */
export function __resetWebhookRejectionLogForTests(): void {
  lastLogged.clear();
}

const MESSAGES: Record<WebhookRejectReason, string> = {
  malformed_signature: "Webhook recusado: assinatura ausente ou mal formada",
  invalid_signature: "Webhook recusado: assinatura inválida",
  missing_secret: "Webhook recusado: canal sem App Secret configurado",
  invalid_channel_secret: "Webhook WAHA recusado: segredo do canal não confere",
  invalid_legacy_secret: "Webhook WAHA recusado: segredo legado não confere",
};

/** Fire-and-forget: não atrasa a resposta 401 nem lança. */
export function logWebhookRejection(
  source: WebhookSource,
  reason: WebhookRejectReason,
  payload: { channels?: string[]; channel?: string | null } = {},
): void {
  const key = `${source}:${reason}:${payload.channel ?? (payload.channels ?? []).join(",")}`;
  if (!shouldLogWebhookRejection(key)) return;
  void writeLog({
    level: "warn",
    // system_logs.source tem conjunto fechado: Instagram/Messenger saem como webhook_meta com via = meta_social.
    source: source === "webhook_waha" ? "webhook_waha" : "webhook_meta",
    event: "webhook_auth_rejected",
    message: MESSAGES[reason],
    payload: { reason, ...(source === "webhook_meta_social" ? { via: "meta_social" } : {}), ...payload },
  });
}
