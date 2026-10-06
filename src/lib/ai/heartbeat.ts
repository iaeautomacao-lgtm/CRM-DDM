/* eslint-disable @typescript-eslint/no-explicit-any -- cliente admin com schema wacrm */
// "IA trabalhando" — heartbeat em conversations.ai_in_progress_at
// (migration 152).
//
// O vigia de IA travada (flows/ai-watchdog.ts) transferia para humano
// qualquer conversa sem resposta há AI_STALL_SECONDS, mesmo com a IA ainda
// gerando (debounce + várias rodadas do modelo + tools com retry passam de
// 90 s no pior caso legítimo) — e a IA respondia DEPOIS do handoff. Agora
// cada tentativa (handleAiAutoResponse) marca o horário ao reservar a
// mensagem e a cada etapa (tool chamada/retornada, envio); o vigia não
// mexe na conversa enquanto a marca tiver menos de AI_HEARTBEAT_FRESH_MS.
// Ao terminar (enviada, pulada ou falha) a marca é limpa.
//
// Sem estado em memória entre requisições: se o processo cair no meio, a
// marca para de ser renovada e envelhece sozinha — o vigia volta a agir.
// Best-effort: falha ao gravar nunca derruba a resposta da IA.

import type { SupabaseClient } from "@supabase/supabase-js";

type Db = SupabaseClient<any, any, any>;

/** Heartbeat mais novo que isto = IA ainda trabalhando. */
export const AI_HEARTBEAT_FRESH_MS = 120_000;
/** Intervalo mínimo entre gravações (evita um UPDATE por evento). */
export const AI_HEARTBEAT_MIN_INTERVAL_MS = 15_000;

export function isAiHeartbeatFresh(
  heartbeatAt: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!heartbeatAt) return false;
  const t = new Date(heartbeatAt).getTime();
  if (!Number.isFinite(t)) return false;
  return now.getTime() - t < AI_HEARTBEAT_FRESH_MS;
}

export interface AiHeartbeat {
  /** Renova a marca (respeita o intervalo mínimo, salvo `force`). */
  beat(force?: boolean): Promise<void>;
  /** Limpa a marca — só se ainda for a gravada por esta tentativa. */
  clear(): Promise<void>;
}

export function createAiHeartbeat(
  db: Db,
  conversationId: string,
  clock: () => number = Date.now,
): AiHeartbeat {
  let lastWrittenIso: string | null = null;
  let lastWrittenMs = 0;
  let disabled = false;

  const report = (err: unknown) => {
    // Coluna ainda não criada (migration 152 pendente) ou erro transitório:
    // registra uma vez e para de tentar nesta tentativa.
    disabled = true;
    const msg = err && typeof err === "object" && "message" in err ? (err as { message: string }).message : String(err);
    console.warn("[AI Agent] heartbeat ai_in_progress_at indisponível:", msg);
  };

  return {
    async beat(force = false) {
      if (disabled) return;
      const nowMs = clock();
      if (!force && lastWrittenIso && nowMs - lastWrittenMs < AI_HEARTBEAT_MIN_INTERVAL_MS) return;
      const iso = new Date(nowMs).toISOString();
      try {
        const { error } = await db
          .from("conversations")
          .update({ ai_in_progress_at: iso })
          .eq("id", conversationId);
        if (error) return report(error);
        lastWrittenIso = iso;
        lastWrittenMs = nowMs;
      } catch (err) {
        report(err);
      }
    },
    async clear() {
      if (!lastWrittenIso) return;
      const mine = lastWrittenIso;
      lastWrittenIso = null;
      try {
        const { error } = await db
          .from("conversations")
          .update({ ai_in_progress_at: null })
          .eq("id", conversationId)
          // Outra tentativa (outro nó/mensagem) pode ter renovado depois.
          .eq("ai_in_progress_at", mine);
        if (error) console.warn("[AI Agent] falha ao limpar ai_in_progress_at:", error.message);
      } catch (err) {
        console.warn("[AI Agent] falha ao limpar ai_in_progress_at:", err);
      }
    },
  };
}
