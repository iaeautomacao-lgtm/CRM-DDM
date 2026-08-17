"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useRealtime } from "@/hooks/use-realtime";
import { usePresence } from "@/hooks/use-presence";
import { useSelection } from "@/hooks/use-selection";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { RequireRole } from "@/components/auth/require-role";
import { TeamFormDialog } from "@/components/settings/team-form-dialog";
import { OutcomeTagPicker } from "@/components/inbox/outcome-tag-picker";
import type { AccountMember, Conversation, Tag, Team } from "@/types";
import {
  loadActiveConversations,
  loadConversationById,
  type MonitorConversation,
} from "@/lib/monitoramento/queries";
import { classifyPhase, PHASE_ORDER, type MonitorPhase } from "@/lib/monitoramento/phases";
import { sortAgentsByPresence, groupConversationsByAgent } from "@/lib/monitoramento/agents";
import { groupConversationsByTeam, groupMembersByTeam } from "@/lib/monitoramento/teams";
import {
  EMPTY_FILTERS,
  filterConversations,
  type MonitorFilters,
} from "@/lib/monitoramento/filters";
import { closeConversationWithOutcomeTag } from "@/lib/conversations/actions";
import { MonitorKpiRow } from "@/components/monitoramento/kpi-row";
import { MonitorFiltersPanel } from "@/components/monitoramento/monitor-filters-panel";
import type { MultiSelectOption } from "@/components/monitoramento/multi-select-filter";
import { PhaseColumn } from "@/components/monitoramento/phase-column";
import { AgentColumn } from "@/components/monitoramento/agent-column";
import { AgentDragCard } from "@/components/monitoramento/agent-drag-card";
import { TeamColumn } from "@/components/monitoramento/team-column";
import { TransferDialog } from "@/components/monitoramento/transfer-dialog";
import type { ConversationCardActions } from "@/components/monitoramento/card-actions";
import { ContactTimelineModal } from "@/components/contact-timeline/ContactTimelineModal";

export default function MonitoramentoPage() {
  const { accountId, canManageMembers } = useAuth();
  const [conversations, setConversations] = useState<Map<string, MonitorConversation>>(
    () => new Map(),
  );
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      const db = createClient();
      const rows = await loadActiveConversations(db, accountId);
      setConversations(new Map(rows.map((r) => [r.id, r])));
    } catch (err) {
      console.error("[monitoramento] failed to load conversations:", err);
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    load();
  }, [load]);

  // Synchronous membership check for the realtime handler below — a
  // closure over `conversations` state would always read stale (state
  // updates are async), so this ref is kept in lockstep via the effect.
  // Mirrors the Inbox's `knownConvIdsRef` (src/app/(dashboard)/inbox/page.tsx).
  const knownIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    knownIdsRef.current = new Set(conversations.keys());
  }, [conversations]);

  const dropConversation = useCallback((id: string) => {
    setConversations((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const hydrateConversation = useCallback(async (id: string) => {
    const db = createClient();
    const row = await loadConversationById(db, id);
    if (!row) return;
    setConversations((prev) => {
      if (row.status === "closed") {
        if (!prev.has(id)) return prev;
        const next = new Map(prev);
        next.delete(id);
        return next;
      }
      const next = new Map(prev);
      next.set(id, row);
      return next;
    });
  }, []);

  const handleConversationEvent = useCallback(
    (event: { eventType: string; new: Conversation; old: Partial<Conversation> }) => {
      if (event.eventType === "DELETE") {
        const oldId = event.old?.id;
        if (oldId) dropConversation(oldId);
        return;
      }

      const conv = event.new;
      if (!conv?.id) return;

      // Closed conversations don't belong on this board regardless of
      // whether we already knew about them.
      if (conv.status === "closed") {
        dropConversation(conv.id);
        return;
      }

      if (knownIdsRef.current.has(conv.id)) {
        setConversations((prev) => {
          const existing = prev.get(conv.id);
          if (!existing) return prev;
          const next = new Map(prev);
          next.set(conv.id, {
            ...existing,
            status: conv.status,
            assigned_agent_id: conv.assigned_agent_id ?? null,
            // Nothing writes team_id in this phase, but carrying it
            // through the patch (instead of dropping it) means the
            // "Equipes" tab won't show stale data the moment phase 3b's
            // automation action starts setting it on tracked rows.
            team_id: conv.team_id ?? null,
            updated_at: conv.updated_at,
          });
          return next;
        });
      } else {
        // New to this board, or an UPDATE that raced ahead of its own
        // INSERT — fetch it with the `contact` join, which realtime
        // payloads never carry.
        void hydrateConversation(conv.id);
      }
    },
    [dropConversation, hydrateConversation],
  );

  // Reuses the same Realtime hook the Inbox subscribes with — one
  // channel, `postgres_changes` on `wacrm.conversations`, RLS-scoped to
  // this account's rows same as every other read here. `onMessageEvent`
  // is omitted: this board doesn't care about individual messages, only
  // conversation-level phase transitions.
  const { isConnected } = useRealtime({
    channelName: "monitoramento-realtime",
    onConversationEvent: handleConversationEvent,
    enabled: true,
  });

  // Realtime is best-effort — a dropped WS (laptop sleep, network blip)
  // silently loses events sent while disconnected. Refetch once on each
  // reconnect (but not on the initial connect, which the mount effect
  // above already covers) to catch up. Mirrors the Inbox's resync.
  const wasConnectedRef = useRef(false);
  const initialConnectDoneRef = useRef(false);
  useEffect(() => {
    if (isConnected && !wasConnectedRef.current) {
      if (initialConnectDoneRef.current) {
        load();
      } else {
        initialConnectDoneRef.current = true;
      }
    }
    wasConnectedRef.current = isConnected;
  }, [isConnected, load]);

  // ----------------------------------------------------------
  // Shared filter bar (Fortics-style) — ONE filter state, applied
  // above the tab selector, restricting which conversations enter
  // whichever tab's grouping (byPhase/byAgent/byTeam below) rather
  // than each tab having its own copy. `members`/`teams` (fetched
  // further down for the Agentes/Equipes tabs) double as the
  // Agentes/Equipes filter options — no separate fetch for those.
  // Channels and contact tags aren't loaded anywhere else yet, so
  // they get their own one-time fetch here, same pattern as
  // members/teams: a plain table read, no realtime.
  // ----------------------------------------------------------
  const [appliedFilters, setAppliedFilters] = useState<MonitorFilters>(EMPTY_FILTERS);

  // WAHA lines only (see filters investigation) — Meta-provider
  // conversations have no channel column anywhere, so a Meta line
  // would be a filter option that always matches zero conversations.
  const [channels, setChannels] = useState<{ waha_session: string }[]>([]);
  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    const db = createClient();
    db.from("whatsapp_config")
      .select("waha_session")
      .eq("account_id", accountId)
      .eq("provider", "waha")
      .not("waha_session", "is", null)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error("[monitoramento] failed to load channels:", error);
          return;
        }
        setChannels((data ?? []) as { waha_session: string }[]);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  // kind='contact' only — excludes the tabulação/outcome dictionary
  // (migration 041). The two auto-tags from migration 036 ("IA
  // Conversando" / "Atendimento Humano") are kind='contact' by
  // default and deliberately included, per explicit product decision.
  const [contactTags, setContactTags] = useState<Tag[]>([]);
  const [contactTagsByContact, setContactTagsByContact] = useState<
    Map<string, Set<string>>
  >(new Map());
  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    const db = createClient();
    (async () => {
      const [tagsRes, contactTagsRes] = await Promise.all([
        db
          .from("tags")
          .select("id, name, color, kind")
          .eq("account_id", accountId)
          .eq("kind", "contact")
          .order("name"),
        db.from("contact_tags").select("contact_id, tag_id"),
      ]);
      if (cancelled) return;
      if (tagsRes.error) {
        console.error("[monitoramento] failed to load tags:", tagsRes.error);
      } else {
        setContactTags((tagsRes.data ?? []) as Tag[]);
      }
      if (contactTagsRes.error) {
        console.error("[monitoramento] failed to load contact_tags:", contactTagsRes.error);
      } else {
        const map = new Map<string, Set<string>>();
        for (const row of (contactTagsRes.data ?? []) as {
          contact_id: string;
          tag_id: string;
        }[]) {
          const set = map.get(row.contact_id);
          if (set) set.add(row.tag_id);
          else map.set(row.contact_id, new Set([row.tag_id]));
        }
        setContactTagsByContact(map);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const filteredConversations = useMemo(
    () => filterConversations(conversations.values(), appliedFilters, contactTagsByContact),
    [conversations, appliedFilters, contactTagsByContact],
  );

  const grouped = useMemo(() => {
    const byPhase: Record<MonitorPhase, MonitorConversation[]> = {
      navegando: [],
      espera: [],
      atendimento: [],
    };
    for (const row of filteredConversations) {
      byPhase[classifyPhase(row.status, row.assigned_agent_id)].push(row);
    }
    for (const phase of PHASE_ORDER) {
      byPhase[phase].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
    }
    return byPhase;
  }, [filteredConversations]);

  // ----------------------------------------------------------
  // "Agentes" tab — reuses the same live `conversations` Map above
  // (grouped by assignee instead of by phase) and the account's
  // presence, which now that use-presence.ts subscribes to the right
  // schema, updates without a reload.
  // ----------------------------------------------------------
  const [members, setMembers] = useState<AccountMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/account/members", { cache: "no-store" })
      .then((res) => res.json())
      .then((data: { members?: AccountMember[] }) => {
        if (!cancelled) setMembers(data.members ?? []);
      })
      .catch((err) => console.error("[monitoramento] failed to load members:", err))
      .finally(() => {
        if (!cancelled) setMembersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const { getPresence, getRow, now } = usePresence();

  const sortedAgents = useMemo(
    () => sortAgentsByPresence(members, getPresence),
    [members, getPresence],
  );

  const byAgent = useMemo(
    () => groupConversationsByAgent(filteredConversations),
    [filteredConversations],
  );

  // ----------------------------------------------------------
  // "Equipes" tab — same live `conversations` Map above, grouped by
  // team_id instead of by phase or assignee. Teams themselves are
  // fetched once (any account member can read them, migration 049
  // RLS) — no realtime needed for the team roster, membership/config
  // changes are rare and the panel that edits them already refetches
  // on save.
  // ----------------------------------------------------------
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamsLoading, setTeamsLoading] = useState(true);
  // Single dialog instance for both "create" (team=null) and "edit"
  // (team=<the column's team>) — same TeamFormDialog used in
  // teams-panel.tsx (Settings), not a second copy.
  const [teamDialogOpen, setTeamDialogOpen] = useState(false);
  const [editingTeam, setEditingTeam] = useState<Team | null>(null);

  const openCreateTeam = useCallback(() => {
    setEditingTeam(null);
    setTeamDialogOpen(true);
  }, []);

  const openEditTeam = useCallback((team: Team) => {
    setEditingTeam(team);
    setTeamDialogOpen(true);
  }, []);

  const fetchTeams = useCallback(async () => {
    if (!accountId) return;
    const db = createClient();
    const { data, error } = await db
      .from("teams")
      .select("*")
      .eq("account_id", accountId)
      .order("name");
    if (error) {
      console.error("[monitoramento] failed to load teams:", error);
      return;
    }
    setTeams((data ?? []) as Team[]);
  }, [accountId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await fetchTeams();
      if (!cancelled) setTeamsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchTeams]);

  // Agent <-> team membership now lives in wacrm.team_members (a
  // many-to-many join, migration 062) instead of the scalar
  // profiles.team_id. There's no consolidated "all teams' members"
  // endpoint, so fetch each team's roster individually and merge into
  // one { teamId: userId[] } map — same "no realtime, refetch on
  // save" treatment as `teams` itself, since membership changes are
  // rare and go through the drag-and-drop handler below anyway.
  const [teamMembersMap, setTeamMembersMap] = useState<Record<string, string[]>>({});
  const [teamMembersLoading, setTeamMembersLoading] = useState(true);

  const fetchTeamMembers = useCallback(async (teamList: Team[]) => {
    if (teamList.length === 0) {
      setTeamMembersMap({});
      setTeamMembersLoading(false);
      return;
    }
    setTeamMembersLoading(true);
    try {
      const entries = await Promise.all(
        teamList.map(async (team) => {
          try {
            const res = await fetch(`/api/account/teams/${team.id}/members`, {
              cache: "no-store",
            });
            if (!res.ok) return [team.id, [] as string[]] as const;
            const data = (await res.json()) as { userIds?: string[] };
            return [team.id, data.userIds ?? []] as const;
          } catch (err) {
            console.error(`[monitoramento] failed to load members of team ${team.id}:`, err);
            return [team.id, [] as string[]] as const;
          }
        }),
      );
      setTeamMembersMap(Object.fromEntries(entries));
    } finally {
      setTeamMembersLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchTeamMembers(teams);
  }, [teams, fetchTeamMembers]);

  const byTeam = useMemo(
    () => groupConversationsByTeam(filteredConversations),
    [filteredConversations],
  );
  const byTeamAgents = useMemo(
    () => groupMembersByTeam(members, teamMembersMap),
    [members, teamMembersMap],
  );

  // Name resolvers shared by every ConversationCardActions bundle below —
  // the card/column components only know ids, these turn them into the
  // labels the badges display, using the already-loaded teams/members
  // state (no extra fetch).
  const getTeamName = useCallback(
    (teamId: string | null) => (teamId ? teams.find((t) => t.id === teamId)?.name ?? null : null),
    [teams],
  );
  const getAgentName = useCallback(
    (agentId: string | null) =>
      agentId ? members.find((m) => m.user_id === agentId)?.full_name ?? null : null,
    [members],
  );

  // ----------------------------------------------------------
  // Card selection + ⋮ menu actions ("Transferir para" / "Finalizar").
  // Selection state is per-tab (three independent Sets), matching the
  // ask that selecting cards in one tab shouldn't affect another.
  // Transfer/finalize share one dialog instance each across all three
  // tabs — only one card menu can be open at a time anyway.
  // ----------------------------------------------------------
  const fasesSelection = useSelection();
  const agentesSelection = useSelection();
  const equipesSelection = useSelection();

  const [transferTarget, setTransferTarget] = useState<MonitorConversation | null>(null);
  const [finalizeTarget, setFinalizeTarget] = useState<MonitorConversation | null>(null);
  const [outcomePickerOpen, setOutcomePickerOpen] = useState(false);

  const handleFinalizeClick = useCallback((conversation: MonitorConversation) => {
    setFinalizeTarget(conversation);
    setOutcomePickerOpen(true);
  }, []);

  const handleOutcomeTagSelect = useCallback(
    async (tag: Tag) => {
      if (!finalizeTarget) return;
      const db = createClient();
      const { error } = await closeConversationWithOutcomeTag(db, finalizeTarget.id, tag);
      if (error) {
        console.error("[monitoramento] failed to close conversation:", error);
        toast.error("Falha ao finalizar atendimento");
        return;
      }
      toast.success("Atendimento finalizado");
      setOutcomePickerOpen(false);
      setFinalizeTarget(null);
    },
    [finalizeTarget],
  );

  // "Ver histórico" opens ContactTimeline in a modal overlaying the
  // board instead of navigating to /historico — the supervisor never
  // loses their place on Monitoramento (Fortics' "Linha do tempo").
  const [timelineModal, setTimelineModal] = useState<{
    open: boolean;
    contactId: string;
    contactName: string;
  } | null>(null);

  const handleHistoryClick = useCallback((conversation: MonitorConversation) => {
    const contact = conversation.contact;
    const contactName = contact?.name?.trim() || contact?.phone || "Desconhecido";
    setTimelineModal({ open: true, contactId: conversation.contact_id, contactName });
  }, []);

  function makeCardActions(selection: typeof fasesSelection): ConversationCardActions {
    return {
      selectedIds: selection.selected,
      onToggleSelect: selection.toggle,
      onToggleSelectAll: selection.setMany,
      onTransferClick: setTransferTarget,
      onFinalizeClick: handleFinalizeClick,
      onHistoryClick: handleHistoryClick,
      getTeamName,
      getAgentName,
    };
  }

  const fasesActions = makeCardActions(fasesSelection);
  const agentesActions = makeCardActions(agentesSelection);
  const equipesActions = makeCardActions(equipesSelection);

  // ----------------------------------------------------------
  // Drag-and-drop agent ↔ team assignment. Same DndContext shape as
  // pipeline-board.tsx (useDraggable/useDroppable from @dnd-kit/core,
  // not the sortable package — this is "move between zones", not
  // "reorder a list", exactly like moving a deal between stages).
  //
  // The write goes through wacrm.team_members now (migration 062) via
  // POST/DELETE /api/account/teams/[teamId]/members instead of the
  // old (broken — the route silently ignored `team_id`) PATCH
  // /api/account/members/[userId] call. Optimistic update + manual
  // revert-on-failure still mirrors handleRoleChange in
  // members-tab.tsx.
  //
  // dnd-kit's draggable id is just the agent's user_id (AgentDragCard
  // doesn't encode a source team), so "which team is this drag coming
  // FROM" still falls back to the legacy `agent.team_id` scalar as a
  // best-effort hint — it's no longer written anywhere, but
  // /api/account/members still returns whatever value profiles.team_id
  // last held, and this handler keeps it updated locally after each
  // successful move so the next drag's source is inferred correctly
  // within the session. A true agent-in-2-teams scenario would need
  // AgentDragCard to carry its column's team id to disambiguate the
  // source precisely — out of scope here (not touching that file).
  // ----------------------------------------------------------
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);

  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  const handleAgentTeamChange = useCallback(
    async (agent: AccountMember, oldTeamId: string | null, nextTeamId: string | null) => {
      if (oldTeamId === nextTeamId) return;

      // Optimistic: patch the team_members map (drives byTeamAgents)
      // and the legacy team_id hint used to infer the next drag's
      // source team.
      setTeamMembersMap((prev) => {
        const next = { ...prev };
        if (oldTeamId) {
          next[oldTeamId] = (next[oldTeamId] ?? []).filter((id) => id !== agent.user_id);
        }
        if (nextTeamId) {
          next[nextTeamId] = [...(next[nextTeamId] ?? []), agent.user_id];
        }
        return next;
      });
      setMembers((prev) =>
        prev.map((m) => (m.user_id === agent.user_id ? { ...m, team_id: nextTeamId } : m)),
      );

      const revert = () => {
        setTeamMembersMap((prev) => {
          const next = { ...prev };
          if (oldTeamId) {
            next[oldTeamId] = [...(next[oldTeamId] ?? []), agent.user_id];
          }
          if (nextTeamId) {
            next[nextTeamId] = (next[nextTeamId] ?? []).filter((id) => id !== agent.user_id);
          }
          return next;
        });
        setMembers((prev) =>
          prev.map((m) => (m.user_id === agent.user_id ? { ...m, team_id: oldTeamId } : m)),
        );
      };

      try {
        if (oldTeamId) {
          const res = await fetch(`/api/account/teams/${oldTeamId}/members`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId: agent.user_id }),
          });
          if (!res.ok) {
            const payload = await res.json().catch(() => ({}));
            throw new Error(payload.error || "Failed to remove agent from previous team");
          }
        }
        if (nextTeamId) {
          const res = await fetch(`/api/account/teams/${nextTeamId}/members`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId: agent.user_id }),
          });
          if (!res.ok) {
            const payload = await res.json().catch(() => ({}));
            throw new Error(payload.error || "Failed to add agent to team");
          }
        }
        const teamName = nextTeamId ? teams.find((t) => t.id === nextTeamId)?.name : null;
        toast.success(
          nextTeamId
            ? `Moved ${agent.full_name || "agent"} to ${teamName ?? "team"}`
            : `Removed ${agent.full_name || "agent"} from team`,
        );
      } catch (err) {
        revert();
        console.error("[monitoramento] agent team change error:", err);
        toast.error(err instanceof Error ? err.message : "Could not reach the server");
      }
    },
    [teams],
  );

  const handleAgentDragStart = useCallback((event: DragStartEvent) => {
    setActiveAgentId(String(event.active.id));
  }, []);

  const handleAgentDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveAgentId(null);
      const { active, over } = event;
      if (!over) return;
      const userId = String(active.id);
      const targetTeamId = String(over.id);
      const agent = members.find((m) => m.user_id === userId);
      if (!agent || agent.team_id === targetTeamId) return;
      void handleAgentTeamChange(agent, agent.team_id ?? null, targetTeamId);
    },
    [members, handleAgentTeamChange],
  );

  const handleAgentDragCancel = useCallback(() => {
    setActiveAgentId(null);
  }, []);

  const activeAgent = activeAgentId
    ? members.find((m) => m.user_id === activeAgentId) ?? null
    : null;

  const agentOptions: MultiSelectOption[] = useMemo(
    () => members.map((m) => ({ id: m.user_id, label: m.full_name || m.email || "Sem nome" })),
    [members],
  );
  const teamOptions: MultiSelectOption[] = useMemo(
    () => teams.map((t) => ({ id: t.id, label: t.name })),
    [teams],
  );
  const channelOptions: MultiSelectOption[] = useMemo(
    () => channels.map((c) => ({ id: c.waha_session, label: c.waha_session })),
    [channels],
  );
  const tagOptions: MultiSelectOption[] = useMemo(
    () => contactTags.map((t) => ({ id: t.id, label: t.name, swatch: t.color })),
    [contactTags],
  );

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Monitoramento</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Painel operacional ao vivo — conversas abertas por fase de atendimento.
        </p>
      </div>

      <MonitorFiltersPanel
        agentOptions={agentOptions}
        teamOptions={teamOptions}
        channelOptions={channelOptions}
        tagOptions={tagOptions}
        filters={appliedFilters}
        onApply={setAppliedFilters}
        onClear={() => setAppliedFilters(EMPTY_FILTERS)}
      />

      <Tabs defaultValue="fases" className="space-y-5">
        <TabsList>
          <TabsTrigger
            value="fases"
            className="data-active:bg-muted data-active:text-primary text-muted-foreground"
          >
            Fases
          </TabsTrigger>
          <TabsTrigger
            value="agentes"
            className="data-active:bg-muted data-active:text-primary text-muted-foreground"
          >
            Agentes
          </TabsTrigger>
          <TabsTrigger
            value="equipes"
            className="data-active:bg-muted data-active:text-primary text-muted-foreground"
          >
            Equipes
          </TabsTrigger>
        </TabsList>

        <TabsContent value="fases" className="space-y-5">
          <MonitorKpiRow
            total={filteredConversations.length}
            navegando={grouped.navegando.length}
            espera={grouped.espera.length}
            atendimento={grouped.atendimento.length}
            loading={loading}
          />

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            {PHASE_ORDER.map((phase) => (
              <PhaseColumn
                key={phase}
                phase={phase}
                conversations={grouped[phase]}
                loading={loading}
                actions={fasesActions}
              />
            ))}
          </div>
        </TabsContent>

        <TabsContent value="agentes">
          {membersLoading ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-64 animate-pulse rounded-xl border border-border bg-card" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              {sortedAgents.map((agent) => (
                <AgentColumn
                  key={agent.user_id}
                  agent={agent}
                  presence={getPresence(agent.user_id)}
                  lastSeenAt={getRow(agent.user_id)?.last_seen_at}
                  now={now}
                  conversations={byAgent.get(agent.user_id) ?? []}
                  actions={agentesActions}
                />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="equipes" className="space-y-4">
          {teamsLoading || membersLoading || teamMembersLoading ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-64 animate-pulse rounded-xl border border-border bg-card" />
              ))}
            </div>
          ) : teams.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card/40 p-10 text-center text-sm text-muted-foreground">
              <p>Nenhuma equipe criada ainda.</p>
              <RequireRole
                min="admin"
                fallback={<p>Peça a um admin para criar equipes em Configurações → Equipes.</p>}
              >
                <Button onClick={openCreateTeam}>
                  <Plus className="size-4" />
                  Criar primeira equipe
                </Button>
              </RequireRole>
            </div>
          ) : (
            <>
              <RequireRole min="admin">
                <div className="flex justify-end">
                  <Button variant="outline" onClick={openCreateTeam}>
                    <Plus className="size-4" />
                    Nova equipe
                  </Button>
                </div>
              </RequireRole>

              <DndContext
                sensors={dndSensors}
                onDragStart={handleAgentDragStart}
                onDragEnd={handleAgentDragEnd}
                onDragCancel={handleAgentDragCancel}
              >
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                  {teams.map((team) => (
                    <TeamColumn
                      key={team.id}
                      team={team}
                      overflowTeamName={
                        teams.find((t) => t.id === team.overflow_team_id)?.name ?? null
                      }
                      agents={byTeamAgents.get(team.id) ?? []}
                      conversations={byTeam.get(team.id) ?? []}
                      getPresence={getPresence}
                      getLastSeenAt={(userId) => getRow(userId)?.last_seen_at}
                      now={now}
                      canDrag={canManageMembers}
                      onEdit={openEditTeam}
                      actions={equipesActions}
                    />
                  ))}
                </div>

                <DragOverlay
                  dropAnimation={{ duration: 200, easing: "cubic-bezier(0.2, 0, 0, 1)" }}
                >
                  {activeAgent ? (
                    <div className="opacity-90">
                      <AgentDragCard
                        agent={activeAgent}
                        presence={getPresence(activeAgent.user_id)}
                        lastSeenAt={getRow(activeAgent.user_id)?.last_seen_at}
                        now={now}
                        draggable={false}
                      />
                    </div>
                  ) : null}
                </DragOverlay>
              </DndContext>
            </>
          )}

          <TeamFormDialog
            open={teamDialogOpen}
            onOpenChange={setTeamDialogOpen}
            team={editingTeam}
            teams={teams}
            accountId={accountId}
            onSaved={fetchTeams}
          />
        </TabsContent>
      </Tabs>

      {/* Shared across all three tabs — one dialog instance, opened from
          whichever card's ⋮ menu triggered it. Success is reflected back
          into `conversations` via the existing realtime subscription
          (the UPDATE these actions issue fires the same postgres_changes
          event as any other conversations write), so no manual Map patch
          is needed here. */}
      <TransferDialog
        conversation={transferTarget}
        onOpenChange={(open) => {
          if (!open) setTransferTarget(null);
        }}
        agentOptions={agentOptions}
        teamOptions={teamOptions}
      />

      {/* Non-negotiable: closing a conversation always goes through this
          picker first — there is no path here that sets status="closed"
          without a chosen outcome tag. */}
      <OutcomeTagPicker
        open={outcomePickerOpen}
        onOpenChange={(open) => {
          setOutcomePickerOpen(open);
          if (!open) setFinalizeTarget(null);
        }}
        onSelect={handleOutcomeTagSelect}
      />

      {timelineModal && (
        <ContactTimelineModal
          open={timelineModal.open}
          onClose={() => setTimelineModal(null)}
          contactId={timelineModal.contactId}
          contactName={timelineModal.contactName}
        />
      )}
    </div>
  );
}
