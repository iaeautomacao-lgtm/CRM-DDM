"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import { ExternalLink, GitFork, Loader2, RefreshCw } from "lucide-react";

import { apiFetch } from "@/lib/api-fetch";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { NODE_META } from "@/components/flows/shared";

// Card "Fluxo" do painel do contato: mostra em qual fluxo (e em qual nó)
// a conversa está ou esteve, com atalho para abrir o editor naquele ponto.
// Só é montado para owner/admin — quem decide é o ContactSidebar via
// useCan("view-conversation-flows"); a API também exige admin.

interface ConversationFlowRun {
  id: string;
  flow_id: string;
  flow_name: string | null;
  status: string;
  current_node_key: string | null;
  current_node_type: string | null;
  started_at: string;
  last_advanced_at: string;
  ended_at: string | null;
}

interface FlowRunsResponse {
  matched_by: "conversation" | "contact";
  runs: ConversationFlowRun[];
}

const STATUS_LABEL: Record<string, { label: string; className: string }> = {
  active: { label: "Ativo", className: "bg-emerald-500/10 text-emerald-600" },
  delayed: { label: "Aguardando", className: "bg-sky-500/10 text-sky-600" },
  paused_by_agent: { label: "Pausado pelo atendente", className: "bg-amber-500/10 text-amber-600" },
  handed_off: { label: "Transferido p/ atendente", className: "bg-violet-500/10 text-violet-600" },
  transferred: { label: "Foi para outro fluxo", className: "bg-violet-500/10 text-violet-600" },
  completed: { label: "Concluído", className: "bg-muted text-muted-foreground" },
  timed_out: { label: "Expirado", className: "bg-muted text-muted-foreground" },
  failed: { label: "Falhou", className: "bg-rose-500/10 text-rose-600" },
  error: { label: "Erro", className: "bg-rose-500/10 text-rose-600" },
};

function nodeLabel(run: ConversationFlowRun): string | null {
  if (!run.current_node_key) return null;
  const meta = run.current_node_type
    ? (NODE_META as Record<string, { label: string } | undefined>)[run.current_node_type]
    : undefined;
  return meta ? `${meta.label} (${run.current_node_key})` : run.current_node_key;
}

/**
 * Link do editor no ponto em que o run está: `run_id` liga o modo debug
 * (caminho percorrido) e `node` centraliza/destaca o nó atual.
 */
// Abre a EXECUÇÃO deste contato (página de execuções já expandida nela),
// não só o fluxo — de lá, "Ver no diagrama" mostra o caminho no editor.
function editorHref(run: ConversationFlowRun): string {
  return `/flows/${run.flow_id}/runs?run_id=${encodeURIComponent(run.id)}`;
}

export function ConversationFlowCard({
  conversationId,
  canOpenEditor,
}: {
  conversationId: string;
  /** Se o usuário pode abrir /flows (ROUTE_ALLOWLIST). Sem isso o card só
   *  informa o fluxo e o nó, sem link — evita mandar para /unauthorized. */
  canOpenEditor: boolean;
}) {
  const [data, setData] = useState<FlowRunsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(
    async (isCancelled: () => boolean) => {
      setLoading(true);
      setFailed(false);
      try {
        const res = await apiFetch(`/api/conversations/${conversationId}/flow-runs`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as FlowRunsResponse;
        if (!isCancelled()) setData(json);
      } catch (err) {
        console.error("[ConversationFlowCard] failed to load flow runs:", err);
        if (!isCancelled()) setFailed(true);
      } finally {
        if (!isCancelled()) setLoading(false);
      }
    },
    [conversationId]
  );

  // Recarrega ao trocar de conversa; `cancelled` descarta respostas de uma
  // conversa que o atendente já deixou (mesmo padrão do ContactSidebar).
  useEffect(() => {
    let cancelled = false;
    load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [load]);

  const [latest, ...older] = data?.runs ?? [];

  return (
    <div>
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          <GitFork className="h-3 w-3" />
          Fluxo
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 rounded-full text-muted-foreground hover:text-foreground"
          disabled={loading}
          onClick={() => load(() => false)}
          title="Atualizar"
        >
          <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
        </Button>
      </div>

      <div className="mt-2 space-y-2">
        {loading && !data ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : failed ? (
          <p className="px-1 text-xs text-muted-foreground">Não foi possível carregar o fluxo</p>
        ) : !latest ? (
          <p className="px-1 text-xs text-muted-foreground">Nenhum fluxo rodou nesta conversa</p>
        ) : (
          <>
            <RunRow run={latest} highlight canOpen={canOpenEditor} />
            {data?.matched_by === "contact" && (
              <p className="px-1 text-[10px] text-muted-foreground">
                Execuções do contato (sem vínculo direto com esta conversa)
              </p>
            )}
            {older.map((run) => (
              <RunRow key={run.id} run={run} canOpen={canOpenEditor} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function RunRow({
  run,
  highlight = false,
  canOpen,
}: {
  run: ConversationFlowRun;
  highlight?: boolean;
  canOpen: boolean;
}) {
  const status = STATUS_LABEL[run.status] ?? {
    label: run.status,
    className: "bg-muted text-muted-foreground",
  };
  const node = nodeLabel(run);
  const when = run.ended_at ?? run.last_advanced_at;
  const className = cn(
    "group block rounded-lg px-3 py-2",
    highlight ? "bg-muted" : "bg-muted/40",
    canOpen && "transition-colors hover:bg-muted/80"
  );

  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-sm font-medium text-foreground">
          {run.flow_name ?? "Fluxo sem nome"}
        </p>
        {canOpen && (
          <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground group-hover:text-primary" />
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
        <span className={cn("rounded-full px-1.5 py-0.5 font-medium", status.className)}>
          {status.label}
        </span>
        <span>{formatDistanceToNow(new Date(when), { addSuffix: true, locale: ptBR })}</span>
      </div>
      {node && highlight && (
        <p className="mt-1 truncate text-[11px] text-muted-foreground">
          {run.ended_at ? "Parou em" : "Nó atual"}: {node}
        </p>
      )}
    </>
  );

  return canOpen ? (
    <Link href={editorHref(run)} className={className} title="Abrir a execução deste contato">
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}
