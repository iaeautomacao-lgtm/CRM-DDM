import type { SupabaseClient } from "@supabase/supabase-js";

// Público de uma campanha — fonte única para startCampaign (envio) e para
// o modal de confirmação (GET /api/disparador/campaigns/[id]/audience).
//
// Regra (PRD-01): o público é a INTERSEÇÃO do que o usuário escolheu.
//   - CSV importado → só os contatos daquele import (disp_import_contacts,
//     migration 132; import antigo: contact_import_variables).
//   - Tabulações → só quem tem alguma das tags.
//   - CSV + tabulações → contatos do CSV que têm a tag.
//   - Nenhum dos dois → a conta inteira (o modal mostra o total).
// Antes, com tag o CSV era ignorado, e CSV sem colunas VAR não deixava
// rastro — nos dois casos a campanha saía para a conta inteira.

export type AudienceMode = "csv" | "tags" | "account";

export interface AudienceInput {
  allContactIds: string[];
  /** null = campanha sem import; Set vazio = import sem contatos. */
  importIds: Set<string> | null;
  /** null = sem filtro de tabulação. */
  tagIds: Set<string> | null;
  /** campaigns.audience_mode; null em campanhas antigas. */
  mode: AudienceMode | null;
}

export type AudienceResult =
  | { ok: true; ids: Set<string>; source: "csv" | "tags" | "csv+tags" | "account" }
  | { ok: false; error: string };

/** Decisão pura (testável): quem recebe, ou por que não dá para enviar. */
export function computeAudience(input: AudienceInput): AudienceResult {
  const { allContactIds, importIds, tagIds, mode } = input;
  // Campanha marcada como CSV sem nenhum contato vinculado: nunca cai para
  // a conta inteira.
  if (mode === "csv" && (!importIds || importIds.size === 0)) {
    return {
      ok: false,
      error: "O CSV desta campanha não tem contatos vinculados. Reimporte o arquivo antes de iniciar.",
    };
  }
  const useImport = importIds !== null && importIds.size > 0;
  let ids = new Set(allContactIds);
  if (useImport) ids = new Set([...ids].filter((id) => importIds.has(id)));
  if (tagIds) ids = new Set([...ids].filter((id) => tagIds.has(id)));

  const source = useImport ? (tagIds ? "csv+tags" : "csv") : tagIds ? "tags" : "account";
  if (ids.size === 0) {
    return {
      ok: false,
      error:
        source === "csv+tags"
          ? "Nenhum contato do CSV tem as tabulações selecionadas."
          : source === "csv"
            ? "Nenhum contato do CSV foi encontrado na conta."
            : source === "tags"
              ? "Nenhum contato encontrado com as tabulações selecionadas."
              : "Nenhum contato ativo encontrado no CRM.",
    };
  }
  return { ok: true, ids, source };
}

export interface CampaignAudienceRow {
  id: string;
  import_draft_id?: string | null;
  tags_filtro?: unknown;
  audience_mode?: string | null;
}

const PAGE = 1000;

async function pagedIds(
  fetchPage: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
  key: string,
): Promise<string[]> {
  const out: string[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await fetchPage(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as Array<Record<string, string | null>>) {
      const v = row[key];
      if (v) out.push(v);
    }
    if (!data || data.length < PAGE) break;
  }
  return out;
}

/**
 * Carrega contatos, import e tags e aplica computeAudience. Devolve as
 * linhas completas dos contatos do público (startCampaign usa nome,
 * telefone, cpf…). Erro de leitura do vínculo do import aborta — nunca
 * "sem filtro".
 */
export async function loadCampaignAudience(
  db: SupabaseClient,
  accountId: string,
  campaign: CampaignAudienceRow,
  contactColumns = "id, name, phone, company, phone_normalized, cpf",
): Promise<
  | { ok: true; contacts: Array<Record<string, any>>; source: string; importCount: number | null }
  | { ok: false; error: string }
> {
  const allContacts: Array<Record<string, any>> = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("contacts")
      .select(contactColumns)
      .eq("account_id", accountId)
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Erro ao carregar contatos: ${error.message}`);
    allContacts.push(...((data ?? []) as unknown as Array<Record<string, any>>));
    if (!data || data.length < PAGE) break;
  }

  // Vínculo explícito do import (migration 132), por rascunho e por campanha.
  const importRows = new Set<string>();
  const filters = [
    campaign.import_draft_id ? `draft_id.eq.${campaign.import_draft_id}` : null,
    `campaign_id.eq.${campaign.id}`,
  ].filter(Boolean) as string[];
  for (const id of await pagedIds(
    (from, to) =>
      db.from("disp_import_contacts").select("contact_id").or(filters.join(",")).range(from, to),
    "contact_id",
  )) {
    importRows.add(id);
  }
  // Imports anteriores à 132: só deixavam rastro quando tinham VARn.
  if (importRows.size === 0 && campaign.import_draft_id) {
    for (const id of await pagedIds(
      (from, to) =>
        db
          .from("contact_import_variables")
          .select("contact_id")
          .eq("draft_id", campaign.import_draft_id as string)
          .range(from, to),
      "contact_id",
    )) {
      importRows.add(id);
    }
  }

  const tagsFiltro = Array.isArray(campaign.tags_filtro) ? (campaign.tags_filtro as string[]) : [];
  let tagIds: Set<string> | null = null;
  if (tagsFiltro.length > 0) {
    const { data: tags, error: tagErr } = await db
      .from("tags")
      .select("id")
      .eq("account_id", accountId)
      .in("name", tagsFiltro);
    if (tagErr) throw new Error(`Erro ao resolver tags de filtro: ${tagErr.message}`);
    const ids = (tags ?? []).map((t: { id: string }) => t.id);
    tagIds = new Set(
      ids.length === 0
        ? []
        : await pagedIds(
            (from, to) => db.from("contact_tags").select("contact_id").in("tag_id", ids).range(from, to),
            "contact_id",
          ),
    );
  }

  const mode = (["csv", "tags", "account"] as const).find((m) => m === campaign.audience_mode) ?? null;
  const result = computeAudience({
    allContactIds: allContacts.map((c) => c.id as string),
    importIds: importRows.size > 0 || mode === "csv" ? importRows : null,
    tagIds,
    mode,
  });
  if (!result.ok) return result;
  return {
    ok: true,
    contacts: allContacts.filter((c) => result.ids.has(c.id as string)),
    source: result.source,
    importCount: importRows.size > 0 ? importRows.size : null,
  };
}
