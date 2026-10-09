"use client";

// Painel lateral com as conversas por trás de um número do Monitoramento
// (abas Hoje e SLA). Cada linha leva ao caso no inbox. Dados de
// GET /api/monitoramento/conversations.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { format } from "date-fns";
import { ChevronLeft, ChevronRight, ExternalLink, Loader2 } from "lucide-react";
import { apiFetch } from "@/lib/api-fetch";
import { formatCappedTotal, pageCount, readCappedTotal } from "@/lib/reports/capped-label";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";

export type DrilldownMetric = "received" | "attended" | "closed" | "open" | "queued";

export interface DrilldownQuery {
  title: string;
  metric: DrilldownMetric;
  from?: string;
  to?: string;
  dim?: "agent" | "team" | "channel";
  key?: string;
}

interface Row {
  id: string;
  contact_name: string;
  phone: string | null;
  status: "open" | "pending" | "closed";
  channel_type: string;
  agent_name: string | null;
  created_at: string;
  first_response_min: number | null;
  waiting_min: number | null;
  closed_at: string | null;
}

const STATUS_LABEL: Record<Row["status"], string> = {
  open: "Em atendimento",
  pending: "Em espera",
  closed: "Finalizada",
};
const CHANNEL_LABEL: Record<string, string> = {
  whatsapp: "WhatsApp",
  webchat: "Webchat",
  instagram: "Instagram",
  messenger: "Messenger",
  sms: "SMS",
};

function mins(m: number | null): string {
  if (m === null) return "—";
  return m < 60 ? `${m} min` : `${(m / 60).toFixed(1)} h`;
}

export function ConversationDrilldown({
  query,
  onClose,
}: {
  query: DrilldownQuery | null;
  onClose: () => void;
}) {
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Row[]>([]);
  const [totals, setTotals] = useState({ total: 0, capped: false, cap: 100_000 });
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const queryKey = query ? JSON.stringify(query) : null;

  // Nova consulta volta para a página 1.
  const [lastKey, setLastKey] = useState<string | null>(null);
  if (queryKey !== lastKey) {
    setLastKey(queryKey);
    setPage(1);
  }

  useEffect(() => {
    if (!query) return;
    const mySeq = ++seq.current;
    const qs = new URLSearchParams({ metric: query.metric, page: String(page) });
    if (query.from) qs.set("from", query.from);
    if (query.to) qs.set("to", query.to);
    if (query.dim) qs.set("dim", query.dim);
    if (query.key) qs.set("key", query.key);
    setLoading(true);
    apiFetch(`/api/monitoramento/conversations?${qs.toString()}`)
      .then((r) => r.json())
      .then((json) => {
        if (mySeq !== seq.current) return;
        setRows(json.rows ?? []);
        setTotals(readCappedTotal(json));
      })
      .catch(() => {
        if (mySeq === seq.current) setRows([]);
      })
      .finally(() => {
        if (mySeq === seq.current) setLoading(false);
      });
    // queryKey resume o objeto query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, page]);

  // Com teto ("100 mil+") o total já vem igual ao teto: a paginação não passa dele.
  const pages = pageCount(totals.total, 50);

  return (
    <Sheet open={!!query} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{query?.title}</SheetTitle>
          <SheetDescription>
            {loading ? "Carregando…" : `${formatCappedTotal(totals.total, totals.capped, totals.cap)} conversa(s) · clique para abrir o caso`}
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-1 px-4 pb-4">
          {loading && rows.length === 0 ? (
            <Loader2 className="mx-auto mt-6 h-5 w-5 animate-spin text-muted-foreground" />
          ) : rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Nenhuma conversa.</p>
          ) : (
            rows.map((r) => (
              <Link
                key={r.id}
                href={`/inbox?c=${r.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="group flex items-start justify-between gap-3 rounded-lg border border-border px-3 py-2 text-xs transition-colors hover:border-primary/50 hover:bg-muted/40"
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-1 truncate text-sm font-medium text-foreground group-hover:text-primary">
                    {r.contact_name}
                    <ExternalLink className="h-3 w-3 shrink-0 opacity-60" />
                  </p>
                  <p className="text-muted-foreground">
                    {CHANNEL_LABEL[r.channel_type] ?? r.channel_type} · {STATUS_LABEL[r.status]} ·{" "}
                    {r.agent_name ?? "Sem atendente"}
                  </p>
                </div>
                <div className="shrink-0 text-right text-muted-foreground">
                  <p>{format(new Date(r.created_at), "dd/MM HH:mm")}</p>
                  {r.waiting_min !== null ? (
                    <p className="font-medium text-amber-700 dark:text-amber-400">aguardando {mins(r.waiting_min)}</p>
                  ) : (
                    <p>1ª resposta {mins(r.first_response_min)}</p>
                  )}
                </div>
              </Link>
            ))
          )}
          {pages > 1 && (
            <div className="flex items-center justify-between pt-2 text-xs text-muted-foreground">
              <span>
                Página {page} de {pages}
              </span>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)}>
                  <ChevronLeft className="h-3.5 w-3.5" />
                </Button>
                <Button size="sm" variant="outline" disabled={page >= pages || loading} onClick={() => setPage((p) => p + 1)}>
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
