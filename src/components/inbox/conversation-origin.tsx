"use client";

// Origem da conversa no inbox (PRD-02): faixa no topo da conversa e card
// no painel do contato. Dados de GET /api/conversations/[id]/origin; um
// cache por conversa evita buscar duas vezes (faixa + card).

import { useEffect, useState } from "react";
import { format } from "date-fns";
import { ArrowDownLeft, ArrowUpRight, Megaphone } from "lucide-react";
import { apiFetch } from "@/lib/api-fetch";
import { cn } from "@/lib/utils";
import type { ConversationOrigin } from "@/lib/conversations/origin";

export interface OriginResponse {
  origin: ConversationOrigin;
  channel: string | null;
  line: string | null;
  client: { id: string; name: string; color: string } | null;
}

const cache = new Map<string, Promise<OriginResponse | null>>();

function fetchOrigin(conversationId: string): Promise<OriginResponse | null> {
  let p = cache.get(conversationId);
  if (!p) {
    p = apiFetch(`/api/conversations/${conversationId}/origin`)
      .then((r) => (r.ok ? (r.json() as Promise<OriginResponse>) : null))
      .catch(() => null)
      .then((data) => {
        // Falha ou conversa ainda sem mensagens: busca de novo na próxima vez.
        if (!data || data.origin.direction === "desconhecido") cache.delete(conversationId);
        return data;
      });
    cache.set(conversationId, p);
    // A origem quase não muda; expira em 2 min para pegar atribuição tardia.
    setTimeout(() => cache.delete(conversationId), 120_000);
  }
  return p;
}

export function useConversationOrigin(conversationId: string | null) {
  const [state, setState] = useState<{ id: string; data: OriginResponse | null } | null>(null);
  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    void fetchOrigin(conversationId).then((data) => {
      if (!cancelled) setState({ id: conversationId, data });
    });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);
  return state && state.id === conversationId ? state.data : null;
}

function DirectionChip({ origin }: { origin: ConversationOrigin }) {
  if (origin.direction === "desconhecido") return null;
  const ativo = origin.direction === "ativo";
  const Icon = origin.initiator === "campaign" ? Megaphone : ativo ? ArrowUpRight : ArrowDownLeft;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold",
        ativo
          ? "bg-blue-500/10 text-blue-700 dark:text-blue-300"
          : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
      )}
    >
      <Icon className="h-3 w-3" />
      {ativo ? "Ativo" : "Receptivo"}
    </span>
  );
}

/** Faixa fina no topo da conversa: de onde ela veio. */
export function ConversationOriginBanner({ conversationId }: { conversationId: string }) {
  const data = useConversationOrigin(conversationId);
  if (!data || data.origin.direction === "desconhecido") return null;
  const { origin } = data;
  const detail = origin.headline.replace(/^(Ativo|Receptivo) · /, "");
  return (
    <div className="flex items-center gap-2 overflow-hidden border-b border-border bg-muted/40 px-4 py-1.5 text-[11px] text-muted-foreground">
      <DirectionChip origin={origin} />
      <span className="truncate" title={origin.headline}>
        {detail}
        {origin.opened_at && <> · {format(new Date(origin.opened_at), "dd/MM HH:mm")}</>}
        {data.line && <> · {data.channel} {data.line}</>}
      </span>
      {data.client && (
        <span
          className="ml-auto shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-semibold"
          style={{ color: data.client.color, borderColor: `${data.client.color}40`, backgroundColor: `${data.client.color}1a` }}
        >
          {data.client.name}
        </span>
      )}
    </div>
  );
}

/** Card do painel do contato: quem iniciou e o que foi enviado. */
export function ConversationOriginCard({ conversationId }: { conversationId: string }) {
  const data = useConversationOrigin(conversationId);
  if (!data) return null;
  const { origin } = data;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Origem da conversa</span>
        <DirectionChip origin={origin} />
      </div>
      <div className="space-y-1.5 rounded-lg border border-border bg-card/50 p-2.5 text-xs">
        <p className="font-medium text-foreground">
          {origin.direction === "receptivo"
            ? "O cliente escreveu primeiro"
            : origin.direction === "ativo"
              ? `Iniciada por ${origin.initiator === "campaign" ? "campanha" : origin.by ?? "nós"}`
              : "Sem mensagens ainda"}
        </p>
        {origin.campaign && (
          <p className="text-muted-foreground">
            Campanha: <span className="text-foreground">{origin.campaign.name}</span>
          </p>
        )}
        {origin.template_name && (
          <p className="text-muted-foreground">
            Template: <code className="text-foreground">{origin.template_name}</code>
          </p>
        )}
        {data.line && (
          <p className="text-muted-foreground">
            Linha: <span className="text-foreground">{data.channel} · {data.line}</span>
          </p>
        )}
        {origin.opening_text && (
          <div className="rounded-md bg-muted/60 px-2 py-1.5">
            <p className="mb-0.5 text-[10px] text-muted-foreground">
              {origin.direction === "receptivo" ? "Primeira mensagem do cliente" : "O que enviamos"}
              {origin.opened_at && ` · ${format(new Date(origin.opened_at), "dd/MM/yyyy HH:mm")}`}
            </p>
            <p className="line-clamp-4 whitespace-pre-wrap text-foreground">{origin.opening_text}</p>
          </div>
        )}
      </div>
    </div>
  );
}
