/* eslint-disable @typescript-eslint/no-explicit-any -- cliente admin com schema wacrm */
import { randomUUID } from "node:crypto";
import { sendOpsAlertPush, type OpsAlertKind } from "@/lib/push/service";
import type { WebhookEvent } from "@/lib/webhooks-out/catalog";

// Alertas ativos do Disparador (decisão do dono 13/10, item 5; migration 337): em vez de o operador descobrir olhando a tela, o sistema
// AVISA — webhook de saída (quem assinou o evento) e push do navegador (só admin e proprietário). Três alertas:
//   campaign.auto_paused     campanha pausada automaticamente (auto-pause.ts)
//   channel.quality_changed  qualidade do número Meta mudou (channel-health.ts)
//   dispatch.cron_stalled    cron do Disparador parou de bater (cron de saúde, sobre o batimento da migration 334)
// Agrupados por campanha/número/cron E por hora: o 1º da hora sai, os repetidos são descartados (claim_alert_slot, atômico no banco).
// Nunca lança e nunca atrasa o fluxo que originou o alerta. Sem dado pessoal de cliente nos payloads: só ids, nomes de campanha/cron,
// cores de qualidade e o motivo técnico.

type Db = any;

export type ActiveAlertEvent = Extract<WebhookEvent, "campaign.auto_paused" | "channel.quality_changed" | "dispatch.cron_stalled">;

const PUSH_KIND: Record<ActiveAlertEvent, OpsAlertKind> = {
  "campaign.auto_paused": "campaign_auto_paused",
  "channel.quality_changed": "channel_quality_changed",
  "dispatch.cron_stalled": "cron_stalled",
};

/** Início da hora cheia (UTC) do instante dado: a janela de agrupamento. */
export function hourBucket(now: Date = new Date()): string {
  const d = new Date(now);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

export function alertKey(event: ActiveAlertEvent, subjectId: string): string {
  return `${event}:${subjectId}`;
}

const isMissingFunction = (e: { code?: string; message?: string } | null | undefined) =>
  !!e && (e.code === "PGRST202" || e.code === "42883" || e.code === "42P01" || e.code === "PGRST205");

// Melhor esforço quando a migration 337 não está aplicada: dedupe só neste processo (some no restart).
const memorySlots = new Map<string, number>();
const MEMORY_SLOTS_MAX = 2000;

/** true = este é o 1º aviso da (conta, chave, hora): pode enviar. */
export async function claimAlertSlot(db: Db, accountId: string, key: string, bucket: string): Promise<boolean> {
  try {
    const { data, error } = await db.rpc("claim_alert_slot", { p_account: accountId, p_key: key, p_bucket: bucket });
    if (!error) return data === true;
    if (!isMissingFunction(error)) {
      console.error("[Alertas] falha ao reservar o aviso:", error.message);
      return false;
    }
  } catch (err) {
    console.error("[Alertas] falha ao reservar o aviso:", err instanceof Error ? err.message : String(err));
    return false;
  }
  const mem = `${accountId}|${key}|${bucket}`;
  if (memorySlots.has(mem)) return false;
  if (memorySlots.size >= MEMORY_SLOTS_MAX) memorySlots.delete(memorySlots.keys().next().value as string);
  memorySlots.set(mem, Date.now());
  return true;
}

export interface ActiveAlertInput {
  accountId: string;
  event: ActiveAlertEvent;
  /** Campanha, número (session_id) ou cron: o agrupamento é por (conta, evento, assunto, hora). */
  subjectId: string;
  /** `data` do webhook de saída (sem dado pessoal de cliente). */
  data: Record<string, unknown>;
  now?: Date;
}

export interface ActiveAlertResult {
  emitted: boolean;
  webhooks: number;
  pushSent: number;
}

export interface ActiveAlertDeps {
  push?: typeof sendOpsAlertPush;
}

export async function emitActiveAlert(db: Db, input: ActiveAlertInput, deps: ActiveAlertDeps = {}): Promise<ActiveAlertResult> {
  const result: ActiveAlertResult = { emitted: false, webhooks: 0, pushSent: 0 };
  try {
    const key = alertKey(input.event, input.subjectId);
    if (!(await claimAlertSlot(db, input.accountId, key, hourBucket(input.now)))) return result;
    result.emitted = true;

    try {
      const { data, error } = await db.rpc("enqueue_webhook_event", {
        p_account: input.accountId,
        p_event: input.event,
        p_event_id: randomUUID(),
        p_data: input.data,
      });
      if (error) {
        if (!isMissingFunction(error)) console.error("[Alertas] falha ao enfileirar o webhook:", error.message);
      } else {
        result.webhooks = typeof data === "number" ? data : 0;
      }
    } catch (err) {
      console.error("[Alertas] falha ao enfileirar o webhook:", err instanceof Error ? err.message : String(err));
    }

    const push = await (deps.push ?? sendOpsAlertPush)(db, { accountId: input.accountId, kind: PUSH_KIND[input.event], tag: key });
    result.pushSent = push.sent;
  } catch (err) {
    console.error("[Alertas] falha inesperada:", err instanceof Error ? err.message : String(err));
  }
  return result;
}

/** Só queda de cor vira alerta de qualidade? Não: qualquer mudança real de cor (subida também interessa), exceto a 1ª leitura e "desconhecido". */
export function shouldAlertQualityChange(qualityOld: string | null, qualityNew: string): boolean {
  return qualityOld !== null && qualityOld !== qualityNew && qualityNew !== "UNKNOWN" && qualityOld !== "UNKNOWN";
}
