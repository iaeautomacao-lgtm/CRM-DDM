"use client";

// /disparador/campanhas/[id] — visão "por contato" de uma campanha:
// lista paginada de wacrm.disp_message_queue (joined com contacts pra
// telefone/nome), com filtro por status. Complementa o modal "Ver
// métricas" (agregado) já existente em campanhas/page.tsx — este aqui é
// o detalhe linha-a-linha que não existia antes (ver investigação do
// Plano de Alterações, item "Onde fica o 'por contato'?").
//
// Segurança: disp_message_queue/campaigns não têm RLS (ver
// disparador_schema.sql — "Desativar RLS nas tabelas do disparador para
// compatibilidade"), então a checagem de posse é feita aqui, no client,
// via getDisparadorScope (mesmo padrão de /disparador/monitor): o
// campaign_id da URL só é aceito se estiver entre os campaignIds da
// conta do usuário logado.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { use } from "react";
import { createClient } from "@/lib/supabase/client";
import { getDisparadorScope } from "@/lib/disparador/scope";
import { normalizarErroMeta } from "@/lib/disparador/normalize-meta-error";
import {
  ArrowLeft,
  ListChecks,
  Loader2,
  CheckCircle2,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Clock,
  Send,
  Eye,
  X,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { KpiStrip } from "@/components/ddm/kpi-strip";
import { PageBody, PageToolbar } from "@/components/ddm/page-toolbar";
import { Segmented } from "@/components/ddm/segmented";
import { StatusChip, type StatusTone } from "@/components/ddm/status-chip";
import { CellMain, DenseTable, TableCard, Td, Th, Tr } from "@/components/ddm/table-card";
import { EmptyState, Skeleton } from "@/components/ddm/states";

interface QueueRow {
  id: string;
  status: string;
  erro: string | null;
  scheduled_at: string;
  sent_at: string | null;
  entrega_pendente_131026?: boolean | null;
  contacts?: { name: string | null; phone: string | null } | null;
}

/** Linha de campaign_metrics_live (totais acumulados da campanha). */
interface CampaignMetrics {
  total_contatos: number;
  total_enviados: number;
  total_entregues: number;
  total_lidos: number;
  total_respostas: number;
  total_blacklist: number;
  total_erros: number;
}

const STATUS_TONE: Record<string, StatusTone> = {
  agendado: "mute",
  enviando: "brand",
  enviado: "info",
  entregue: "ok",
  lido: "ok",
  erro: "bad",
  pausado: "warn",
};

const STATUS_LABEL: Record<string, string> = {
  agendado: "Agendado",
  enviando: "Enviando",
  enviado: "Enviado",
  entregue: "Entregue",
  lido: "Lido",
  erro: "Erro",
  pausado: "Pausado",
};

const STATUS_ICON: Record<string, typeof Clock> = {
  agendado: Clock,
  enviando: Loader2,
  enviado: Send,
  entregue: CheckCircle2,
  lido: Eye,
  erro: AlertCircle,
  pausado: Clock,
};

const PAGE_SIZE = 30;

export default function CampanhaContatosPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: campaignId } = use(params);

  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [campaignName, setCampaignName] = useState<string>("");
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  // Links do Monitor/Erros chegam com ?status=erro&codigo=131049 (lista filtrada por código de erro).
  const searchParams = useSearchParams();
  const initialStatus = searchParams.get("status");
  const initialCodigo = Number(searchParams.get("codigo"));
  const [statusFilter, setStatusFilter] = useState(
    initialStatus && initialStatus in STATUS_LABEL ? initialStatus : "__all__",
  );
  const [codigoFilter, setCodigoFilter] = useState<number | null>(
    Number.isInteger(initialCodigo) && initialCodigo > 0 ? initialCodigo : null,
  );
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  // Totais da campanha para a barra e os KPIs (mesma fonte dos cartões da lista).
  const [metrics, setMetrics] = useState<CampaignMetrics | null>(null);

  // Confirma que a campanha pertence à conta do usuário logado — ver
  // comentário de segurança no topo do arquivo.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const { campaignIds } = await getDisparadorScope(supabase);
      if (cancelled) return;
      if (!campaignIds.includes(campaignId)) {
        setAllowed(false);
        return;
      }
      setAllowed(true);
      const { data } = await supabase
        .from("campaigns")
        .select("nome")
        .eq("id", campaignId)
        .maybeSingle();
      if (!cancelled) setCampaignName(data?.nome ?? "Campanha");
      const { data: m } = await supabase
        .from("campaign_metrics_live")
        .select("total_contatos, total_enviados, total_entregues, total_lidos, total_respostas, total_blacklist, total_erros")
        .eq("campaign_id", campaignId)
        .limit(1);
      if (!cancelled) setMetrics(((m ?? [])[0] as CampaignMetrics | undefined) ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [campaignId]);

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const supabase = createClient();
      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      let query = supabase
        .from("disp_message_queue")
        .select("id, status, erro, scheduled_at, sent_at, entrega_pendente_131026, contacts:contact_id ( name, phone )", {
          count: "exact",
        })
        .eq("campaign_id", campaignId)
        .order("scheduled_at", { ascending: false })
        .range(from, to);

      if (statusFilter !== "__all__") {
        query = query.eq("status", statusFilter);
      }
      // erro_codigo (migration 187): filtra os itens pelo código de erro da Meta.
      if (codigoFilter !== null) {
        query = query.eq("erro_codigo", codigoFilter);
      }

      const { data, count, error } = await query;
      if (cancelled) return;
      if (!error && data) {
        setRows(data as unknown as QueueRow[]);
        setHasMore(data.length === PAGE_SIZE);
        setTotalCount(count ?? null);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [allowed, campaignId, statusFilter, codigoFilter, page]);

  // Troca de filtro de status reseta a paginação direto no handler (não
  // num useEffect derivado) — senão uma página > 0 de um filtro anterior
  // pode ficar vazia.
  function handleStatusFilterChange(value: string) {
    setStatusFilter(value || "__all__");
    setPage(0);
  }

  if (allowed === false) {
    return (
      <PageBody>
        <EmptyState
          icon={AlertCircle}
          title="Campanha não encontrada ou fora da sua conta"
          hint="Volte para a lista de campanhas."
        />
        <Link href="/disparador/campanhas" className={cn(buttonVariants({ variant: "outline" }), "self-center")}>
          Voltar para Campanhas
        </Link>
      </PageBody>
    );
  }

  const m = metrics;
  const total = m?.total_contatos ?? 0;
  // Barra segmentada: os totais de campaign_metrics_live são acumulados
  // (lido ⊂ entregue ⊂ enviado), então cada faixa é a diferença entre eles.
  const segments = m && total > 0
    ? [
        { key: "lido", label: "Lidos", value: m.total_lidos, cls: "bg-primary" },
        { key: "entregue", label: "Entregues (sem leitura)", value: Math.max(0, m.total_entregues - m.total_lidos), cls: "bg-success" },
        { key: "enviado", label: "Enviados (sem confirmação)", value: Math.max(0, m.total_enviados - m.total_entregues), cls: "bg-[#5B8DEF] [html[data-mode=light]_&]:bg-[#3B6FD8]" },
        { key: "erro", label: "Erros", value: m.total_erros, cls: "bg-danger" },
        { key: "restante", label: "Ainda não enviados", value: Math.max(0, total - m.total_enviados - m.total_erros - m.total_blacklist), cls: "bg-surface-3" },
      ]
    : [];

  return (
    <PageBody>
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href="/disparador/campanhas"
          aria-label="Voltar para Campanhas"
          title="Voltar para Campanhas"
          className="flex size-8 shrink-0 items-center justify-center rounded-[6px] border border-border bg-card text-foreground-2 transition-colors hover:bg-surface-hover hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />
        </Link>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="m-0 truncate text-[15px] font-semibold text-foreground">{campaignName || "Carregando…"}</h2>
          <p className="m-0 text-[12.5px] text-muted-foreground">
            Envios por contato{totalCount != null ? ` — ${totalCount.toLocaleString("pt-BR")} neste filtro` : ""}
          </p>
        </div>
      </div>

      {/* Resumo da campanha (campaign_metrics_live, mesma fonte dos cartões da lista). */}
      {m && (
        <section aria-label="Resumo da campanha" className="flex flex-col gap-3 rounded-[10px] border border-border bg-card px-[18px] py-4">
          {segments.length > 0 && (
            <>
              <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-surface-3" role="img" aria-label="Distribuição dos envios">
                {segments.map((s) =>
                  s.value > 0 ? (
                    <span
                      key={s.key}
                      title={`${s.label}: ${s.value.toLocaleString("pt-BR")}`}
                      className={cn("origin-left animate-ddm-bar transition-[width] duration-500", s.cls)}
                      style={{ width: `${(s.value / total) * 100}%` }}
                    />
                  ) : null,
                )}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-foreground-2">
                {segments.map((s) => (
                  <span key={s.key} className="inline-flex items-center gap-1.5 tabular-nums">
                    <span aria-hidden="true" className={cn("size-2 rounded-[2px]", s.cls)} />
                    {s.label} · {s.value.toLocaleString("pt-BR")}
                  </span>
                ))}
              </div>
            </>
          )}
          <KpiStrip
            ariaLabel="Totais da campanha"
            minWidth={140}
            items={[
              { label: "Contatos", value: total.toLocaleString("pt-BR") },
              { label: "Enviados", value: m.total_enviados.toLocaleString("pt-BR") },
              { label: "Entregues", value: m.total_entregues.toLocaleString("pt-BR") },
              { label: "Lidos", value: m.total_lidos.toLocaleString("pt-BR") },
              { label: "Respostas", value: m.total_respostas.toLocaleString("pt-BR") },
              { label: "Erros", value: m.total_erros.toLocaleString("pt-BR") },
            ]}
          />
        </section>
      )}

      <PageToolbar>
        <Segmented
          ariaLabel="Filtrar envios por status"
          value={statusFilter}
          onChange={handleStatusFilterChange}
          options={[
            { value: "__all__", label: "Todos" },
            ...Object.keys(STATUS_LABEL).map((s) => ({ value: s, label: STATUS_LABEL[s] })),
          ]}
        />
        {codigoFilter !== null && (
          <span className="inline-flex h-7 items-center gap-2 rounded-full bg-surface-3 pl-3 pr-1 text-[12.5px] text-foreground">
            Código de erro <strong className="font-mono">{codigoFilter}</strong>
            <button
              type="button"
              onClick={() => {
                setCodigoFilter(null);
                setPage(0);
              }}
              className="flex size-5 items-center justify-center rounded-full text-muted-foreground hover:bg-surface-hover hover:text-foreground"
              aria-label="Limpar filtro de código"
            >
              <X className="size-3" aria-hidden="true" />
            </button>
          </span>
        )}
      </PageToolbar>

      <TableCard>
        {loading ? (
          <div className="flex flex-col gap-2 p-4" aria-busy="true" aria-label="Carregando envios">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            className="m-4"
            icon={ListChecks}
            title="Nenhum envio encontrado"
            hint={statusFilter === "__all__" ? "Esta campanha ainda não tem itens na fila." : "Nenhum item com este status."}
          />
        ) : (
          <DenseTable minWidth={720}>
            <thead>
              <tr>
                <Th>Contato</Th>
                <Th>Status</Th>
                <Th>Erro</Th>
                <Th align="right">Data de envio</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isPending131026 = r.entrega_pendente_131026 === true;
                const Icon = isPending131026 ? Clock : (STATUS_ICON[r.status] ?? Clock);
                const tone: StatusTone = isPending131026 ? "warn" : (STATUS_TONE[r.status] ?? "mute");
                const label = isPending131026 ? "Aguardando confirmação" : (STATUS_LABEL[r.status] || r.status);
                const title = isPending131026
                  ? "A Meta informou 131026; pode ser aparelho offline. Confirmamos em até 24h."
                  : undefined;
                return (
                  <Tr key={r.id}>
                    <Td>
                      <CellMain title={r.contacts?.name || "—"} sub={r.contacts?.phone || "—"} />
                    </Td>
                    <Td>
                      <StatusChip tone={tone} dot={false} title={title}>
                        <Icon
                          aria-hidden="true"
                          className={cn("size-3", !isPending131026 && r.status === "enviando" && "animate-spin")}
                        />
                        {label}
                      </StatusChip>
                    </Td>
                    <Td className="max-w-[320px] truncate text-xs text-danger" title={r.erro ? normalizarErroMeta(r.erro) : undefined}>
                      {r.erro ? normalizarErroMeta(r.erro) : <span className="text-muted-foreground">—</span>}
                    </Td>
                    <Td align="right" className="whitespace-nowrap text-xs text-muted-foreground">
                      {r.sent_at ? new Date(r.sent_at).toLocaleString("pt-BR") : new Date(r.scheduled_at).toLocaleString("pt-BR")}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </DenseTable>
        )}
        {(page > 0 || hasMore) && (
          <nav aria-label="Paginação" className="flex items-center justify-between gap-3 border-t border-border px-[18px] py-3 text-xs text-muted-foreground">
            <Button variant="outline" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
              <ChevronLeft className="size-3.5" aria-hidden="true" /> Anterior
            </Button>
            <span className="tabular-nums">
              Página {page + 1}
              {totalCount != null ? ` de ${Math.max(1, Math.ceil(totalCount / PAGE_SIZE)).toLocaleString("pt-BR")}` : ""}
            </span>
            <Button variant="outline" disabled={!hasMore} onClick={() => setPage((p) => p + 1)}>
              Próxima <ChevronRight className="size-3.5" aria-hidden="true" />
            </Button>
          </nav>
        )}
      </TableCard>
    </PageBody>
  );
}
