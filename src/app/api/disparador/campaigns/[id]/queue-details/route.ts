import { NextResponse } from "next/server";
import { logAuditEvent } from "@/lib/audit/log-event";
import * as XLSX from "xlsx";

import { toErrorResponse } from "@/lib/auth/account";
import { requireDisparadorAccess } from "@/lib/disparador/route-auth";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { totalFromStatusCounts } from "@/lib/disparador/queue-total";
import { EXPORT_SYNC_MAX_ROWS } from "@/lib/disparador/export-jobs";
import {
  attachLegacyCsvNames,
  SELECT_COLUMNS,
  SELECT_COLUMNS_REPLIED,
  toDetailRow,
  type QueueDetailRow,
  type QueueRow,
} from "@/lib/disparador/queue-details-rows";
import {
  PENDING_CONFIRMATION_OR_FILTER,
  PENDING_CONFIRMATION_QUEUE_DETAIL_KEY,
  QUEUE_DETAIL_STATUS_FILTERS,
  REPLIED_QUEUE_DETAIL_KEY,
} from "@/lib/disparador/queue-status-filters";

// GET /api/disparador/campaigns/[id]/queue-details?status=enviado&search=&page=1&pageSize=50
// GET /api/disparador/campaigns/[id]/queue-details?status=erro&export=xlsx
//
// Detalhamento por contato de uma métrica do modal de métricas da
// campanha (campanhas/page.tsx). `status` é a chave da métrica clicada,
// não necessariamente um valor literal de disp_message_queue.status —
// "agendado" representa o card "A enviar" e agrega trabalho ainda não
// concluído (agendado/pendente/pausado/enviando); "enviado" e "entregue"
// também agregam mais de um status real (ver STATUS_FILTERS), espelhando
// como wacrm.recalculate_campaign_metrics
// (migration 112) calcula os KPIs, para que a contagem do drilldown
// bata com o número exibido no card.
const STATUS_FILTERS = QUEUE_DETAIL_STATUS_FILTERS;
const REPLIED_KEY = REPLIED_QUEUE_DETAIL_KEY;
const PENDING_CONFIRMATION_KEY = PENDING_CONFIRMATION_QUEUE_DETAIL_KEY;

// Itens por página escolhidos no modal (20 por padrão, teto de 200).
// Exportação xlsx: lê em páginas de 1000 até este teto.
const EXPORT_PAGE_SIZE = 1000;
// A exportação SÍNCRONA (XLSX) é só para volumes pequenos: acima disso a requisição não pode ler a fila inteira.
// Exportação grande é um JOB em segundo plano (POST /api/disparador/exports, migration 203).
const EXPORT_MAX_ROWS = EXPORT_SYNC_MAX_ROWS + 1;

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 200;

/**
 * Conversa de cada contato para o link do detalhamento: a que veio desta
 * campanha (origin_campaign_id) ou, sem ela, a mais recente do contato.
 */
async function attachConversations(
  rows: QueueDetailRow[],
  accountId: string,
  campaignId: string,
): Promise<QueueDetailRow[]> {
  const contactIds = [...new Set(rows.map((r) => r.contact_id).filter(Boolean))] as string[];
  if (contactIds.length === 0) return rows;
  const { data } = await supabaseAdmin()
    .from("conversations")
    .select("id, contact_id, origin_campaign_id, last_message_at")
    .eq("account_id", accountId)
    .in("contact_id", contactIds)
    .order("last_message_at", { ascending: false, nullsFirst: false });
  const rowsByRecency = (data ?? []) as Array<{ id: string; contact_id: string; origin_campaign_id: string | null }>;
  const byContact = new Map<string, string>();
  // Mais recente de cada contato; a conversa desta campanha tem prioridade.
  for (const c of rowsByRecency) if (!byContact.has(c.contact_id)) byContact.set(c.contact_id, c.id);
  for (const c of rowsByRecency) if (c.origin_campaign_id === campaignId) byContact.set(c.contact_id, c.id);
  return rows.map((r) => ({ ...r, conversation_id: r.contact_id ? byContact.get(r.contact_id) ?? null : null }));
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Nome + telefone de todos os destinatários: mesmo papel da página de campanhas.
    const ctx = await requireDisparadorAccess();
    const { id: campaignId } = await params;

    const { searchParams } = new URL(request.url);
    const statusKey = searchParams.get("status") ?? "";
    const search = (searchParams.get("search") ?? "").trim();
    const exportFormat = searchParams.get("export");
    const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10) || 1);
    const PAGE_SIZE = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, parseInt(searchParams.get("pageSize") ?? "", 10) || DEFAULT_PAGE_SIZE)
    );

    const isTotal = statusKey === "total";
    const isPendingConfirmation = statusKey === PENDING_CONFIRMATION_KEY;
    const statuses = isTotal ? null : STATUS_FILTERS[statusKey];
    if (!isTotal && !statuses) {
      return NextResponse.json(
        { error: `status inválido: ${statusKey}` },
        { status: 400 }
      );
    }

    // A campanha precisa pertencer à conta do chamador.
    const { data: campaign } = await supabaseAdmin()
      .from("campaigns")
      .select("id, account_id, import_draft_id")
      .eq("id", campaignId)
      .maybeSingle();

    if (!campaign || campaign.account_id !== ctx.accountId) {
      return NextResponse.json({ error: "Campanha não encontrada" }, { status: 404 });
    }

    // Busca por nome/telefone é resolvida à parte (contact_id IN (...))
    // em vez de um filtro `.or()` entre tabelas — evita depender da
    // sintaxe de filtro embutido do PostgREST/supabase-js pra isso,
    // que não tem precedente no restante do código.
    let contactIdFilter: string[] | null = null;
    if (search) {
      // Remove vírgula/parênteses antes de embutir no filtro `.or()` —
      // esses caracteres têm significado especial na gramática de
      // filtro do PostgREST e um nome/telefone de busca contendo um
      // deles quebraria o parse (400), não um risco de injeção de SQL
      // (a gramática do PostgREST não executa SQL arbitrário).
      // % e _ são escapados para não ampliar a busca com curingas.
      const safeSearch = search.replace(/[,()"\\*]/g, " ").trim().replace(/[%_]/g, "\\$&");
      if (!safeSearch) {
        return exportFormat === "xlsx"
          ? buildXlsxResponse([], statusKey)
          : NextResponse.json({ rows: [], total: 0, page, pageSize: PAGE_SIZE });
      }
      // Aspas protegem a gramática do .or(); a barra chega ao ILIKE para
      // buscar % e _ literalmente, sem transformar o termo em curinga.
      const pattern = JSON.stringify(`%${safeSearch}%`);
      const { data: matchedContacts, error: contactSearchError } = await supabaseAdmin()
        .from("contacts")
        .select("id")
        .eq("account_id", ctx.accountId)
        .or(`name.ilike.${pattern},phone.ilike.${pattern}`);

      if (contactSearchError) {
        throw new Error(`Falha ao buscar contatos: ${contactSearchError.message}`);
      }

      const matchedIds = new Set((matchedContacts ?? []).map((c) => c.id));

      // Para imports legados, contacts.name pode estar vazio e o nome ter
      // ficado apenas em VAR1. Inclui esses contatos na busca pelo nome.
      const loadLegacyNameMatches = async (
        column: "campaign_id" | "draft_id",
        value: string,
      ) => {
        const { data, error } = await supabaseAdmin()
          .from("contact_import_variables")
          .select("contact_id")
          .eq(column, value)
          .eq("var_index", 0)
          .ilike("value", `%${safeSearch}%`);
        if (error) throw new Error(`Falha ao buscar nomes do CSV: ${error.message}`);
        for (const item of data ?? []) if (item.contact_id) matchedIds.add(item.contact_id);
      };

      await loadLegacyNameMatches("campaign_id", campaignId);
      if (campaign.import_draft_id) {
        await loadLegacyNameMatches("draft_id", campaign.import_draft_id);
      }

      contactIdFilter = [...matchedIds];
      if (contactIdFilter.length === 0) {
        return exportFormat === "xlsx"
          ? buildXlsxResponse([], statusKey)
          : NextResponse.json({ rows: [], total: 0, page, pageSize: PAGE_SIZE });
      }
    }

    if (exportFormat === "xlsx") {
      const replied = statusKey === REPLIED_KEY;
      // Em páginas (.range): o PostgREST corta em max_rows e uma campanha grande
      // exportava só o começo, ou estourava a memória lendo tudo de uma vez.
      const exported: unknown[] = [];
      for (let offset = 0; offset < EXPORT_MAX_ROWS; offset += EXPORT_PAGE_SIZE) {
        let query = supabaseAdmin()
          .from("disp_message_queue")
          .select(replied ? SELECT_COLUMNS_REPLIED : SELECT_COLUMNS)
          .eq("campaign_id", campaignId);
        if (statuses) query = query.in("status", statuses);
        if (isPendingConfirmation) query = query.or(PENDING_CONFIRMATION_OR_FILTER);
        query = replied
          ? query.not("replied_at", "is", null).order("replied_at", { ascending: false })
          : query.order("sent_at", { ascending: false, nullsFirst: false }).order("scheduled_at", { ascending: false });
        // Desempate por id: sem ele a paginação repete/pula linhas empatadas.
        query = query.order("id", { ascending: true });

        if (contactIdFilter) query = query.in("contact_id", contactIdFilter);

        const { data, error } = await query.range(offset, offset + EXPORT_PAGE_SIZE - 1);
        if (error) throw new Error(`Falha ao buscar itens: ${error.message}`);
        exported.push(...(data ?? []));
        if ((data?.length ?? 0) < EXPORT_PAGE_SIZE) break;
      }
      if (exported.length > EXPORT_SYNC_MAX_ROWS) {
        return NextResponse.json(
          {
            error: `Exportação grande demais para baixar na hora (mais de ${EXPORT_SYNC_MAX_ROWS} linhas). Use a exportação em segundo plano.`,
            code: "export_too_large",
            async_endpoint: "/api/disparador/exports",
            max_sync_rows: EXPORT_SYNC_MAX_ROWS,
          },
          { status: 409 },
        );
      }

      const rows = await attachLegacyCsvNames(
        exported.map((r) => toDetailRow(r as unknown as QueueRow)),
        campaignId,
        campaign.import_draft_id ?? null,
      );
      await logAuditEvent({
        accountId: ctx.accountId,
        eventType: "action",
        resourceType: "campaign",
        resourceId: campaignId,
        action: "campaign.exported",
        summary: `Exportou ${rows.length} contato(s) da métrica "${statusKey}"${search ? ` (busca: ${search})` : ""}`,
        metadata: { status: statusKey, search: search || null, rows: rows.length },
      });
      return buildXlsxResponse(rows, statusKey);
    }

    const from = (page - 1) * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    const replied = statusKey === REPLIED_KEY;
    // Filtro só por status: o total vem de UMA agregação por status (queue-total.ts), não de `count: exact` junto
    // da página. Busca por contato, "respondidos" e "aguardando confirmação" têm filtros próprios: seguem contando exato.
    const totalFromCounts = !contactIdFilter && !replied && !isPendingConfirmation;
    let query = supabaseAdmin()
      .from("disp_message_queue")
      .select(replied ? SELECT_COLUMNS_REPLIED : SELECT_COLUMNS, totalFromCounts ? undefined : { count: "exact" })
      .eq("campaign_id", campaignId);
    if (statuses) query = query.in("status", statuses);
    if (isPendingConfirmation) query = query.or(PENDING_CONFIRMATION_OR_FILTER);
    query = (
      replied
        ? query.not("replied_at", "is", null).order("replied_at", { ascending: false })
        : query.order("sent_at", { ascending: false, nullsFirst: false }).order("scheduled_at", { ascending: false })
    ).range(from, to);

    if (contactIdFilter) query = query.in("contact_id", contactIdFilter);

    const [{ data, error, count }, statusTotal] = await Promise.all([
      query,
      totalFromCounts ? totalFromStatusCounts(supabaseAdmin(), campaignId, statuses) : Promise.resolve(null),
    ]);
    if (error?.code === "42703" && replied) {
      return NextResponse.json(
        { error: "O detalhamento de respostas precisa da migration 126 aplicada." },
        { status: 400 },
      );
    }
    if (error) throw new Error(`Falha ao buscar itens: ${error.message}`);

    const namedRows = await attachLegacyCsvNames(
      (data ?? []).map((r) => toDetailRow(r as unknown as QueueRow)),
      campaignId,
      campaign.import_draft_id ?? null,
    );
    const rows = await attachConversations(
      namedRows,
      ctx.accountId,
      campaignId,
    );
    let total = count ?? statusTotal ?? 0;
    if (totalFromCounts && statusTotal === null) {
      // Sem a agregação (RPC e contagens por status falharam): último recurso, o count exato de antes.
      let countQuery = supabaseAdmin().from("disp_message_queue").select("id", { count: "exact", head: true }).eq("campaign_id", campaignId);
      if (statuses) countQuery = countQuery.in("status", statuses);
      total = (await countQuery).count ?? 0;
    }
    return NextResponse.json({ rows, total, page, pageSize: PAGE_SIZE });
  } catch (err) {
    return toErrorResponse(err);
  }
}

const STATUS_FILE_LABELS: Record<string, string> = {
  total: "total-contatos",
  agendado: "a-enviar",
  enviado: "enviados",
  entregue: "entregues",
  lido: "lidos",
  erro: "erros",
  respondido: "respostas",
  bloqueado: "blacklist",
  aguardando_confirmacao: "aguardando-confirmacao",
};

function buildXlsxResponse(rows: QueueDetailRow[], statusKey: string): NextResponse {
  const hasErrorColumn = statusKey === "erro";
  const isPendingConfirmation = statusKey === PENDING_CONFIRMATION_KEY;
  const sheetRows = rows.map((r) => {
    const base: Record<string, unknown> = {
      Contato: r.contact_name ?? "-",
      Telefone: r.phone ?? "-",
      Status: r.status,
      "Mensagem Final": r.mensagem_final ?? "",
    };
    if (hasErrorColumn) base["Tipo de Erro"] = r.tipo_erro ?? "Outro";
    if (isPendingConfirmation) base["Motivo"] = r.erro ?? "Aguardando confirmação final";
    base["Data/Hora"] = r.data_hora
      ? new Date(r.data_hora).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })
      : "-";
    return base;
  });

  const ws = XLSX.utils.json_to_sheet(sheetRows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Detalhamento");

  const buffer = XLSX.write(wb, { bookType: "xlsx", type: "buffer" }) as Buffer;
  const fileName = `campanha_${STATUS_FILE_LABELS[statusKey] ?? statusKey}_${new Date().toISOString().slice(0, 10)}.xlsx`;

  // NextResponse's BodyInit typing doesn't accept Node's Buffer directly
  // (ArrayBufferLike generic mismatch) — a plain Uint8Array copy satisfies it.
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${fileName}"`,
    },
  });
}
