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
  Clock,
  Send,
  Eye,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
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

interface QueueRow {
  id: string;
  status: string;
  erro: string | null;
  scheduled_at: string;
  sent_at: string | null;
  entrega_pendente_131026?: boolean | null;
  contacts?: { name: string | null; phone: string | null } | null;
}

const STATUS_BADGE: Record<string, string> = {
  agendado: "bg-zinc-500/10 text-zinc-500",
  enviando: "bg-primary/10 text-primary",
  enviado: "bg-emerald-500/10 text-emerald-500",
  entregue: "bg-emerald-500/10 text-emerald-500",
  lido: "bg-blue-500/10 text-blue-500",
  erro: "bg-red-500/10 text-red-500",
  pausado: "bg-amber-500/10 text-amber-500",
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
      <div className="flex h-[calc(100vh-4rem-2.75rem)] flex-col items-center justify-center gap-3 p-6 text-center">
        <AlertCircle className="h-10 w-10 text-red-500" />
        <p className="text-sm text-muted-foreground">
          Campanha não encontrada ou fora da sua conta.
        </p>
        <Link
          href="/disparador/campanhas"
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          Voltar para Campanhas
        </Link>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-4rem-2.75rem)] flex-col space-y-4 p-4 lg:p-6 overflow-hidden">
      {/* Header */}
      <div className="flex flex-col justify-between gap-4 border-b border-border/40 pb-4 sm:flex-row sm:items-center">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Link
              href="/disparador/campanhas"
              aria-label="Voltar para Campanhas"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground transition-colors mr-1"
              title="Voltar para Campanhas"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            </Link>
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden="true">
              <ListChecks className="h-5 w-5" />
            </div>
            <h1 className="min-w-0 text-xl font-bold tracking-tight text-foreground sm:text-2xl truncate max-w-md">
              {campaignName || "Carregando…"}
            </h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Envios por contato{totalCount != null ? ` — ${totalCount} no total` : ""}
          </p>
        </div>

        <Select value={statusFilter} onValueChange={(v) => handleStatusFilterChange(v || "__all__")}>
          <SelectTrigger className="w-full sm:w-48" aria-label="Filtrar por status">
            <SelectValue>
              {(v: string) => (v === "__all__" ? "Todos os status" : STATUS_LABEL[v] ?? v)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">Todos os status</SelectItem>
            {Object.keys(STATUS_LABEL).map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_LABEL[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {codigoFilter !== null && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="inline-flex items-center gap-2 rounded-full border border-border bg-muted/50 px-3 py-1">
            Filtrando pelo código de erro <strong>{codigoFilter}</strong>
            <button
              type="button"
              onClick={() => {
                setCodigoFilter(null);
                setPage(0);
              }}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Limpar filtro de código"
            >
              ✕
            </button>
          </span>
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-y-auto rounded-xl border border-border bg-card">
        {loading ? (
          <div className="flex h-48 items-center justify-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" /> Carregando envios...
          </div>
        ) : rows.length === 0 ? (
          <div className="flex h-48 flex-col items-center justify-center text-center text-muted-foreground">
            <ListChecks className="h-10 w-10 opacity-20 mb-2" />
            <h4 className="font-semibold">Nenhum envio encontrado</h4>
            <p className="text-xs max-w-xs mt-1">
              {statusFilter === "__all__"
                ? "Esta campanha ainda não tem itens na fila."
                : "Nenhum item com este status."}
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Telefone</TableHead>
                <TableHead>Nome</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Erro</TableHead>
                <TableHead className="text-right">Data de envio</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const isPending131026 = r.entrega_pendente_131026 === true;
                const Icon = isPending131026 ? Clock : (STATUS_ICON[r.status] ?? Clock);
                const badgeClass = isPending131026
                  ? "bg-amber-500/10 text-amber-600"
                  : (STATUS_BADGE[r.status] || STATUS_BADGE.agendado);
                const badgeLabel = isPending131026
                  ? "Aguardando confirmação"
                  : (STATUS_LABEL[r.status] || r.status);
                const badgeTitle = isPending131026
                  ? "A Meta informou 131026; pode ser aparelho offline. Confirmamos em até 24h."
                  : undefined;
                return (
                  <TableRow key={r.id}>
                    <TableCell>{r.contacts?.phone || "—"}</TableCell>
                    <TableCell>{r.contacts?.name || "—"}</TableCell>
                    <TableCell>
                      <span
                        title={badgeTitle}
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${badgeClass}`}
                      >
                        <Icon aria-hidden="true" className={`h-3 w-3 ${!isPending131026 && r.status === "enviando" ? "animate-spin" : ""}`} />
                        {badgeLabel}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-[280px] truncate text-xs text-red-500">
                      {r.erro ? normalizarErroMeta(r.erro) : "—"}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {r.sent_at
                        ? new Date(r.sent_at).toLocaleString("pt-BR")
                        : new Date(r.scheduled_at).toLocaleString("pt-BR")}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Pagination */}
      {(page > 0 || hasMore) && (
        <nav aria-label="Paginação" className="flex items-center justify-between text-xs text-muted-foreground">
          <Button
            variant="outline"
            size="sm"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            Anterior
          </Button>
          <span>Página {page + 1}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={!hasMore}
            onClick={() => setPage((p) => p + 1)}
          >
            Próxima
          </Button>
        </nav>
      )}
    </div>
  );
}
