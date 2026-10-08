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

function DirectionChip({ origin, className }: { origin: ConversationOrigin; className?: string }) {
  if (origin.direction === "desconhecido") return null;
  const ativo = origin.direction === "ativo";
  const Icon = origin.initiator === "campaign" ? Megaphone : ativo ? ArrowUpRight : ArrowDownLeft;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-2 text-xs font-medium text-foreground",
        className,
      )}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {ativo ? "Ativo" : "Receptivo"}
    </span>
  );
}

/** Faixa de uma linha no topo da conversa: de onde ela veio. Neutra (sem
 *  pílulas coloridas); o cliente já aparece no cabeçalho e o detalhe
 *  completo fica no card "Origem" do painel do contato. */
export function ConversationOriginBanner({ conversationId }: { conversationId: string }) {
  const data = useConversationOrigin(conversationId);
  if (!data || data.origin.direction === "desconhecido") return null;
  const { origin } = data;
  const ativo = origin.direction === "ativo";
  const Icon = origin.initiator === "campaign" ? Megaphone : ativo ? ArrowUpRight : ArrowDownLeft;
  const summary =
    origin.direction === "receptivo"
      ? "cliente iniciou"
      : origin.initiator === "campaign"
        ? "iniciada por campanha"
        : "iniciada pela operação";

  return (
    <div className="flex items-center gap-1.5 overflow-hidden border-b border-border/70 bg-background px-4 py-1.5 text-[11px] text-muted-foreground">
      <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="truncate">
        <span className="font-medium text-foreground/85">{ativo ? "Ativo" : "Receptivo"}</span>
        <span> · {summary}</span>
      </span>
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
      {/* O título "Origem" vem da seção recolhível do painel do contato. */}
      <div className="space-y-1 rounded-lg border border-border bg-card/50 p-2 text-xs">
        <DirectionChip origin={origin} className="mb-1" />
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
            <p className="mb-0.5 text-xs text-muted-foreground">
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
