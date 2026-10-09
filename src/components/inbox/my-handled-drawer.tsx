"use client";

import { useCallback, useEffect, useState } from "react";
import { format, formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import { ArrowRight, Loader2 } from "lucide-react";

import { apiFetch } from "@/lib/api-fetch";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DetailDrawer } from "@/components/ddm/list-with-drawer";
import { Segmented } from "@/components/ddm/segmented";
import { StatusChip, type StatusTone } from "@/components/ddm/status-chip";
import { ErrorState } from "@/components/dashboard/error-state";
import type { ConversationStatus } from "@/types";
import { CONVERSATION_STATUS_LABELS } from "./status-labels";
import { CHANNEL_BADGE } from "./conversation-list";

// GET /api/inbox/meus-atendidos (item 17 do PRD 23, Cinzel f17909cd):
// conversas que o usuário atendeu e transferiu. LISTA SOMENTE LEITURA — a
// RLS continua escondendo a conversa/mensagens dele, então nada aqui abre a
// thread; mostra com quem ela está agora.

interface HandledConversation {
  id: string;
  channel_type: string | null;
  status: ConversationStatus;
  last_message_at: string | null;
  last_message_text: string | null;
  contact: { id: string; name: string | null; phone: string | null } | null;
  outcome_tag: { id: string; name: string; color: string | null } | null;
  transferred_at: string;
  transfer_reason: string | null;
  transferred_to: { id: string; full_name: string | null } | null;
  transferred_to_team_id: string | null;
}

const STATUS_TONE: Record<ConversationStatus, StatusTone> = {
  open: "info",
  pending: "warn",
  closed: "mute",
};

const WINDOWS = [
  { value: "30", label: "30 dias" },
  { value: "90", label: "90 dias" },
  { value: "365", label: "1 ano" },
] as const;
type Window = (typeof WINDOWS)[number]["value"];

function holderLabel(c: HandledConversation): string {
  if (c.transferred_to) return `com ${c.transferred_to.full_name ?? "outro atendente"}`;
  if (c.transferred_to_team_id) return "na fila de uma equipe";
  return "sem atendente";
}

export function MyHandledDrawer({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [days, setDays] = useState<Window>("90");
  const [items, setItems] = useState<HandledConversation[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const fetchPage = useCallback(
    async (after: string | null) => {
      const qs = new URLSearchParams({ days });
      if (after) qs.set("cursor", after);
      const res = await apiFetch(`/api/inbox/meus-atendidos?${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as { conversations: HandledConversation[]; next_cursor: string | null };
    },
    [days],
  );

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setItems(null);
    setError(false);
    fetchPage(null)
      .then((page) => {
        if (cancelled) return;
        setItems(page.conversations ?? []);
        setCursor(page.next_cursor);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, fetchPage, reloadKey]);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchPage(cursor);
      setItems((prev) => [...(prev ?? []), ...(page.conversations ?? [])]);
      setCursor(page.next_cursor);
    } catch {
      setError(true);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <DetailDrawer
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title="Meus atendidos"
      description="Conversas que você atendeu e transferiu. Só consulta: a conversa segue com quem está agora."
    >
      <div className="flex flex-col gap-3">
        <Segmented ariaLabel="Período" value={days} onChange={setDays} options={WINDOWS} />

        {error && !items ? (
          <ErrorState
            title="Não foi possível carregar"
            hint="Verifique a conexão e tente de novo."
            onRetry={() => setReloadKey((k) => k + 1)}
          />
        ) : items === null ? (
          <div className="flex flex-col gap-2" aria-busy="true">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-[72px] w-full rounded-lg" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="flex animate-ddm-fade flex-col items-center gap-1.5 px-4 py-10 text-center">
            <p className="text-[13.5px] font-semibold text-foreground">Nenhuma transferência no período</p>
            <p className="text-[12.5px] text-muted-foreground">Quando você transferir um atendimento, ele aparece aqui.</p>
          </div>
        ) : (
          <>
            <ul className="ddm-stagger flex flex-col gap-2">
              {items.map((c) => {
                const name = c.contact?.name?.trim() || c.contact?.phone || "Contato";
                const channel = c.channel_type ? CHANNEL_BADGE[c.channel_type] : undefined;
                return (
                  <li key={c.id} className="flex flex-col gap-1.5 rounded-lg border border-border bg-card px-3.5 py-3">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13.5px] font-semibold text-foreground">{name}</p>
                        {c.contact?.name && c.contact.phone && (
                          <p className="truncate text-xs tabular-nums text-muted-foreground">{c.contact.phone}</p>
                        )}
                      </div>
                      <StatusChip tone={STATUS_TONE[c.status] ?? "mute"}>
                        {CONVERSATION_STATUS_LABELS[c.status] ?? c.status}
                      </StatusChip>
                    </div>
                    <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-foreground-2">
                      <ArrowRight className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="font-semibold">{holderLabel(c)}</span>
                      <time
                        dateTime={c.transferred_at}
                        title={format(new Date(c.transferred_at), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}
                        className="text-muted-foreground"
                      >
                        · transferida {formatDistanceToNow(new Date(c.transferred_at), { addSuffix: true, locale: ptBR })}
                      </time>
                    </p>
                    {c.transfer_reason && (
                      <p className="text-xs text-muted-foreground">Motivo: {c.transfer_reason}</p>
                    )}
                    {c.last_message_text && (
                      <p className="line-clamp-1 text-xs text-muted-foreground">{c.last_message_text}</p>
                    )}
                    {(channel || c.outcome_tag) && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        {channel && (
                          <span className={`rounded border px-1.5 py-px text-[10.5px] font-semibold ${channel.className}`}>
                            {channel.label}
                          </span>
                        )}
                        {c.outcome_tag && (
                          <span
                            className="rounded-full px-2 py-px text-[11px] font-semibold"
                            style={
                              c.outcome_tag.color
                                ? { backgroundColor: `${c.outcome_tag.color}20`, color: c.outcome_tag.color }
                                : undefined
                            }
                          >
                            {c.outcome_tag.name}
                          </span>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            {error && <p className="text-center text-xs text-danger">Falha ao carregar mais itens.</p>}
            {cursor && (
              <div className="flex justify-center pt-1">
                <Button variant="outline" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
                  {loadingMore && <Loader2 className="size-3.5 animate-spin" />}
                  Carregar mais
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </DetailDrawer>
  );
}
