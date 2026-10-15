// Pausar, retomar e cancelar campanha — operações de negócio compartilhadas (API pública v1 hoje; a tela passa a usar no bloco B,
// junto dos eventos de webhook). Sem Request/sessão: recebem (conta, campanha). Nunca lançam por regra de negócio: devolvem o resultado.
//
// A decisão é tomada DENTRO das RPCs com lock da campanha (migration 118: stop_dispatch_campaign / resume_dispatch_campaign; na 184 elas só
// trocam o status e os itens se movem em lotes por drainDispatchMoves). Aqui só se lê o estado antes para escolher a mensagem certa e
// resolver a idempotência ("já estava pausada" não é erro).
import type { SupabaseClient } from "@supabase/supabase-js";
import { drainDispatchMoves } from "@/lib/disparador/queue-moves";
import { allTemplatesApproved, templatesOfCampaign } from "@/lib/disparador/template-pause";

type Db = Pick<SupabaseClient, "from" | "rpc">;

/** Quem pediu a ação (vai para o evento de webhook e para a auditoria). A tela usa 'user'; a API pública, 'api'. */
export type ControlActor = "user" | "api";

export interface CampaignState {
  id: string;
  status: string;
  pausa_automatica_motivo: string | null;
  mensagens: unknown;
}

export type ControlFailure =
  | { ok: false; kind: "not_found"; message: string }
  | { ok: false; kind: "conflict"; message: string; details: Record<string, unknown> }
  | { ok: false; kind: "blocked"; message: string; details: Record<string, unknown> }
  | { ok: false; kind: "internal"; message: string };

export type ControlSuccess = { ok: true; changed: boolean; previous: string; status: string; itemsPendingMove: boolean };
export type ControlResult = ControlSuccess | ControlFailure;

const STATE_COLUMNS = "id, status, pausa_automatica_motivo, mensagens";

export async function readCampaignState(db: Db, accountId: string, campaignId: string): Promise<CampaignState | null> {
  const { data, error } = await db.from("campaigns").select(STATE_COLUMNS).eq("id", campaignId).eq("account_id", accountId).limit(1);
  if (error) throw error;
  return ((data?.[0] ?? null) as CampaignState | null);
}

const conflict = (state: string, message: string): ControlFailure => ({ ok: false, kind: "conflict", message, details: { status: state } });
const NOT_FOUND: ControlFailure = { ok: false, kind: "not_found", message: "Campanha não encontrada" };

/** Colunas novas (migration 357) ausentes não derrubam a operação: o motivo só deixa de ser gravado. */
async function bestEffortUpdate(db: Db, accountId: string, campaignId: string, status: string, fields: Record<string, unknown>): Promise<void> {
  const { error } = await db.from("campaigns").update(fields).eq("id", campaignId).eq("account_id", accountId).eq("status", status);
  if (error && error.code !== "42703" && !/does not exist|schema cache/i.test(error.message)) {
    console.error("[campaign-control] falha ao gravar motivo:", error.message);
  }
}

/** Pausa uma campanha em execução. Já pausada = sucesso sem mudança. */
export async function pauseCampaign(db: Db, input: { accountId: string; campaignId: string; reason?: string | null; by?: ControlActor }): Promise<ControlResult> {
  const state = await readCampaignState(db, input.accountId, input.campaignId);
  if (!state) return NOT_FOUND;
  if (state.status === "pausada") return { ok: true, changed: false, previous: "pausada", status: "pausada", itemsPendingMove: false };
  if (state.status !== "em_execucao") {
    return conflict(state.status, "Só é possível pausar uma campanha em execução");
  }
  const { data: changed, error } = await db.rpc("stop_dispatch_campaign", { p_campaign_id: input.campaignId, p_account_id: input.accountId, p_action: "pause" });
  if (error) return { ok: false, kind: "internal", message: "Falha ao pausar a campanha" };
  if (!changed) {
    // Perdeu a corrida (outro usuário pausou/encerrou no meio): relê para responder com o estado real.
    const now = await readCampaignState(db, input.accountId, input.campaignId);
    if (now?.status === "pausada") return { ok: true, changed: false, previous: "pausada", status: "pausada", itemsPendingMove: false };
    return conflict(now?.status ?? "desconhecido", "O estado da campanha mudou; consulte-a antes de pausar");
  }
  const moves = await drainDispatchMoves(db as SupabaseClient, input.campaignId, { budgetMs: 15_000 });
  const reason = input.reason?.trim();
  if (reason) await bestEffortUpdate(db, input.accountId, input.campaignId, "pausada", { pause_reason: reason });
  // EVENTO campaign.paused: emitir aqui (só com changed:true), com by = input.by ?? "api", reason e itemsPendingMove.
  return { ok: true, changed: true, previous: "em_execucao", status: "pausada", itemsPendingMove: moves.partial || !moves.ok };
}

/** Cancela (encerra) uma campanha. Irreversível: itens agendados/pausados viram `cancelado`. Já encerrada = sucesso sem mudança. */
export async function cancelCampaign(db: Db, input: { accountId: string; campaignId: string; motive: "cancelled" | "cancelled_api"; by?: ControlActor }): Promise<ControlResult> {
  const state = await readCampaignState(db, input.accountId, input.campaignId);
  if (!state) return NOT_FOUND;
  if (state.status === "encerrada") return { ok: true, changed: false, previous: "encerrada", status: "encerrada", itemsPendingMove: false };
  // A RPC aceita 'stop' em qualquer estado; rascunho/preparando são criação em andamento e não se cancelam por aqui.
  if (!["em_execucao", "pausada", "agendado"].includes(state.status)) {
    return conflict(state.status, "Só é possível cancelar uma campanha em execução, pausada ou agendada");
  }
  const { data: changed, error } = await db.rpc("stop_dispatch_campaign", { p_campaign_id: input.campaignId, p_account_id: input.accountId, p_action: "stop" });
  if (error) return { ok: false, kind: "internal", message: "Falha ao cancelar a campanha" };
  if (!changed) return NOT_FOUND;
  const moves = await drainDispatchMoves(db as SupabaseClient, input.campaignId, { budgetMs: 15_000 });
  await bestEffortUpdate(db, input.accountId, input.campaignId, "encerrada", { encerramento_motivo: input.motive });
  // EVENTO campaign.cancelled: emitir aqui (só com changed:true), com by = input.by ?? (motive === "cancelled_api" ? "api" : "user") e previous.
  return { ok: true, changed: true, previous: state.status, status: "encerrada", itemsPendingMove: moves.partial || !moves.ok };
}

export type StartFn = (campaignId: string, accountId: string) => Promise<{ ok: true } | { ok: false; status: number; error: string; code?: string }>;

async function defaultStart(campaignId: string, accountId: string) {
  // Import tardio: startCampaign puxa o motor inteiro.
  const { startCampaign } = await import("@/lib/disparador/startCampaign");
  return startCampaign(campaignId, accountId);
}

/**
 * Retoma uma campanha pausada. Guardas que a tela não precisa (lá há uma pessoa olhando):
 *  - pausada pelo motor (taxa de erro etc.): só com `acknowledgeAutoPause`;
 *  - algum template da campanha não está APPROVED: bloqueia (a Meta recusaria os envios);
 *  - número em qualidade vermelha: bloqueia SEMPRE (a confirmação é do proprietário, na tela — startCampaign sem `redConfirmation` recusa).
 */
export async function resumeCampaign(
  db: Db,
  input: { accountId: string; campaignId: string; acknowledgeAutoPause: boolean; by?: ControlActor },
  start: StartFn = defaultStart,
): Promise<ControlResult> {
  const state = await readCampaignState(db, input.accountId, input.campaignId);
  if (!state) return NOT_FOUND;
  if (state.status === "em_execucao") return { ok: true, changed: false, previous: "em_execucao", status: "em_execucao", itemsPendingMove: false };
  if (state.status !== "pausada") return conflict(state.status, "Só é possível retomar uma campanha pausada");

  if (state.pausa_automatica_motivo && !input.acknowledgeAutoPause) {
    return {
      ok: false,
      kind: "conflict",
      message: "A campanha foi pausada automaticamente; confirme com 'acknowledge_auto_pause': true depois de corrigir a causa",
      details: { status: state.status, code: "auto_paused", reason: state.pausa_automatica_motivo },
    };
  }
  const templates = templatesOfCampaign(state.mensagens);
  if (templates.length > 0) {
    let approved = true;
    try {
      approved = await allTemplatesApproved(db as SupabaseClient, input.accountId, templates);
    } catch {
      return { ok: false, kind: "internal", message: "Não foi possível conferir o status dos templates" };
    }
    if (!approved) {
      return {
        ok: false,
        kind: "blocked",
        message: "Há template da campanha que não está aprovado na Meta; a campanha só retoma quando todos estiverem aprovados",
        details: { code: "template_not_approved", templates },
      };
    }
  }

  const result = await start(input.campaignId, input.accountId);
  if (!result.ok) {
    if (result.code) {
      return { ok: false, kind: "blocked", message: result.error, details: { code: "red_quality", channels: (result as { channels?: unknown }).channels ?? [] } };
    }
    if (result.status === 409) return conflict("desconhecido", result.error);
    return { ok: false, kind: "internal", message: "Falha ao retomar a campanha" };
  }
  await bestEffortUpdate(db, input.accountId, input.campaignId, "em_execucao", { pause_reason: null });
  // EVENTO campaign.resumed: emitir aqui (só com changed:true), com by = input.by ?? "api".
  return { ok: true, changed: true, previous: "pausada", status: "em_execucao", itemsPendingMove: false };
}
