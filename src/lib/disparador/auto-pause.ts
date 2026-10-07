// Pausa automática de segurança do disparador.
//
// Se uma campanha em execução começa a falhar em massa (template recusado,
// conta Meta com problema), cada tick do cron continuaria
// queimando contatos e a reputação do número. Aqui o cron avalia as últimas
// tentativas da campanha e, acima do limite, pausa pela MESMA RPC da pausa
// manual (stop_dispatch_campaign(..., 'pause')) — nada de reenvio nem de
// mudança de ritmo: só para, registra o motivo e espera um humano retomar.
//
// Regra (decideAutoPause, pura): janela = até as últimas AUTO_PAUSE_WINDOW
// tentativas concluídas (100). Com pelo menos AUTO_PAUSE_MIN_ATTEMPTS (50)
// na janela e taxa de erro permanente >= AUTO_PAUSE_ERROR_RATE (30%) →
// pausa. Enquanto a campanha tem menos de 100 tentativas, a janela são as
// primeiras N (>= 50); depois, é uma janela móvel das últimas 100.
//
// Limites configuráveis por env (DISPARADOR_AUTO_PAUSE_*);
// DISPARADOR_AUTO_PAUSE=off desliga.

import type { SupabaseClient } from "@supabase/supabase-js";
import { extrairCodigoMetaErro } from "./normalize-meta-error";
import { writeLog } from "@/lib/logger";

export interface AutoPauseConfig {
  enabled: boolean;
  minAttempts: number;
  window: number;
  errorRate: number;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function rate(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : fallback;
}

export const AUTO_PAUSE_DEFAULTS: AutoPauseConfig = {
  enabled: true,
  minAttempts: 50,
  window: 100,
  errorRate: 0.3,
};

export function autoPauseConfigFromEnv(env: Record<string, string | undefined> = process.env): AutoPauseConfig {
  const window = positiveInt(env.DISPARADOR_AUTO_PAUSE_WINDOW, AUTO_PAUSE_DEFAULTS.window);
  return {
    enabled: (env.DISPARADOR_AUTO_PAUSE ?? "on").toLowerCase() !== "off",
    window,
    minAttempts: Math.min(
      window,
      positiveInt(env.DISPARADOR_AUTO_PAUSE_MIN_ATTEMPTS, AUTO_PAUSE_DEFAULTS.minAttempts)
    ),
    errorRate: rate(env.DISPARADOR_AUTO_PAUSE_ERROR_RATE, AUTO_PAUSE_DEFAULTS.errorRate),
  };
}

/** Status finais de uma tentativa (o item já passou pelo provedor). */
export const ATTEMPT_FINAL_STATUSES = ["enviado", "entregue", "lido", "erro", "bloqueado"] as const;
export type AttemptFinalStatus = (typeof ATTEMPT_FINAL_STATUSES)[number];

export interface AttemptRow {
  status: string;
  erro_permanente: boolean | null;
  erro: string | null;
}

interface TimedAttemptRow extends AttemptRow {
  sent_at: string | null;
  updated_at: string;
}

/** Recibos tardios não podem trazer envios antigos para as últimas 100. */
export function recentAttempts(rows: readonly TimedAttemptRow[], window: number): TimedAttemptRow[] {
  return [...rows].sort((a, b) =>
    Date.parse(b.sent_at ?? b.updated_at) - Date.parse(a.sent_at ?? a.updated_at)
  ).slice(0, window);
}

export type AutoPauseDecision =
  | { pause: false; attempts: number; errors: number }
  | {
      pause: true;
      attempts: number;
      errors: number;
      /** 0..100, arredondado. */
      percent: number;
      /** Código Meta mais frequente entre os erros, se houver. */
      topCode: number | null;
      reason: string;
    };

// Lista fechada: só problemas de campanha/template/canal. Códigos de
// destinatário (131026, 131030, 131045, 131021, 131049), limite temporário,
// timeout, erro desconhecido e recusa de ligação NÃO pausam a campanha.
// 190/368: token/política; 131005/131031/131042: acesso/conta/pagamento;
// 131008/131009/131047/131051: parâmetros/janela/tipo de mensagem;
// 132000/132001/132005/132007/132012/132015/132016: template;
// 133010: remetente não registrado. Só contam quando erro_permanente=true.
export const AUTO_PAUSE_META_CODES = new Set([
  190, 368, 131005, 131031, 131042, 131008, 131009, 131047, 131051,
  132000, 132001, 132005, 132007, 132012, 132015, 132016, 133010,
]);

export function isCampaignPermanentError(r: AttemptRow): boolean {
  if ((r.status !== "erro" && r.status !== "bloqueado") || r.erro_permanente !== true) return false;
  const code = extrairCodigoMetaErro(r.erro);
  if (code !== null) return AUTO_PAUSE_META_CODES.has(code);
  // Erros locais inequívocos; não classificamos qualquer 400 da WAHA como
  // problema do canal, pois também pode ser um destinatário inválido.
  return /^(Canal não encontrado para esta conta|Canal Meta sem (token de acesso|phone_number_id) configurado|Não foi possível ler a .+ do canal|Ligação não é suportada em canais Meta|Item .+ do tipo .+ não tem mídia|Variável \{\{\d+\}\} sem valor mapeado)/.test(r.erro ?? "");
}

/**
 * Decide se pausa. `rows` = tentativas mais recentes primeiro (no máximo
 * config.window são consideradas). Erro NÃO permanente ('erro' que ainda
 * vai ser retentado) não conta — nem como tentativa nem como falha — porque
 * o resultado dele ainda não é final.
 */
export function decideAutoPause(
  rows: readonly AttemptRow[],
  config: AutoPauseConfig = AUTO_PAUSE_DEFAULTS
): AutoPauseDecision {
  const window = rows
    .filter((r) => (ATTEMPT_FINAL_STATUSES as readonly string[]).includes(r.status))
    .filter((r) => r.status !== "erro" || r.erro_permanente === true)
    .slice(0, config.window);
  // Erros de destinatário continuam no denominador (tentativas finais),
  // mas nunca no numerador: base com 131026 não deve disparar a proteção.
  const errors = window.filter(isCampaignPermanentError);
  const attempts = window.length;
  if (!config.enabled || attempts < config.minAttempts || attempts === 0) {
    return { pause: false, attempts, errors: errors.length };
  }
  if (errors.length / attempts < config.errorRate) {
    return { pause: false, attempts, errors: errors.length };
  }

  const codeCounts = new Map<number, number>();
  for (const e of errors) {
    const code = extrairCodigoMetaErro(e.erro);
    if (code !== null) codeCounts.set(code, (codeCounts.get(code) ?? 0) + 1);
  }
  let topCode: number | null = null;
  for (const [code, count] of codeCounts) {
    if (topCode === null || count > (codeCounts.get(topCode) ?? 0)) topCode = code;
  }
  const percent = Math.round((errors.length / attempts) * 100);
  const reason =
    `Pausada automaticamente: ${percent}% de erro` +
    (topCode !== null ? ` (código ${topCode})` : "") +
    ` nas últimas ${attempts} tentativas. Corrija a causa e retome a campanha.`;
  return { pause: true, attempts, errors: errors.length, percent, topCode, reason };
}

/**
 * Avalia e, se for o caso, pausa a campanha. Nunca lança — falha aqui não
 * pode derrubar o tick do cron. Devolve true se pausou.
 */
export async function checkCampaignAutoPause(
  db: SupabaseClient,
  campaign: { id: string; account_id?: string | null },
  config: AutoPauseConfig = autoPauseConfigFromEnv()
): Promise<boolean> {
  if (!config.enabled || !campaign.account_id) return false;
  try {
    // select("*"): auto_pausa_avaliar_desde só existe com a migration 159 —
    // sem ela a coluna vem undefined e a janela não tem corte.
    const { data: campRows, error: campError } = await db.from("campaigns").select("*")
      .eq("id", campaign.id).eq("account_id", campaign.account_id).limit(1);
    if (campError || campRows?.[0]?.status !== "em_execucao") return false;
    const since: string | null = campRows?.[0]?.auto_pausa_avaliar_desde ?? null;

    const attemptsQuery = () => db
      .from("disp_message_queue")
      .select("status, erro_permanente, erro, sent_at, updated_at")
      .eq("campaign_id", campaign.id)
      .in("status", [...ATTEMPT_FINAL_STATUSES])
      .gt("tentativas", 0)
      .or("status.neq.erro,erro_permanente.eq.true");
    // Duas buscas limitadas, depois mescladas: sucesso/recibo usa sent_at
    // imutável; rejeição antes de enviar usa updated_at. Não ordenamos por
    // scheduled_at (retry/reflow) nem por entrega/leitura tardia.
    let sentQuery = attemptsQuery().not("sent_at", "is", null);
    let rejectedQuery = attemptsQuery().is("sent_at", null);
    if (since) {
      sentQuery = sentQuery.gte("sent_at", since);
      rejectedQuery = rejectedQuery.gte("updated_at", since);
    }
    const [sent, rejected] = await Promise.all([
      sentQuery.order("sent_at", { ascending: false }).limit(config.window),
      rejectedQuery.order("updated_at", { ascending: false }).limit(config.window),
    ]);
    const error = sent.error ?? rejected.error;
    if (error) {
      console.error("[AutoPause] Falha ao ler tentativas:", campaign.id, error.message);
      return false;
    }

    const rows = recentAttempts([...(sent.data ?? []), ...(rejected.data ?? [])] as TimedAttemptRow[], config.window);
    const decision = decideAutoPause(rows, config);
    if (!decision.pause) return false;

    const { data: paused, error: pauseError } = await db.rpc("stop_dispatch_campaign", {
      p_campaign_id: campaign.id,
      p_account_id: campaign.account_id,
      p_action: "pause",
    });
    if (pauseError || !paused) {
      if (pauseError) console.error("[AutoPause] Falha ao pausar:", campaign.id, pauseError.message);
      return false;
    }

    const { error: noteError } = await db
      .from("campaigns")
      .update({ pausa_automatica_motivo: decision.reason })
      .eq("id", campaign.id)
      .eq("account_id", campaign.account_id)
      .eq("status", "pausada");
    if (noteError) {
      // migration 159 não aplicada: a pausa já valeu; o motivo fica só no log.
      console.error("[AutoPause] Falha ao gravar motivo:", campaign.id, noteError.message);
    }

    await writeLog({
      account_id: campaign.account_id,
      level: "error",
      source: "disparador",
      event: "campaign_auto_paused",
      message: decision.reason,
      payload: {
        campaign_id: campaign.id,
        attempts: decision.attempts,
        errors: decision.errors,
        percent: decision.percent,
        top_code: decision.topCode,
        threshold: config.errorRate,
        min_attempts: config.minAttempts,
        window: config.window,
      },
    });
    return true;
  } catch (err) {
    console.error("[AutoPause] Falha inesperada:", campaign.id, err);
    return false;
  }
}
