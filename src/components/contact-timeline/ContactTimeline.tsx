"use client";

import { apiFetch } from "@/lib/api-fetch";

// ============================================================
// ContactTimeline — timeline of a contact's past conversations
// (/historico). Filters (Canal, Exibindo) are draft-then-applied via
// "Pesquisar", same two-step UX as Monitoramento's filter panel.
// There is no protocol/display_id column anywhere in this schema
// (confirmed while investigating Monitoramento's filters too), so the
// "Protocolo" filter from the original Fortics-inspired spec is
// intentionally omitted rather than invented.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import { MessageCircle, Search } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Skeleton } from "@/components/dashboard/skeleton";
import type { AccountMember, Team } from "@/types";
import {
  loadContactConversations,
  type TimelineConversation,
} from "@/lib/contact-timeline/queries";
import { ConversationCard } from "./ConversationCard";

const ALL_CHANNELS = "__all__";
const DISPLAY_LIMIT_OPTIONS = [5, 10, 25, 50] as const;

export function ContactTimeline({
  contactId,
  contactName,
  contactInitial,
}: {
  contactId: string;
  contactName: string;
  contactInitial: string;
}) {
  const { accountId } = useAuth();

  const [channelOptions, setChannelOptions] = useState<string[]>([]);
  const [channelDraft, setChannelDraft] = useState(ALL_CHANNELS);
  const [limitDraft, setLimitDraft] = useState<number>(10);
  const [appliedChannel, setAppliedChannel] = useState(ALL_CHANNELS);
  const [appliedLimit, setAppliedLimit] = useState<number>(10);

  const [members, setMembers] = useState<AccountMember[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [conversations, setConversations] = useState<TimelineConversation[]>([]);
  const [loading, setLoading] = useState(true);

  // Members/teams — same account-scoped lists Monitoramento already
  // fetches, needed here to resolve assigned_agent_id/team_id into
  // display names (neither column has a usable FK to embed via
  // PostgREST — see queries.ts).
  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/account/members", { cache: "no-store" })
      .then((res) => res.json())
      .then((data: { members?: AccountMember[] }) => {
        if (!cancelled) setMembers(data.members ?? []);
      })
      .catch((err) => console.error("[historico] failed to load members:", err));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    const db = createClient();
    db.from("teams")
      .select("*")
      .eq("account_id", accountId)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error("[historico] failed to load teams:", error);
          return;
        }
        setTeams((data ?? []) as Team[]);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  // Wide, unfiltered-by-channel fetch just to enumerate which channels
  // this contact has actually talked on — independent of the applied
  // Canal/Exibindo filters below, so switching "Exibindo" to 5 doesn't
  // make other channels disappear from the dropdown.
  useEffect(() => {
    if (!accountId || !contactId) return;
    let cancelled = false;
    const db = createClient();
    loadContactConversations(db, { accountId, contactId, limit: 200 })
      .then((rows) => {
        if (cancelled) return;
        const sessions = Array.from(
          new Set(rows.map((r) => r.waha_session).filter((s): s is string => !!s)),
        );
        setChannelOptions(sessions);
      })
      .catch((err) => console.error("[historico] failed to load channel options:", err));
    return () => {
      cancelled = true;
    };
  }, [accountId, contactId]);

  const runSearch = useCallback(async () => {
    if (!accountId || !contactId) return;
    setLoading(true);
    try {
      const db = createClient();
      const rows = await loadContactConversations(db, {
        accountId,
        contactId,
        wahaSession: appliedChannel === ALL_CHANNELS ? null : appliedChannel,
        limit: appliedLimit,
      });
      setConversations(rows);
    } catch (err) {
      console.error("[historico] failed to load conversations:", err);
    } finally {
      setLoading(false);
    }
  }, [accountId, contactId, appliedChannel, appliedLimit]);

  useEffect(() => {
    runSearch();
  }, [runSearch]);

  // New contact selected — reset filters back to defaults rather than
  // carrying over the previous contact's Canal/Exibindo choice.
  useEffect(() => {
    setChannelDraft(ALL_CHANNELS);
    setLimitDraft(10);
    setAppliedChannel(ALL_CHANNELS);
    setAppliedLimit(10);
  }, [contactId]);

  function handlePesquisar() {
    setAppliedChannel(channelDraft);
    setAppliedLimit(limitDraft);
  }

  function getAgentName(agentId: string | null) {
    if (!agentId) return null;
    return members.find((m) => m.user_id === agentId)?.full_name ?? null;
  }

  function getTeamName(teamId: string | null) {
    if (!teamId) return null;
    return teams.find((t) => t.id === teamId)?.name ?? null;
  }

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="border-b border-[#F3F4F6] p-4">
        <div className="flex items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[#6366F1] text-sm font-semibold text-white">
            {contactInitial}
          </span>
          <h2 className="text-base font-semibold text-foreground">{contactName}</h2>
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Canal</label>
            <Select value={channelDraft} onValueChange={(v) => v && setChannelDraft(v)}>
              <SelectTrigger className="w-44">
                <SelectValue>
                  {(v: string) => (v === ALL_CHANNELS ? "Todos" : v)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_CHANNELS}>Todos</SelectItem>
                {channelOptions.map((session) => (
                  <SelectItem key={session} value={session}>
                    {session}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Exibindo</label>
            <Select
              value={String(limitDraft)}
              onValueChange={(v) => v && setLimitDraft(Number(v))}
            >
              <SelectTrigger className="w-36">
                <SelectValue>{(v: string) => `${v} últimos`}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {DISPLAY_LIMIT_OPTIONS.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n} últimos
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Button onClick={handlePesquisar} className="bg-[#FF5706] text-white hover:bg-[#FF5706]/90">
            <Search className="size-4" />
            Pesquisar
          </Button>
        </div>
      </div>

      <div className="space-y-3 p-4">
        {loading ? (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-20 w-full rounded-xl" />
            ))}
          </div>
        ) : conversations.length === 0 ? (
          <EmptyState
            icon={MessageCircle}
            title="Nenhum atendimento encontrado"
            hint="Este contato ainda não teve conversas registradas com os filtros atuais."
          />
        ) : (
          <div className="relative space-y-3 border-l-2 border-[#E5E7EB]">
            {conversations.map((conversation) => (
              <ConversationCard
                key={conversation.id}
                conversation={conversation}
                agentName={getAgentName(conversation.assigned_agent_id)}
                teamName={getTeamName(conversation.team_id)}
                contactInitial={contactInitial}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}