"use client";

// ============================================================
// /relatorios/envio-em-lote — Disparador report: pick a campaign,
// see aggregated counts, drill into its per-contact queue items.
// Backed by wacrm.get_campaigns_for_report / get_campaign_report_detail
// / get_campaign_queue_items (supabase/migrations/054_broadcast_report_rpc.sql).
//
// disp_message_queue.status is only ever 'agendado' | 'enviando' |
// 'enviado' | 'erro' | 'cancelado' in real data (grepped the worker/
// cron code) — 'entregue'/'lido' from the original spec never occur,
// so the Status filter offers the real 5 values instead. The detail
// card still surfaces total_entregues/total_lidos as small secondary
// counts (real columns, currently always 0 — see the migration's
// header) rather than hiding them outright.
//
// No combobox/search-select primitive exists in this codebase (no
// cmdk dependency) — the "Campanha" filter is a plain dropdown
// (get_campaigns_for_report caps at 200 rows), not a full type-ahead
// combobox.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  Info,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Skeleton } from "@/components/dashboard/skeleton";
import { buildPageList } from "@/lib/relatorios/pagination";
import { exportWithHistory } from "@/lib/relatorios/export-with-history";
import { MessageModal } from "@/components/relatorios/MessageModal";

const ALL = "all";
const PAGE_SIZE = 60;

const STATUS_OPTIONS = [
  { value: ALL, label: "Todos" },
  { value: "agendado", label: "Agendado" },
  { value: "enviando", label: "Enviando" },
  { value: "enviado", label: "Enviado" },
  { value: "erro", label: "Erro" },
  { value: "cancelado", label: "Cancelado" },
] as const;

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  agendado: { label: "Agendado", className: "bg-[#FEF3C7] text-[#92400E]" },
  enviando: { label: "Enviando", className: "bg-[#F3E8FF] text-[#7C3AED]" },
  enviado: { label: "Enviado", className: "bg-[#DBEAFE] text-[#1D4ED8]" },
  erro: { label: "Erro", className: "bg-[#FEE2E2] text-[#B91C1C]" },
  cancelado: { label: "Cancelado", className: "bg-[#F3F4F6] text-[#374151]" },
};

function n(value: string | number | null | undefined): number {
  return Number(value ?? 0) || 0;
}

interface RawCampaign {
  id: string;
  nome: string;
  created_at: string;
  status: string;
}

interface CampaignOption {
  id: string;
  nome: string;
  createdAt: string;
  status: string;
}

interface RawDetail {
  campaign_id: string;
  nome: string;
  created_at: string;
  agendamento: string | null;
  created_by_name: string | null;
  created_by_email: string | null;
  session_name: string | null;
  total_contatos: string | number;
  total_mensagens: string | number;
  total_agendados: string | number;
  total_enviando: string | number;
  total_enviados: string | number;
  total_erros: string | number;
  total_cancelados: string | number;
  total_entregues: string | number;
  total_lidos: string | number;
}

interface CampaignDetail {
  nome: string;
  createdAt: string;
  agendamento: string | null;
  createdByName: string | null;
  createdByEmail: string | null;
  sessionName: string | null;
  totalContatos: number;
  totalMensagens: number;
  totalAgendados: number;
  totalEnviando: number;
  totalEnviados: number;
  totalErros: number;
  totalCancelados: number;
  totalEntregues: number;
  totalLidos: number;
}

function normalizeDetail(r: RawDetail): CampaignDetail {
  return {
    nome: r.nome,
    createdAt: r.created_at,
    agendamento: r.agendamento,
    createdByName: r.created_by_name,
    createdByEmail: r.created_by_email,
    sessionName: r.session_name,
    totalContatos: n(r.total_contatos),
    totalMensagens: n(r.total_mensagens),
    totalAgendados: n(r.total_agendados),
    totalEnviando: n(r.total_enviando),
    totalEnviados: n(r.total_enviados),
    totalErros: n(r.total_erros),
    totalCancelados: n(r.total_cancelados),
    totalEntregues: n(r.total_entregues),
    totalLidos: n(r.total_lidos),
  };
}

interface RawItem {
  item_id: string;
  sent_at: string | null;
  created_at: string;
  contact_name: string | null;
  contact_phone: string | null;
  status: string;
  mensagem_final: string | null;
  erro: string | null;
  total_count: string | number;
}

interface QueueItem {
  id: string;
  sentAt: string | null;
  createdAt: string;
  contactName: string | null;
  contactPhone: string | null;
  status: string;
  mensagemFinal: string | null;
  erro: string | null;
}

function normalizeItems(rows: RawItem[]): QueueItem[] {
  return rows.map((r) => ({
    id: r.item_id,
    sentAt: r.sent_at,
    createdAt: r.created_at,
    contactName: r.contact_name,
    contactPhone: r.contact_phone,
    status: r.status,
    mensagemFinal: r.mensagem_final,
    erro: r.erro,
  }));
}

function DetailField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium text-foreground">{value}</dd>
    </div>
  );
}

interface ItemFilters {
  search: string;
  status: string;
}

function defaultItemFilters(): ItemFilters {
  return { search: "", status: ALL };
}

export default function EnvioEmLotePage() {
  const { accountId } = useAuth();

  const [filtersOpen, setFiltersOpen] = useState(true);
  const [campaigns, setCampaigns] = useState<CampaignOption[]>([]);
  const [campaignId, setCampaignId] = useState<string | null>(null);

  const [detail, setDetail] = useState<CampaignDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [draft, setDraft] = useState<ItemFilters>(defaultItemFilters);
  const [applied, setApplied] = useState<ItemFilters>(defaultItemFilters);
  const [page, setPage] = useState(1);

  const [items, setItems] = useState<QueueItem[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  const [viewingMessage, setViewingMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    const db = createClient();
    db.rpc("get_campaigns_for_report", { p_account_id: accountId }).then(({ data, error }) => {
      if (cancelled) return;
      if (error) {
        console.error("[envio-em-lote] failed to load campaigns:", error);
        return;
      }
      const rows = (data ?? []) as RawCampaign[];
      setCampaigns(
        rows.map((r) => ({ id: r.id, nome: r.nome, createdAt: r.created_at, status: r.status })),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const loadDetail = useCallback(async () => {
    if (!accountId || !campaignId) return;
    setDetailLoading(true);
    try {
      const db = createClient();
      const { data, error } = await db.rpc("get_campaign_report_detail", {
        p_campaign_id: campaignId,
        p_account_id: accountId,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      setDetail(row ? normalizeDetail(row as RawDetail) : null);
    } catch (err) {
      console.error("[envio-em-lote] failed to load campaign detail:", err);
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, [accountId, campaignId]);

  const buildItemsParams = useCallback(
    (f: ItemFilters, limit: number, offset: number) => ({
      p_campaign_id: campaignId,
      p_account_id: accountId,
      p_status: f.status !== ALL ? f.status : null,
      p_search: f.search.trim() ? f.search.trim() : null,
      p_limit: limit,
      p_offset: offset,
    }),
    [accountId, campaignId],
  );

  const loadItems = useCallback(async () => {
    if (!accountId || !campaignId) return;
    setItemsLoading(true);
    try {
      const db = createClient();
      const { data, error } = await db.rpc(
        "get_campaign_queue_items",
        buildItemsParams(applied, PAGE_SIZE, (page - 1) * PAGE_SIZE),
      );
      if (error) throw error;
      const raw = (data ?? []) as RawItem[];
      setItems(normalizeItems(raw));
      setTotalCount(raw.length > 0 ? n(raw[0].total_count) : 0);
    } catch (err) {
      console.error("[envio-em-lote] failed to load queue items:", err);
    } finally {
      setItemsLoading(false);
    }
  }, [accountId, campaignId, applied, page, buildItemsParams]);

  useEffect(() => {
    if (!campaignId) {
      setDetail(null);
      setItems([]);
      setTotalCount(0);
      return;
    }
    setDraft(defaultItemFilters());
    setApplied(defaultItemFilters());
    setPage(1);
    loadDetail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId]);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const pageList = useMemo(() => buildPageList(page, totalPages), [page, totalPages]);
  const rangeStart = totalCount === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(page * PAGE_SIZE, totalCount);

  function handlePesquisar() {
    setApplied(draft);
    setPage(1);
  }

  async function handleExportCsv() {
    if (!accountId || !campaignId) return;
    setExporting(true);
    try {
      const db = createClient();
      const { data, error } = await db.rpc(
        "get_campaign_queue_items",
        buildItemsParams(applied, 9999, 0),
      );
      if (error) throw error;
      const allItems = normalizeItems((data ?? []) as RawItem[]);
      const exportRows = allItems.map((it) => ({
        dataHora: format(new Date(it.sentAt ?? it.createdAt), "dd/MM/yyyy HH:mm"),
        contato: it.contactName ?? "-",
        identificador: it.contactPhone ?? "-",
        status: STATUS_BADGE[it.status]?.label ?? it.status,
        mensagem: it.mensagemFinal ?? "",
        erro: it.erro ?? "",
      }));
      await exportWithHistory({
        data: exportRows,
        columns: [
          { key: "dataHora", label: "Data/Hora" },
          { key: "contato", label: "Contato" },
          { key: "identificador", label: "Identificador" },
          { key: "status", label: "Status" },
          { key: "mensagem", label: "Mensagem" },
          { key: "erro", label: "Erro" },
        ],
        exportType: "envio-em-lote",
        description: `Envio em Lote - ${detail?.nome ?? campaignLabel(campaignId)}`,
        format: "csv",
      });
    } catch (err) {
      console.error("[envio-em-lote] export failed:", err);
    } finally {
      setExporting(false);
    }
  }

  function campaignLabel(id: string | null) {
    if (!id) return "Selecione uma campanha";
    const c = campaigns.find((c) => c.id === id);
    if (!c) return id;
    return `${c.nome} - ${format(new Date(c.createdAt), "dd/MM/yyyy HH:mm")}`;
  }

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Envio em Lote</h1>
        <p className="text-sm text-muted-foreground">
          Campanhas do Disparador com métricas agregadas e detalhe por contato.
        </p>
      </div>

      <div className="rounded-xl border border-border bg-card">
        <button
          type="button"
          onClick={() => setFiltersOpen((o) => !o)}
          className="flex w-full items-center justify-between gap-2 px-4 py-3"
        >
          <span className="flex items-center gap-2 text-sm font-medium text-foreground">
            <SlidersHorizontal className="size-4 text-primary" />
            Filtros
          </span>
          <ChevronDown className={`size-4 text-muted-foreground transition-transform ${filtersOpen ? "rotate-180" : ""}`} />
        </button>

        {filtersOpen && (
          <div className="border-t border-border p-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-[240px] space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Campanha</label>
                  <Select value={campaignId ?? ""} onValueChange={(v) => v && setCampaignId(v)}>
                    <SelectTrigger className="w-64">
                      <SelectValue>{() => campaignLabel(campaignId)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent className="z-50">
                      {campaigns.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.nome} - {format(new Date(c.createdAt), "dd/MM/yyyy HH:mm")}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="min-w-[200px] space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Contato</label>
                  <Input
                    value={draft.search}
                    onChange={(e) => setDraft((d) => ({ ...d, search: e.target.value }))}
                    placeholder="Nome ou telefone do contato"
                    disabled={!campaignId}
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Status</label>
                  <Select
                    value={draft.status}
                    onValueChange={(v) => v && setDraft((d) => ({ ...d, status: v }))}
                  >
                    <SelectTrigger className="w-40" disabled={!campaignId}>
                      <SelectValue>
                        {(v: string) => STATUS_OPTIONS.find((o) => o.value === v)?.label ?? v}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent className="z-50">
                      {STATUS_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  onClick={handlePesquisar}
                  disabled={!campaignId}
                  className="bg-[#FF5706] text-white hover:bg-[#FF5706]/90"
                >
                  <Search className="size-4" />
                  Pesquisar
                </Button>
                <Button variant="outline" size="sm" disabled={!campaignId || exporting} onClick={handleExportCsv}>
                  <Download className="size-4" />
                  {exporting ? "Exportando…" : "CSV"}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      {!campaignId ? (
        <div className="rounded-xl border border-border bg-card p-4">
          <EmptyState
            icon={Search}
            title="Selecione uma campanha"
            hint="Escolha uma campanha no filtro acima para ver os detalhes e os itens enviados."
          />
        </div>
      ) : (
        <>
          <div className="rounded-xl border border-border bg-card p-4">
            <h2 className="mb-3 text-sm font-semibold text-foreground">Detalhes</h2>
            {detailLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : !detail ? (
              <p className="text-sm text-muted-foreground">Campanha não encontrada.</p>
            ) : (
              <>
                <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <DetailField label="Título" value={detail.nome} />
                  <DetailField
                    label="Criado por"
                    value={`${detail.createdByName ?? "—"} - ${detail.createdByEmail ?? "—"}`}
                  />
                  <DetailField
                    label="Data de criação"
                    value={format(new Date(detail.createdAt), "dd/MM/yyyy HH:mm")}
                  />
                  <DetailField
                    label="Data de envio"
                    value={
                      detail.agendamento
                        ? format(new Date(detail.agendamento), "dd/MM/yyyy HH:mm")
                        : "—"
                    }
                  />
                  <DetailField label="Mensagens" value={detail.totalMensagens} />
                  <DetailField label="Contatos" value={detail.totalContatos} />
                  <DetailField label="Canal/sessão" value={detail.sessionName ?? "—"} />
                  <DetailField label="Enviado" value={detail.totalEnviados} />
                  <DetailField label="Erro" value={detail.totalErros} />
                  <DetailField label="Lido" value={detail.totalLidos} />
                </dl>
                <div className="mt-3 flex flex-wrap gap-3 border-t border-border pt-3 text-xs text-muted-foreground">
                  <span>Agendado: {detail.totalAgendados}</span>
                  <span>Enviando: {detail.totalEnviando}</span>
                  <span>Cancelado: {detail.totalCancelados}</span>
                  <span>Entregue: {detail.totalEntregues}</span>
                </div>
              </>
            )}
          </div>

          <div className="rounded-xl border border-border bg-card">
            {itemsLoading ? (
              <div className="space-y-3 p-4">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-10 w-full rounded-lg" />
                ))}
              </div>
            ) : items.length === 0 ? (
              <div className="p-4">
                <EmptyState
                  icon={Search}
                  title="Nenhum item encontrado"
                  hint="Ajuste os filtros para ver itens desta campanha."
                />
              </div>
            ) : (
              <TooltipProvider>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Data/Hora</TableHead>
                      <TableHead>Contato</TableHead>
                      <TableHead>Identificador</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Mensagens</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((item) => {
                      const badge = STATUS_BADGE[item.status] ?? {
                        label: item.status,
                        className: "bg-muted text-muted-foreground",
                      };
                      return (
                        <TableRow key={item.id}>
                          <TableCell>
                            {format(new Date(item.sentAt ?? item.createdAt), "dd/MM/yyyy HH:mm")}
                          </TableCell>
                          <TableCell>{item.contactName ?? "-"}</TableCell>
                          <TableCell>{item.contactPhone ?? "-"}</TableCell>
                          <TableCell>
                            <span className="inline-flex items-center gap-1">
                              <Badge className={badge.className}>{badge.label}</Badge>
                              {item.status === "erro" && item.erro && (
                                <Tooltip>
                                  <TooltipTrigger
                                    render={
                                      <button
                                        type="button"
                                        className="text-muted-foreground hover:text-foreground"
                                        aria-label="Ver erro"
                                      />
                                    }
                                  >
                                    <Info className="h-3.5 w-3.5" />
                                  </TooltipTrigger>
                                  <TooltipContent side="top" className="max-w-xs text-left">
                                    {item.erro}
                                  </TooltipContent>
                                </Tooltip>
                              )}
                            </span>
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setViewingMessage(item.mensagemFinal)}
                            >
                              <Eye className="size-4" />
                              Visualizar
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TooltipProvider>
            )}
          </div>

          {items.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card px-4 py-3">
              <span className="text-xs text-muted-foreground">
                {rangeStart} - {rangeEnd} de {totalCount} itens
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="icon-sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  aria-label="Página anterior"
                >
                  <ChevronLeft className="size-4" />
                </Button>
                {pageList.map((p, i) =>
                  p === "ellipsis" ? (
                    <span key={`e-${i}`} className="px-1 text-xs text-muted-foreground">
                      …
                    </span>
                  ) : (
                    <Button
                      key={p}
                      variant={p === page ? "default" : "outline"}
                      size="icon-sm"
                      onClick={() => setPage(p)}
                      className={p === page ? "bg-[#FF5706] text-white hover:bg-[#FF5706]/90" : ""}
                    >
                      {p}
                    </Button>
                  ),
                )}
                <Button
                  variant="outline"
                  size="icon-sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  aria-label="Próxima página"
                >
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      <MessageModal
        open={viewingMessage !== null}
        onOpenChange={(open) => {
          if (!open) setViewingMessage(null);
        }}
        message={viewingMessage}
      />
    </div>
  );
}
