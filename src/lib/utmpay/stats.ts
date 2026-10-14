// Contagens e selos do funil UTMpay (migration 356) para as APIs de campanha, contato, conversa e ranking. Só dados, sem CPF.
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadUtmpayConfig } from "@/lib/utmpay/config";

type Db = Pick<SupabaseClient, "from" | "rpc">;

export interface FunnelAttribution {
  direto?: number;
  ia?: number;
  humano?: number;
}

export interface FunnelStats {
  links: number;
  clicou: number;
  fechou: number;
  pagou: number;
  por_atribuicao: { fechou: FunnelAttribution; pagou: FunnelAttribution };
  por_atendente: { atendente_id: string; fechou: number; pagou: number }[];
}

export interface FunnelView {
  available: boolean;
  tracking: boolean;
  entregues: number;
  links: number;
  clicou: number;
  fechou: number;
  pagou: number;
  taxas: { clicou: number | null; fechou: number | null; pagou: number | null };
  por_atribuicao: { fechou: Required<FunnelAttribution>; pagou: Required<FunnelAttribution> };
  por_atendente: { atendente_id: string; atendente_nome: string | null; fechou: number; pagou: number }[];
}

const full = (a: FunnelAttribution | undefined): Required<FunnelAttribution> => ({ direto: a?.direto ?? 0, ia: a?.ia ?? 0, humano: a?.humano ?? 0 });

/** Taxa = contagem ÷ entregues (entregue + lido); o denominador nunca fica abaixo da própria contagem. null sem entregues. */
export function rate(count: number, delivered: number): number | null {
  const denominator = Math.max(delivered, count);
  return denominator > 0 ? count / denominator : null;
}

export function buildFunnelView(input: { available: boolean; tracking: boolean; delivered: number; stats: FunnelStats | null; names?: Map<string, string> }): FunnelView {
  const s = input.stats;
  const clicou = s?.clicou ?? 0;
  const fechou = s?.fechou ?? 0;
  const pagou = s?.pagou ?? 0;
  const entregues = Math.max(input.delivered, clicou, fechou, pagou);
  return {
    available: input.available,
    tracking: input.tracking,
    entregues,
    links: s?.links ?? 0,
    clicou,
    fechou,
    pagou,
    taxas: { clicou: rate(clicou, input.delivered), fechou: rate(fechou, input.delivered), pagou: rate(pagou, input.delivered) },
    por_atribuicao: { fechou: full(s?.por_atribuicao?.fechou), pagou: full(s?.por_atribuicao?.pagou) },
    por_atendente: (s?.por_atendente ?? []).map((a) => ({ ...a, atendente_nome: input.names?.get(a.atendente_id) ?? null })),
  };
}

/** Nomes dos atendentes (profiles.full_name) por user_id. */
export async function loadAttendantNames(db: Db, ids: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  const { data } = await db.from("profiles").select("user_id, full_name").in("user_id", unique);
  for (const row of (data ?? []) as { user_id: string; full_name: string | null }[]) if (row.full_name) out.set(row.user_id, row.full_name);
  return out;
}

/** Funil de UMA campanha. Sem a migration 356 ⇒ available:false. `delivered` = entregue + lido da fila. */
export async function loadCampaignFunnel(db: Db, accountId: string, campaignId: string, delivered: number): Promise<FunnelView> {
  const config = await loadUtmpayConfig(db, accountId);
  const tracking = !!config?.enabled;
  const { data, error } = await db.rpc("utmpay_funnel", { p_account: accountId, p_campaign: campaignId, p_since: null });
  if (error) return buildFunnelView({ available: false, tracking, delivered, stats: null });
  const stats = (data ?? null) as FunnelStats | null;
  const names = await loadAttendantNames(db, (stats?.por_atendente ?? []).map((a) => a.atendente_id));
  return buildFunnelView({ available: true, tracking, delivered, stats, names });
}

// ---------- Selo por contato / conversa ----------

export interface LinkResultRow {
  tid: string;
  campaign_id: string | null;
  created_at: string;
  clicou_em: string | null;
  fechou_em: string | null;
  pagou_em: string | null;
  atribuicao: string | null;
  atendente_id: string | null;
  situacao_acordo: string | null;
  valor_em_aberto: number | string | null;
  instituicao: string | null;
  verificado_em: string | null;
}

export const RESULT_COLUMNS = "tid, campaign_id, created_at, clicou_em, fechou_em, pagou_em, atribuicao, atendente_id, situacao_acordo, valor_em_aberto, instituicao, verificado_em";

export interface Badge {
  campanha: string | null;
  enviado_em: string;
  clicou_em: string | null;
  fechou_em: string | null;
  pagou_em: string | null;
  atribuicao: "direto" | "ia" | "humano" | null;
  atendente_nome: string | null;
  situacao_acordo: string | null;
  valor_em_aberto: number | null;
  instituicao: string | null;
  verificado_em: string | null;
}

export function toBadge(row: LinkResultRow, campanha: string | null, atendenteNome: string | null): Badge {
  const attribution = row.atribuicao === "direto" || row.atribuicao === "ia" || row.atribuicao === "humano" ? row.atribuicao : null;
  const valor = row.valor_em_aberto === null || row.valor_em_aberto === undefined ? null : Number(row.valor_em_aberto);
  return {
    campanha,
    enviado_em: row.created_at,
    clicou_em: row.clicou_em,
    fechou_em: row.fechou_em,
    pagou_em: row.pagou_em,
    atribuicao: attribution,
    atendente_nome: atendenteNome,
    situacao_acordo: row.situacao_acordo,
    valor_em_aberto: valor !== null && Number.isFinite(valor) ? valor : null,
    instituicao: row.instituicao,
    verificado_em: row.verificado_em,
  };
}

/** Selo MAIS RECENTE do contato (null se nunca recebeu link rastreado). Sem a migration ⇒ null. */
export async function loadContactBadge(db: Db, accountId: string, contactId: string): Promise<Badge | null> {
  const { data, error } = await db
    .from("utmpay_links")
    .select(RESULT_COLUMNS)
    .eq("account_id", accountId)
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) return null;
  const row = (data?.[0] ?? null) as LinkResultRow | null;
  if (!row) return null;
  let campaignName: string | null = null;
  if (row.campaign_id) {
    const { data: c } = await db.from("campaigns").select("nome").eq("id", row.campaign_id).eq("account_id", accountId).maybeSingle();
    campaignName = (c as { nome?: string | null } | null)?.nome ?? null;
  }
  const names = await loadAttendantNames(db, [row.atendente_id]);
  return toBadge(row, campaignName, row.atendente_id ? (names.get(row.atendente_id) ?? null) : null);
}

/** Resultado por envio (id do item da fila = tid) para as linhas do detalhamento da campanha. */
export interface ItemResult {
  clicou: boolean;
  fechou: boolean;
  pagou: boolean;
  rastreio: {
    clicou_em: string | null;
    fechou_em: string | null;
    pagou_em: string | null;
    atribuicao: Badge["atribuicao"];
    atendente_id: string | null;
    atendente_nome: string | null;
    situacao_acordo: string | null;
    valor_em_aberto: number | null;
    instituicao: string | null;
    verificado_em: string | null;
  };
}

export async function loadItemResults(db: Db, accountId: string, itemIds: readonly string[]): Promise<Map<string, ItemResult>> {
  const out = new Map<string, ItemResult>();
  if (itemIds.length === 0) return out;
  const { data, error } = await db.from("utmpay_links").select(RESULT_COLUMNS).eq("account_id", accountId).in("tid", [...itemIds]);
  if (error || !Array.isArray(data)) return out;
  const rows = data as LinkResultRow[];
  const names = await loadAttendantNames(db, rows.map((r) => r.atendente_id));
  for (const r of rows) {
    const badge = toBadge(r, null, r.atendente_id ? (names.get(r.atendente_id) ?? null) : null);
    out.set(r.tid, {
      clicou: !!r.clicou_em,
      fechou: !!r.fechou_em,
      pagou: !!r.pagou_em,
      rastreio: {
        clicou_em: r.clicou_em,
        fechou_em: r.fechou_em,
        pagou_em: r.pagou_em,
        atribuicao: badge.atribuicao,
        atendente_id: r.atendente_id,
        atendente_nome: badge.atendente_nome,
        situacao_acordo: r.situacao_acordo,
        valor_em_aberto: badge.valor_em_aberto,
        instituicao: r.instituicao,
        verificado_em: r.verificado_em,
      },
    });
  }
  return out;
}
