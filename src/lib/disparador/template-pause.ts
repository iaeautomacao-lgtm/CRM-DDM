import type { SupabaseClient } from "@supabase/supabase-js";
import { writeLog } from "@/lib/logger";

// Template PAUSED/DISABLED no meio da campanha (decisão do dono 13/10, item 6; migration 336).
//   - A Meta pausa/desativa o template → toda campanha EM EXECUÇÃO que o usa é pausada NA HORA (stop_dispatch_campaign, a mesma pausa
//     manual/automática), com o motivo legível em pausa_automatica_motivo (aparece no Monitor) e a marca de qual template a pausou.
//   - O template volta a APPROVED → as campanhas marcadas por ele são retomadas (se TODOS os templates delas estiverem aprovados).
// Só lógica e código: nenhum texto de campanha/template do cliente é alterado.

type Db = Pick<SupabaseClient, "from" | "rpc">;

export type PausingTemplateStatus = "PAUSED" | "DISABLED";

export const DEFAULT_TEMPLATE_LANGUAGE = "pt_BR";

interface CampaignMessage {
  template_name?: string | null;
  template_language?: string | null;
}

/** Nomes/idiomas de template usados nas mensagens de uma campanha (WAHA e mensagens sem template ficam de fora). */
export function templatesOfCampaign(mensagens: unknown): Array<{ name: string; language: string }> {
  if (!Array.isArray(mensagens)) return [];
  const seen = new Set<string>();
  const out: Array<{ name: string; language: string }> = [];
  for (const m of mensagens as CampaignMessage[]) {
    const name = typeof m?.template_name === "string" ? m.template_name.trim() : "";
    if (!name) continue;
    const language = (typeof m?.template_language === "string" && m.template_language) || DEFAULT_TEMPLATE_LANGUAGE;
    const key = `${name}|${language}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ name, language });
    }
  }
  return out;
}

export function campaignUsesTemplate(mensagens: unknown, name: string, language: string | null | undefined): boolean {
  const lang = language || DEFAULT_TEMPLATE_LANGUAGE;
  return templatesOfCampaign(mensagens).some((t) => t.name === name && t.language === lang);
}

/** Motivo legível para o operador (Monitor). `reason` é o texto da Meta, quando vier. */
export function templatePauseReason(name: string, status: PausingTemplateStatus, reason?: string | null): string {
  const what = status === "PAUSED" ? "pausado pela Meta (baixa qualidade ou reclamações)" : "desativado pela Meta";
  const why = reason && reason.trim() ? ` Motivo informado: ${reason.trim().slice(0, 200)}.` : "";
  return (
    `Campanha pausada automaticamente: o template "${name}" foi ${what}.${why} ` +
    `Ela retoma sozinha quando o template voltar a ser aprovado; ou troque o template e retome pela tela.`
  );
}

const isMissingColumn = (error: { code?: string; message?: string }) =>
  error.code === "42703" || error.code === "PGRST204" || /pausa_template/i.test(error.message ?? "");

/** Pausa, na hora, as campanhas em execução da conta que usam o template. Nunca lança (o webhook não pode falhar por isto). */
export async function pauseCampaignsForTemplate(
  db: Db,
  args: { accountId: string; name: string; language: string | null | undefined; status: PausingTemplateStatus; reason?: string | null },
): Promise<{ paused: string[] }> {
  const paused: string[] = [];
  try {
    const { data, error } = await db
      .from("campaigns")
      .select("id, nome, mensagens")
      .eq("account_id", args.accountId)
      .eq("status", "em_execucao");
    if (error) throw new Error(error.message);
    const language = args.language || DEFAULT_TEMPLATE_LANGUAGE;
    const motivo = templatePauseReason(args.name, args.status, args.reason);
    for (const c of (data ?? []) as Array<{ id: string; nome?: string | null; mensagens?: unknown }>) {
      if (!campaignUsesTemplate(c.mensagens, args.name, language)) continue;
      const { data: ok, error: pauseError } = await db.rpc("stop_dispatch_campaign", { p_campaign_id: c.id, p_account_id: args.accountId, p_action: "pause" });
      if (pauseError || !ok) {
        if (pauseError) console.error("[template-pause] falha ao pausar", c.id, pauseError.message);
        continue;
      }
      paused.push(c.id);
      const mark = { pausa_automatica_motivo: motivo, pausa_template_nome: args.name, pausa_template_idioma: language };
      let { error: noteError } = await db.from("campaigns").update(mark).eq("id", c.id).eq("account_id", args.accountId).eq("status", "pausada");
      if (noteError && isMissingColumn(noteError)) {
        // Migration 336 ausente: a pausa já valeu; grava só o motivo (a retomada automática depende da marca).
        ({ error: noteError } = await db.from("campaigns").update({ pausa_automatica_motivo: motivo }).eq("id", c.id).eq("account_id", args.accountId).eq("status", "pausada"));
      }
      if (noteError) console.error("[template-pause] falha ao gravar o motivo", c.id, noteError.message);
      void writeLog({
        account_id: args.accountId,
        level: "error",
        source: "disparador",
        event: "campaign_template_paused",
        message: motivo,
        payload: { campaign_id: c.id, campaign_name: c.nome ?? null, template_name: args.name, template_language: language, template_status: args.status },
      });
    }
  } catch (error) {
    console.error("[template-pause] falha ao pausar campanhas do template:", error instanceof Error ? error.message : error);
  }
  return { paused };
}

export type ResumeCampaign = (campaignId: string, accountId: string) => Promise<{ ok: boolean; error?: string }>;

/**
 * O template voltou a APPROVED: retoma as campanhas pausadas POR ELE. Só retoma a campanha cujos templates estejam TODOS aprovados
 * (ela pode usar mais de um). Nunca lança. `resume` é injetável (padrão: startCampaign, que também respeita o gate de qualidade RED).
 */
export async function resumeCampaignsForTemplate(
  db: Db,
  args: { accountId: string; name: string; language: string | null | undefined },
  resume: ResumeCampaign = defaultResume,
): Promise<{ resumed: string[]; waiting: string[] }> {
  const resumed: string[] = [];
  const waiting: string[] = [];
  try {
    const language = args.language || DEFAULT_TEMPLATE_LANGUAGE;
    const { data, error } = await db
      .from("campaigns")
      .select("id, nome, mensagens")
      .eq("account_id", args.accountId)
      .eq("status", "pausada")
      .eq("pausa_template_nome", args.name)
      .eq("pausa_template_idioma", language);
    if (error) {
      // Sem a migration 336 não há marca: nada a retomar automaticamente.
      if (!isMissingColumn(error)) console.error("[template-pause] falha ao ler campanhas pausadas por template:", error.message);
      return { resumed, waiting };
    }
    for (const c of (data ?? []) as Array<{ id: string; nome?: string | null; mensagens?: unknown }>) {
      if (!(await allTemplatesApproved(db, args.accountId, templatesOfCampaign(c.mensagens)))) {
        waiting.push(c.id);
        continue;
      }
      const result = await resume(c.id, args.accountId);
      if (!result.ok) {
        waiting.push(c.id);
        console.error("[template-pause] não foi possível retomar", c.id, result.error ?? "");
        continue;
      }
      resumed.push(c.id);
      await db.from("campaigns").update({ pausa_template_nome: null, pausa_template_idioma: null }).eq("id", c.id).eq("account_id", args.accountId);
      void writeLog({
        account_id: args.accountId,
        level: "info",
        source: "disparador",
        event: "campaign_template_resumed",
        message: `Template "${args.name}" aprovado de novo: campanha retomada automaticamente`,
        payload: { campaign_id: c.id, campaign_name: c.nome ?? null, template_name: args.name, template_language: language },
      });
    }
  } catch (error) {
    console.error("[template-pause] falha ao retomar campanhas do template:", error instanceof Error ? error.message : error);
  }
  return { resumed, waiting };
}

/** Todos os templates da campanha existem e nenhuma linha deles está PAUSED/DISABLED; pelo menos uma está APPROVED. */
export async function allTemplatesApproved(db: Db, accountId: string, templates: Array<{ name: string; language: string }>): Promise<boolean> {
  if (templates.length === 0) return true;
  const { data, error } = await db
    .from("message_templates")
    .select("name, language, status")
    .eq("account_id", accountId)
    .in("name", templates.map((t) => t.name));
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<{ name: string; language: string | null; status: string | null }>;
  return templates.every((t) => {
    const same = rows.filter((r) => r.name === t.name && (r.language || DEFAULT_TEMPLATE_LANGUAGE) === t.language);
    const status = (r: { status: string | null }) => (r.status ?? "").toUpperCase();
    return same.some((r) => status(r) === "APPROVED") && !same.some((r) => status(r) === "PAUSED" || status(r) === "DISABLED");
  });
}

async function defaultResume(campaignId: string, accountId: string): Promise<{ ok: boolean; error?: string }> {
  // Import tardio: startCampaign puxa o motor inteiro; só carrega quando há campanha para retomar.
  const { startCampaign } = await import("@/lib/disparador/startCampaign");
  const result = await startCampaign(campaignId, accountId);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}
