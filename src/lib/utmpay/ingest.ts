// UTMpay → CRM: grava o evento (idempotente por event_id), atualiza os resultados do envio (clicou/fechou/pagou), calcula a ATRIBUIÇÃO pela
// conversa e confirma na API DDM a situação do acordo. "Fechou acordo" = etapa payment_start; "Pagou" = etapa paid — e `paid` NUNCA é confiado
// sozinho: o evento só marca `pagou_evento_em`; `pagou_em` só sai quando a API DDM confirma (a rota de conferência tenta de novo se a DDM falhar).
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { computeAttribution, type AttributionMessage } from "@/lib/utmpay/attribution";
import { withinAttributionWindow, type UtmpayEvent } from "@/lib/utmpay/events";
import type { DdmSituation } from "@/lib/billing/ddm-source";

type Db = Pick<SupabaseClient, "from">;

export interface LinkRow {
  tid: string;
  account_id: string;
  campaign_id: string | null;
  contact_id: string | null;
  created_at: string;
  clicou_em: string | null;
  fechou_em: string | null;
  pagou_em: string | null;
  pagou_evento_em: string | null;
}

export const LINK_COLUMNS = "tid, account_id, campaign_id, contact_id, created_at, clicou_em, fechou_em, pagou_em, pagou_evento_em";

export async function loadLinkByTid(db: Db, tid: string): Promise<LinkRow | null> {
  const { data, error } = await db.from("utmpay_links").select(LINK_COLUMNS).eq("tid", tid).maybeSingle();
  if (error) throw new Error(`utmpay: leitura do link falhou (${error.code ?? "erro"})`);
  return (data ?? null) as LinkRow | null;
}

export interface RecordResult {
  duplicate: boolean;
  inWindow: boolean;
}

/** Marca o menor instante (o 1º evento daquela etapa): só grava se a coluna está vazia ou o novo é mais antigo. */
async function setEarliest(db: Db, tid: string, column: "clicou_em" | "fechou_em" | "pagou_evento_em", at: Date): Promise<void> {
  const iso = at.toISOString();
  const { error } = await db.from("utmpay_links").update({ [column]: iso }).eq("tid", tid).or(`${column}.is.null,${column}.gt.${iso}`);
  if (error) throw new Error(`utmpay: atualização do link falhou (${error.code ?? "erro"})`);
}

/** Grava o evento (idempotente) e os marcos do envio. Lança em erro de banco (a rota responde 5xx e o UTMpay tenta de novo com o MESMO event_id). */
export async function recordUtmpayEvent(db: Db, link: LinkRow, event: UtmpayEvent, janelaDias: number): Promise<RecordResult> {
  const inWindow = withinAttributionWindow(new Date(link.created_at), event.occurredAt, janelaDias);
  const { error } = await db.from("utmpay_events").insert({
    event_id: event.eventId,
    account_id: link.account_id,
    tid: link.tid,
    etapa: event.etapa,
    occurred_at: event.occurredAt.toISOString(),
    codigo: event.codigo,
    campanha: event.campanha,
    canal: event.canal,
    in_window: inWindow,
  });
  if (error) {
    if (error.code === "23505") return { duplicate: true, inWindow };
    throw new Error(`utmpay: gravação do evento falhou (${error.code ?? "erro"})`);
  }
  if (event.etapa === "click") await setEarliest(db, link.tid, "clicou_em", event.occurredAt);
  // Fechou e pagou só valem dentro da janela de atribuição (o evento fica gravado, com in_window=false).
  else if (event.etapa === "payment_start" && inWindow) await setEarliest(db, link.tid, "fechou_em", event.occurredAt);
  else if (event.etapa === "paid" && inWindow) await setEarliest(db, link.tid, "pagou_evento_em", event.occurredAt);
  return { duplicate: false, inWindow };
}

export interface EnrichDeps {
  /** Situação do CPF na API DDM (ddm-source). Lança se a DDM estiver fora; sem ela a conferência fica pendente. */
  situation: (cpf: string) => Promise<DdmSituation>;
}

async function contactCpf(db: Db, accountId: string, contactId: string | null): Promise<string | null> {
  if (!contactId) return null;
  const { data } = await db.from("contacts").select("cpf").eq("id", contactId).eq("account_id", accountId).maybeSingle();
  const digits = String((data as { cpf?: string | null } | null)?.cpf ?? "").replace(/\D/g, "");
  return digits.length === 11 ? digits : null;
}

/** Mensagens da conversa do contato entre o envio e o evento (só os campos da atribuição). */
async function conversationMessages(db: Db, link: LinkRow, to: Date): Promise<AttributionMessage[]> {
  if (!link.contact_id) return [];
  const { data: convs } = await db.from("conversations").select("id").eq("account_id", link.account_id).eq("contact_id", link.contact_id);
  const ids = ((convs ?? []) as { id: string }[]).map((c) => c.id);
  if (ids.length === 0) return [];
  const { data } = await db
    .from("messages")
    .select("sender_type, origin, sender_id, created_at")
    .in("conversation_id", ids)
    .gt("created_at", link.created_at)
    .lte("created_at", to.toISOString())
    .order("created_at", { ascending: true })
    .limit(1000);
  return (data ?? []) as AttributionMessage[];
}

/**
 * Depois de payment_start / paid (dentro da janela): atribuição pela conversa e situação na API DDM. Melhor esforço: falha da DDM não perde o
 * evento — fica `pagou_evento_em` sem `pagou_em`, e a conferência periódica tenta de novo.
 */
export async function enrichFromEvent(db: Db, link: LinkRow, event: UtmpayEvent, inWindow: boolean, deps: EnrichDeps, now: Date = new Date()): Promise<void> {
  if (event.etapa !== "payment_start" && event.etapa !== "paid") return;
  if (!inWindow) return; // fora da janela de atribuição: o evento fica gravado, mas não vira resultado
  const updates: Record<string, unknown> = {};

  const messages = await conversationMessages(db, link, event.occurredAt);
  const attribution = computeAttribution(messages, new Date(link.created_at), event.occurredAt);
  updates.atribuicao = attribution.atribuicao;
  updates.atendente_id = attribution.atendenteId;

  const cpf = await contactCpf(db, link.account_id, link.contact_id);
  if (cpf) {
    try {
      const s = await deps.situation(cpf);
      updates.situacao_acordo = s.situacao_acordo;
      updates.valor_em_aberto = s.valor_em_aberto;
      updates.instituicao = s.instituicao;
      updates.verificado_em = now.toISOString();
      if (event.etapa === "paid" && s.settled) updates.pagou_em = event.occurredAt.toISOString();
    } catch (err) {
      // Sem token/limite/DDM fora: segue sem a situação; o `paid` fica pendente de confirmação.
      console.warn("[utmpay] não foi possível consultar a API DDM:", err instanceof Error ? err.message.slice(0, 100) : "erro");
    }
  }
  const { error } = await db.from("utmpay_links").update(updates).eq("tid", link.tid);
  if (error) throw new Error(`utmpay: gravação do resultado falhou (${error.code ?? "erro"})`);
}

/** Confere de novo os `paid` ainda não confirmados (DDM fora do ar na hora do evento). Devolve quantos foram confirmados. */
export async function recheckPendingPayments(db: Db, deps: EnrichDeps, options: { limit?: number; maxAgeDays?: number; now?: Date } = {}): Promise<{ checked: number; confirmed: number }> {
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - (options.maxAgeDays ?? 14) * 86_400_000).toISOString();
  const { data } = await db
    .from("utmpay_links")
    .select("tid, account_id, contact_id, pagou_evento_em")
    .not("pagou_evento_em", "is", null)
    .is("pagou_em", null)
    .gt("pagou_evento_em", since)
    .order("pagou_evento_em", { ascending: true })
    .limit(options.limit ?? 50);
  let checked = 0;
  let confirmed = 0;
  for (const row of (data ?? []) as { tid: string; account_id: string; contact_id: string | null; pagou_evento_em: string }[]) {
    const cpf = await contactCpf(db, row.account_id, row.contact_id);
    if (!cpf) continue;
    checked++;
    try {
      const s = await deps.situation(cpf);
      const patch: Record<string, unknown> = { situacao_acordo: s.situacao_acordo, valor_em_aberto: s.valor_em_aberto, instituicao: s.instituicao, verificado_em: now.toISOString() };
      if (s.settled) {
        patch.pagou_em = row.pagou_evento_em;
        confirmed++;
      }
      await db.from("utmpay_links").update(patch).eq("tid", row.tid);
    } catch {
      // tenta de novo na próxima rodada
    }
  }
  return { checked, confirmed };
}
