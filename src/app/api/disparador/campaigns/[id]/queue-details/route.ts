import { NextResponse } from "next/server";
import { logAuditEvent } from "@/lib/audit/log-event";
import * as XLSX from "xlsx";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { classificarTipoErro } from "@/lib/disparador/normalize-meta-error";

// GET /api/disparador/campaigns/[id]/queue-details?status=enviado&search=&page=1&pageSize=50
// GET /api/disparador/campaigns/[id]/queue-details?status=erro&export=xlsx
//
// Detalhamento por contato de uma métrica do modal de métricas da
// campanha (campanhas/page.tsx). `status` é a chave da métrica clicada,
// não necessariamente um valor literal de disp_message_queue.status —
// "enviado" e "entregue" agregam mais de um status real (ver
// STATUS_FILTERS), espelhando como wacrm.recalculate_campaign_metrics
// (migration 112) calcula os KPIs, para que a contagem do drilldown
// bata com o número exibido no card.
const STATUS_FILTERS: Record<string, string[]> = {
  agendado: ["agendado"],
  enviado: ["enviado", "entregue", "lido"],
  entregue: ["entregue", "lido"],
  lido: ["lido"],
  erro: ["erro"],
  bloqueado: ["bloqueado"],
};

// Itens por página escolhidos no modal (20 por padrão, teto de 200).
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 200;

interface QueueDetailRow {
  id: string;
  contact_name: string | null;
  phone: string | null;
  status: string;
  mensagem_final: string | null;
  erro: string | null;
  tipo_erro: string | null;
  // sent_at quando disponível (envio real já aconteceu); cai para
  // scheduled_at pra itens ainda não enviados — disp_message_queue.
  // updated_at nunca é mantido por trigger nem setado manualmente nos
  // caminhos de escrita (ver processQueue.ts), então fica parado no
  // valor de inserção da linha e não serve pra "quando isso aconteceu".
  data_hora: string | null;
}

type QueueRow = {
  id: string;
  mensagem_final: string | null;
  erro: string | null;
  status: string;
  scheduled_at: string | null;
  sent_at: string | null;
  contacts: { name: string | null; phone: string | null } | null;
};

function toDetailRow(row: QueueRow): QueueDetailRow {
  return {
    id: row.id,
    contact_name: row.contacts?.name ?? null,
    phone: row.contacts?.phone ?? null,
    status: row.status,
    mensagem_final: row.mensagem_final,
    erro: row.erro,
    tipo_erro: row.status === "erro" ? classificarTipoErro(row.erro) : null,
    data_hora: row.sent_at ?? row.scheduled_at,
  };
}

const SELECT_COLUMNS =
  "id, mensagem_final, erro, status, scheduled_at, sent_at, contacts!contact_id(name, phone)";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await getCurrentAccount();
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

    const statuses = STATUS_FILTERS[statusKey];
    if (!statuses) {
      return NextResponse.json(
        { error: `status inválido: ${statusKey}` },
        { status: 400 }
      );
    }

    // Campanhas não têm checagem de role aqui — qualquer membro da
    // conta que já pode abrir o modal de métricas pode ver o
    // detalhamento (mesmo nível de acesso de hoje). Só precisa
    // pertencer à mesma conta do chamador.
    const { data: campaign } = await supabaseAdmin()
      .from("campaigns")
      .select("id, account_id")
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
      const safeSearch = search.replace(/[,()]/g, " ").trim();
      const { data: matchedContacts, error: contactSearchError } = await supabaseAdmin()
        .from("contacts")
        .select("id")
        .eq("account_id", ctx.accountId)
        .or(`name.ilike.%${safeSearch}%,phone.ilike.%${safeSearch}%`);

      if (contactSearchError) {
        throw new Error(`Falha ao buscar contatos: ${contactSearchError.message}`);
      }

      contactIdFilter = (matchedContacts ?? []).map((c) => c.id);
      if (contactIdFilter.length === 0) {
        return exportFormat === "xlsx"
          ? buildXlsxResponse([], statusKey)
          : NextResponse.json({ rows: [], total: 0, page, pageSize: PAGE_SIZE });
      }
    }

    if (exportFormat === "xlsx") {
      let query = supabaseAdmin()
        .from("disp_message_queue")
        .select(SELECT_COLUMNS)
        .eq("campaign_id", campaignId)
        .in("status", statuses)
        .order("sent_at", { ascending: false, nullsFirst: false })
        .order("scheduled_at", { ascending: false });

      if (contactIdFilter) query = query.in("contact_id", contactIdFilter);

      const { data, error } = await query;
      if (error) throw new Error(`Falha ao buscar itens: ${error.message}`);

      const rows = (data ?? []).map((r) => toDetailRow(r as unknown as QueueRow));
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

    let query = supabaseAdmin()
      .from("disp_message_queue")
      .select(SELECT_COLUMNS, { count: "exact" })
      .eq("campaign_id", campaignId)
      .in("status", statuses)
      .order("sent_at", { ascending: false, nullsFirst: false })
      .order("scheduled_at", { ascending: false })
      .range(from, to);

    if (contactIdFilter) query = query.in("contact_id", contactIdFilter);

    const { data, error, count } = await query;
    if (error) throw new Error(`Falha ao buscar itens: ${error.message}`);

    const rows = (data ?? []).map((r) => toDetailRow(r as unknown as QueueRow));
    return NextResponse.json({ rows, total: count ?? 0, page, pageSize: PAGE_SIZE });
  } catch (err) {
    return toErrorResponse(err);
  }
}

const STATUS_FILE_LABELS: Record<string, string> = {
  agendado: "a-enviar",
  enviado: "enviados",
  entregue: "entregues",
  lido: "lidos",
  erro: "erros",
  bloqueado: "blacklist",
};

function buildXlsxResponse(rows: QueueDetailRow[], statusKey: string): NextResponse {
  const hasErrorColumn = statusKey === "erro";
  const sheetRows = rows.map((r) => {
    const base: Record<string, unknown> = {
      Contato: r.contact_name ?? "-",
      Telefone: r.phone ?? "-",
      Status: r.status,
      "Mensagem Final": r.mensagem_final ?? "",
    };
    if (hasErrorColumn) base["Tipo de Erro"] = r.tipo_erro ?? "Outro";
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
