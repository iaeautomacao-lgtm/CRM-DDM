"use client";

// ============================================================
// /equipes/[id] — team detail page.
//
// Data fetching: direct Supabase client (RLS from migrations 049/062
// already scopes teams/team_members to account members) — same
// pattern as TeamsPanel. Member add/remove reuses TeamFormDialog's
// exact logic (search+filter, optimistic toggle against
// /api/account/teams/[teamId]/members), adapted from a dialog section
// into an inline page section since this page has room for it.
//
// Visão Geral / Tabulações / Templates are tabs (Tabs, uncontrolled
// defaultValue — same pattern as monitoramento/page.tsx) — Visão Geral
// is everything the page already had before this became a 3-tab
// layout; Tabulações (migration 105: tags.team_id) and Templates
// (migration 106: team_allowed_templates) are new.
// ============================================================

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowLeft,
  Info,
  Loader2,
  MessageCircle,
  Pencil,
  Plus,
  Search,
  X,
} from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { apiFetch } from "@/lib/api-fetch";
import { normalizeForSearch } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { ROLE_META } from "@/components/settings/role-meta";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { AccountMember, MessageTemplate, Tag, Team } from "@/types";

const NO_OVERFLOW = "__none__";

// Same 8-color palette tag-manager.tsx offers for contact tags,
// trimmed to the 6 requested — reusing the exact hex values so a
// tabulação color never clashes visually with an existing contact tag.
const TABULACAO_COLORS = [
  { name: "Red", value: "#ef4444" },
  { name: "Orange", value: "#f97316" },
  { name: "Amber", value: "#f59e0b" },
  { name: "Emerald", value: "#10b981" },
  { name: "Blue", value: "#3b82f6" },
  { name: "Violet", value: "#8b5cf6" },
];

interface LinkedChannel {
  id: string;
  provider: "meta" | "waha";
  display_phone_number: string | null;
  habilitado: boolean;
}

interface UnlinkedChannel {
  id: string;
  provider: "meta" | "waha";
  display_phone_number: string | null;
}

function channelEnabledBadge(habilitado: boolean): { label: string; className: string } {
  return habilitado
    ? { label: "Habilitado", className: "bg-[#DCFCE7] text-[#14532D]" }
    : { label: "Desabilitado", className: "bg-muted text-muted-foreground" };
}

// ----------------------------------------------------------
// Supervisores / Operadores share every bit of add/remove logic — only
// the role filter and copy differ. Local (not a new file): the two
// call sites live in the exact same page and nowhere else needs this.
// ----------------------------------------------------------
function MemberRoleSection({
  title,
  roleLabelSingular,
  roleLabelPlural,
  currentList,
  pool,
  search,
  onSearchChange,
  pendingMemberId,
  onToggle,
}: {
  title: string;
  roleLabelSingular: string;
  roleLabelPlural: string;
  currentList: AccountMember[];
  /** Role-filtered, not-yet-in-this-team candidates — not search-filtered yet. */
  pool: AccountMember[];
  search: string;
  onSearchChange: (v: string) => void;
  pendingMemberId: string | null;
  onToggle: (userId: string, checked: boolean) => void;
}) {
  const normalizedSearch = normalizeForSearch(search.trim());
  const filteredPool = pool.filter((a) => {
    if (!normalizedSearch) return true;
    const haystack = normalizeForSearch(`${a.full_name} ${a.email ?? ""}`);
    return haystack.includes(normalizedSearch);
  });

  return (
    <Card>
      <CardContent className="space-y-4 pt-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          <p className="text-xs text-muted-foreground">
            {currentList.length} {currentList.length === 1 ? roleLabelSingular : roleLabelPlural}
          </p>
        </div>

        {currentList.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Nenhum {roleLabelSingular} nesta equipe ainda.
          </p>
        ) : (
          <div className="space-y-0.5 rounded-lg border border-border p-1.5">
            {currentList.map((member) => {
              const isPending = pendingMemberId === member.user_id;
              const displayName = member.full_name || member.email || "Sem nome";
              const roleMeta = ROLE_META[member.role];
              return (
                <div
                  key={member.user_id}
                  className="flex items-center gap-2.5 rounded-md px-2 py-1.5"
                >
                  <Avatar className="size-7 shrink-0">
                    {member.avatar_url ? (
                      <AvatarImage src={member.avatar_url} alt={displayName} />
                    ) : null}
                    <AvatarFallback className="bg-primary/10 text-xs font-medium text-primary">
                      {displayName.charAt(0).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {displayName}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">{roleMeta.label}</span>
                  {isPending ? (
                    <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => onToggle(member.user_id, false)}
                      title="Remover da equipe"
                      aria-label="Remover da equipe"
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                    >
                      <X className="size-3.5" />
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="space-y-2">
          <Label>Adicionar {roleLabelSingular}</Label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Buscar por nome ou e-mail..."
              className="pl-8"
              disabled={pool.length === 0}
            />
          </div>
          {pool.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Nenhum {roleLabelSingular} na conta ainda.
            </p>
          ) : filteredPool.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {search.trim()
                ? `Nenhum ${roleLabelSingular} encontrado para essa busca.`
                : `Todos os ${roleLabelPlural} já estão nesta equipe.`}
            </p>
          ) : (
            <div className="max-h-48 space-y-0.5 overflow-y-auto rounded-lg border border-border p-1.5">
              {filteredPool.map((member) => {
                const isPending = pendingMemberId === member.user_id;
                const displayName = member.full_name || member.email || "Sem nome";
                const roleMeta = ROLE_META[member.role];
                return (
                  <button
                    type="button"
                    key={member.user_id}
                    disabled={isPending}
                    onClick={() => onToggle(member.user_id, true)}
                    className="flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Avatar className="size-6 shrink-0">
                      {member.avatar_url ? (
                        <AvatarImage src={member.avatar_url} alt={displayName} />
                      ) : null}
                      <AvatarFallback className="bg-primary/10 text-[10px] font-medium text-primary">
                        {displayName.charAt(0).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                      {displayName}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {roleMeta.label}
                    </span>
                    {isPending && (
                      <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default function EquipeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const supabase = createClient();
  const { user, accountId } = useAuth();

  const [loading, setLoading] = useState(true);
  const [team, setTeam] = useState<Team | null>(null);
  const [otherTeams, setOtherTeams] = useState<Team[]>([]);
  const [channels, setChannels] = useState<LinkedChannel[]>([]);

  // ---- name (click-to-edit, same pattern as contact-sidebar.tsx) ----
  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName] = useState("");

  // ---- info (session timeout / overflow team) ----
  const [sessionTimeout, setSessionTimeout] = useState("");
  const [overflowTeamId, setOverflowTeamId] = useState(NO_OVERFLOW);
  const [savingInfo, setSavingInfo] = useState(false);

  // ---- members — same state/logic shape as TeamFormDialog, now split
  // by role (agent -> Operadores, admin -> Supervisores) ----
  const [allAccountMembers, setAllAccountMembers] = useState<AccountMember[]>([]);
  const [memberUserIds, setMemberUserIds] = useState<Set<string>>(new Set());
  const [membersLoading, setMembersLoading] = useState(true);
  const [pendingMemberId, setPendingMemberId] = useState<string | null>(null);
  const [operatorSearch, setOperatorSearch] = useState("");
  const [supervisorSearch, setSupervisorSearch] = useState("");

  // ---- add channel modal ----
  const [addChannelOpen, setAddChannelOpen] = useState(false);
  const [unlinkedChannels, setUnlinkedChannels] = useState<UnlinkedChannel[]>([]);
  const [unlinkedChannelsLoading, setUnlinkedChannelsLoading] = useState(false);
  const [selectedChannelToAdd, setSelectedChannelToAdd] = useState("");
  const [addingChannel, setAddingChannel] = useState(false);

  // ---- Tabulações ----
  const [tabulacoes, setTabulacoes] = useState<Tag[]>([]);
  const [tabulacoesLoading, setTabulacoesLoading] = useState(true);
  const [newTabulacaoName, setNewTabulacaoName] = useState("");
  const [newTabulacaoColor, setNewTabulacaoColor] = useState(TABULACAO_COLORS[0].value);
  const [creatingTabulacao, setCreatingTabulacao] = useState(false);
  const [deletingTabulacaoId, setDeletingTabulacaoId] = useState<string | null>(null);

  // ---- Templates permitidos ----
  const [approvedTemplates, setApprovedTemplates] = useState<MessageTemplate[]>([]);
  const [allowedTemplateIds, setAllowedTemplateIds] = useState<Set<string>>(new Set());
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [pendingTemplateId, setPendingTemplateId] = useState<string | null>(null);

  const fetchTeam = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      const [teamRes, allTeamsRes, channelsRes] = await Promise.all([
        supabase.from("teams").select("*").eq("id", id).eq("account_id", accountId).maybeSingle(),
        supabase
          .from("teams")
          .select("*")
          .eq("account_id", accountId)
          .order("name", { ascending: true }),
        supabase
          .from("whatsapp_config")
          .select("id, provider, display_phone_number, habilitado")
          .eq("team_id", id)
          .order("display_phone_number", { ascending: true }),
      ]);
      if (teamRes.error) throw teamRes.error;
      if (!teamRes.data) {
        toast.error("Equipe não encontrada");
        router.push("/equipes");
        return;
      }
      const row = teamRes.data as Team;
      setTeam(row);
      setEditName(row.name);
      setSessionTimeout(
        row.session_timeout_minutes != null ? String(row.session_timeout_minutes) : "",
      );
      setOverflowTeamId(row.overflow_team_id ?? NO_OVERFLOW);
      setOtherTeams(((allTeamsRes.data ?? []) as Team[]).filter((t) => t.id !== id));
      if (!channelsRes.error) {
        setChannels((channelsRes.data ?? []) as LinkedChannel[]);
      }
    } catch (err) {
      console.error("[EquipeDetail] fetch error:", err);
      toast.error("Falha ao carregar equipe");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, id]);

  useEffect(() => {
    void fetchTeam();
  }, [fetchTeam]);

  // Members — mirrors TeamFormDialog's own fetch effect (fetch()'s
  // /api/account/members for the roster, apiFetch's per-team members
  // route for current membership). allAccountMembers is unfiltered —
  // MemberRoleSection's `pool` props are derived below per role.
  useEffect(() => {
    let cancelled = false;
    setMembersLoading(true);
    (async () => {
      try {
        const [membersRes, teamMembersRes] = await Promise.all([
          fetch("/api/account/members", { cache: "no-store" }),
          apiFetch(`/api/account/teams/${id}/members`, { cache: "no-store" }),
        ]);
        if (cancelled) return;

        if (membersRes.ok) {
          const data = (await membersRes.json()) as { members?: AccountMember[] };
          setAllAccountMembers(data.members ?? []);
        } else {
          toast.error("Falha ao carregar membros da conta");
        }

        if (teamMembersRes.ok) {
          const data = (await teamMembersRes.json()) as { userIds?: string[] };
          setMemberUserIds(new Set(data.userIds ?? []));
        } else {
          toast.error("Falha ao carregar membros da equipe");
        }
      } catch (err) {
        if (!cancelled) {
          console.error("[EquipeDetail] members fetch error:", err);
          toast.error("Não foi possível conectar ao servidor");
        }
      } finally {
        if (!cancelled) setMembersLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Tabulações — kind='outcome' tags scoped to this team OR global
  // (team_id IS NULL, read-only here).
  const fetchTabulacoes = useCallback(async () => {
    if (!accountId) return;
    setTabulacoesLoading(true);
    try {
      const { data, error } = await supabase
        .from("tags")
        .select("*")
        .eq("account_id", accountId)
        .eq("kind", "outcome")
        .or(`team_id.eq.${id},team_id.is.null`)
        .order("name", { ascending: true });
      if (error) throw error;
      setTabulacoes((data ?? []) as Tag[]);
    } catch (err) {
      console.error("[EquipeDetail] tabulacoes fetch error:", err);
      toast.error("Falha ao carregar tabulações");
    } finally {
      setTabulacoesLoading(false);
    }
  }, [accountId, id, supabase]);

  useEffect(() => {
    void fetchTabulacoes();
  }, [fetchTabulacoes]);

  // Templates permitidos — every APPROVED template in the account,
  // plus which ones already have a team_allowed_templates row for
  // this team.
  const fetchTemplatesData = useCallback(async () => {
    if (!accountId) return;
    setTemplatesLoading(true);
    try {
      const [templatesRes, allowedRes] = await Promise.all([
        supabase
          .from("message_templates")
          .select("*")
          .eq("account_id", accountId)
          .eq("status", "APPROVED")
          .order("name", { ascending: true }),
        supabase.from("team_allowed_templates").select("template_id").eq("team_id", id),
      ]);
      if (templatesRes.error) throw templatesRes.error;
      setApprovedTemplates((templatesRes.data ?? []) as MessageTemplate[]);
      if (!allowedRes.error) {
        setAllowedTemplateIds(
          new Set((allowedRes.data ?? []).map((r) => r.template_id as string)),
        );
      }
    } catch (err) {
      console.error("[EquipeDetail] templates fetch error:", err);
      toast.error("Falha ao carregar templates");
    } finally {
      setTemplatesLoading(false);
    }
  }, [accountId, id, supabase]);

  useEffect(() => {
    void fetchTemplatesData();
  }, [fetchTemplatesData]);

  // Unlinked channels — fetched fresh each time the "Adicionar canal"
  // modal opens, so a channel someone else just freed up elsewhere
  // shows up without a full page reload.
  useEffect(() => {
    if (!addChannelOpen || !accountId) return;
    let cancelled = false;
    setUnlinkedChannelsLoading(true);
    (async () => {
      const { data, error } = await supabase
        .from("whatsapp_config")
        .select("id, provider, display_phone_number")
        .eq("account_id", accountId)
        .is("team_id", null)
        .order("display_phone_number", { ascending: true });
      if (cancelled) return;
      if (error) {
        console.error("[EquipeDetail] unlinked channels fetch error:", error);
        toast.error("Falha ao carregar canais disponíveis");
      } else {
        setUnlinkedChannels((data ?? []) as UnlinkedChannel[]);
      }
      setUnlinkedChannelsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [addChannelOpen, accountId, supabase]);

  const currentMembers = allAccountMembers.filter((m) => memberUserIds.has(m.user_id));
  const currentOperators = currentMembers.filter((m) => m.role === "agent");
  const currentSupervisors = currentMembers.filter((m) => m.role === "admin");
  const operatorPool = allAccountMembers.filter(
    (m) => m.role === "agent" && !memberUserIds.has(m.user_id),
  );
  const supervisorPool = allAccountMembers.filter(
    (m) => m.role === "admin" && !memberUserIds.has(m.user_id),
  );

  async function handleToggleMember(userId: string, checked: boolean) {
    setPendingMemberId(userId);
    setMemberUserIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(userId);
      else next.delete(userId);
      return next;
    });
    try {
      const res = await apiFetch(`/api/account/teams/${id}/members`, {
        method: checked ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || "Falha ao atualizar membro da equipe");
      }
    } catch (err) {
      setMemberUserIds((prev) => {
        const next = new Set(prev);
        if (checked) next.delete(userId);
        else next.add(userId);
        return next;
      });
      console.error("[EquipeDetail] toggle member error:", err);
      toast.error(err instanceof Error ? err.message : "Falha ao atualizar membro da equipe");
    } finally {
      setPendingMemberId(null);
    }
  }

  async function handleSaveName() {
    const trimmed = editName.trim();
    if (!team) return;
    if (!trimmed || trimmed === team.name) {
      setIsEditingName(false);
      setEditName(team.name);
      return;
    }
    try {
      const { error } = await supabase.from("teams").update({ name: trimmed }).eq("id", team.id);
      if (error) throw error;
      setTeam({ ...team, name: trimmed });
      setIsEditingName(false);
      toast.success("Nome da equipe atualizado");
    } catch (err) {
      console.error("[EquipeDetail] rename error:", err);
      toast.error("Falha ao renomear equipe");
    }
  }

  async function handleSaveInfo() {
    if (!team) return;
    let sessionTimeoutMinutes: number | null = null;
    if (sessionTimeout.trim()) {
      const parsed = Number(sessionTimeout);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        toast.error("Tempo de sessão deve ser um número positivo de minutos");
        return;
      }
      sessionTimeoutMinutes = Math.floor(parsed);
    }
    const nextOverflowId = overflowTeamId === NO_OVERFLOW ? null : overflowTeamId;
    setSavingInfo(true);
    try {
      const { error } = await supabase
        .from("teams")
        .update({
          session_timeout_minutes: sessionTimeoutMinutes,
          overflow_team_id: nextOverflowId,
        })
        .eq("id", team.id);
      if (error) throw error;
      setTeam({
        ...team,
        session_timeout_minutes: sessionTimeoutMinutes,
        overflow_team_id: nextOverflowId,
      });
      toast.success("Informações da equipe atualizadas");
    } catch (err) {
      console.error("[EquipeDetail] info save error:", err);
      toast.error("Falha ao salvar informações");
    } finally {
      setSavingInfo(false);
    }
  }

  async function handleAddChannel() {
    if (!selectedChannelToAdd) return;
    setAddingChannel(true);
    try {
      const res = await apiFetch("/api/whatsapp/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: selectedChannelToAdd, team_id: id }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Falha ao vincular canal");
      }
      toast.success("Canal vinculado à equipe");
      setAddChannelOpen(false);
      setSelectedChannelToAdd("");
      await fetchTeam();
    } catch (err) {
      console.error("[EquipeDetail] add channel error:", err);
      toast.error(err instanceof Error ? err.message : "Falha ao vincular canal");
    } finally {
      setAddingChannel(false);
    }
  }

  async function handleCreateTabulacao() {
    const name = newTabulacaoName.trim();
    if (!name) {
      toast.error("Nome da tabulação é obrigatório");
      return;
    }
    if (!accountId || !user) return;
    setCreatingTabulacao(true);
    try {
      const { data, error } = await supabase
        .from("tags")
        .insert({
          account_id: accountId,
          user_id: user.id,
          name,
          color: newTabulacaoColor,
          kind: "outcome",
          team_id: id,
        })
        .select()
        .single();
      if (error) throw error;
      setTabulacoes((prev) =>
        [...prev, data as Tag].sort((a, b) => a.name.localeCompare(b.name)),
      );
      setNewTabulacaoName("");
      toast.success("Tabulação criada");
    } catch (err) {
      console.error("[EquipeDetail] create tabulacao error:", err);
      toast.error("Falha ao criar tabulação");
    } finally {
      setCreatingTabulacao(false);
    }
  }

  async function handleDeleteTabulacao(tagId: string) {
    setDeletingTabulacaoId(tagId);
    try {
      const { error } = await supabase.from("tags").delete().eq("id", tagId);
      if (error) throw error;
      setTabulacoes((prev) => prev.filter((t) => t.id !== tagId));
      toast.success("Tabulação removida");
    } catch (err) {
      console.error("[EquipeDetail] delete tabulacao error:", err);
      toast.error("Falha ao remover tabulação");
    } finally {
      setDeletingTabulacaoId(null);
    }
  }

  async function handleToggleAllowedTemplate(templateId: string, checked: boolean) {
    setPendingTemplateId(templateId);
    setAllowedTemplateIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(templateId);
      else next.delete(templateId);
      return next;
    });
    try {
      if (checked) {
        const { error } = await supabase
          .from("team_allowed_templates")
          .insert({ team_id: id, template_id: templateId });
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("team_allowed_templates")
          .delete()
          .eq("team_id", id)
          .eq("template_id", templateId);
        if (error) throw error;
      }
    } catch (err) {
      setAllowedTemplateIds((prev) => {
        const next = new Set(prev);
        if (checked) next.delete(templateId);
        else next.add(templateId);
        return next;
      });
      console.error("[EquipeDetail] toggle allowed template error:", err);
      toast.error("Falha ao atualizar template permitido");
    } finally {
      setPendingTemplateId(null);
    }
  }

  const infoChanged =
    !!team &&
    ((sessionTimeout.trim() ? Number(sessionTimeout) : null) !==
      (team.session_timeout_minutes ?? null) ||
      (overflowTeamId === NO_OVERFLOW ? null : overflowTeamId) !== (team.overflow_team_id ?? null));

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  if (!team) return null;

  return (
    <div className="space-y-6 p-4 lg:p-6">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => router.push("/equipes")}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="Voltar"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1">
          {isEditingName ? (
            <div className="flex items-center gap-1.5">
              <Input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={async (e) => {
                  if (e.key === "Enter") await handleSaveName();
                  else if (e.key === "Escape") {
                    setIsEditingName(false);
                    setEditName(team.name);
                  }
                }}
                autoFocus
                className="h-9 max-w-sm text-lg font-bold"
              />
              <Button size="sm" onClick={handleSaveName}>
                Salvar
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setIsEditingName(false);
                  setEditName(team.name);
                }}
              >
                Cancelar
              </Button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setIsEditingName(true)}
              className="group flex items-center gap-2 text-left"
              title="Clique para editar o nome"
            >
              <h1 className="text-2xl font-bold text-foreground">{team.name}</h1>
              <Pencil className="size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
          )}
          <p className="mt-0.5 text-sm text-muted-foreground">Detalhes da equipe</p>
        </div>
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Visão Geral</TabsTrigger>
          <TabsTrigger value="tabulacoes">Tabulações</TabsTrigger>
          <TabsTrigger value="templates">Templates</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          {membersLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              <MemberRoleSection
                title="Supervisores"
                roleLabelSingular="supervisor"
                roleLabelPlural="supervisores"
                currentList={currentSupervisors}
                pool={supervisorPool}
                search={supervisorSearch}
                onSearchChange={setSupervisorSearch}
                pendingMemberId={pendingMemberId}
                onToggle={handleToggleMember}
              />

              <MemberRoleSection
                title="Operadores"
                roleLabelSingular="operador"
                roleLabelPlural="operadores"
                currentList={currentOperators}
                pool={operatorPool}
                search={operatorSearch}
                onSearchChange={setOperatorSearch}
                pendingMemberId={pendingMemberId}
                onToggle={handleToggleMember}
              />
            </>
          )}

          {/* Canais vinculados */}
          <Card>
            <CardContent className="space-y-3 pt-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-foreground">Canais vinculados</h2>
                <div className="flex items-center gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setAddChannelOpen(true)}
                  >
                    <Plus className="size-3.5" />
                    Adicionar canal
                  </Button>
                  <Link href="/canais" className="text-xs text-primary hover:underline">
                    Gerenciar canais
                  </Link>
                </div>
              </div>
              {channels.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Nenhum canal vinculado a esta equipe.
                </p>
              ) : (
                <div className="space-y-0.5 rounded-lg border border-border p-1.5">
                  {channels.map((c) => {
                    const statusBadge = channelEnabledBadge(c.habilitado);
                    return (
                      <div key={c.id} className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
                        <MessageCircle className="size-4 shrink-0 text-[#25D366]" />
                        <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                          {c.display_phone_number || `Canal ${c.id.slice(0, 8)}`}
                        </span>
                        <Badge
                          className={
                            c.provider === "waha"
                              ? "border border-border bg-muted text-xs text-muted-foreground"
                              : "bg-[#14532D] text-xs text-white"
                          }
                        >
                          {c.provider === "waha" ? "WAHA" : "Meta"}
                        </Badge>
                        <Badge className={`text-xs ${statusBadge.className}`}>
                          {statusBadge.label}
                        </Badge>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Informações */}
          <Card>
            <CardContent className="space-y-4 pt-4">
              <h2 className="text-sm font-semibold text-foreground">Informações</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="team-session-timeout">
                    Tempo de sessão (minutos){" "}
                    <span className="text-xs text-muted-foreground">(opcional)</span>
                  </Label>
                  <Input
                    id="team-session-timeout"
                    type="number"
                    min={1}
                    value={sessionTimeout}
                    onChange={(e) => setSessionTimeout(e.target.value)}
                    placeholder="ex.: 30"
                  />
                </div>
                <div className="space-y-2">
                  <Label>
                    Equipe de transbordo{" "}
                    <span className="text-xs text-muted-foreground">(opcional)</span>
                  </Label>
                  <Select value={overflowTeamId} onValueChange={(v) => v && setOverflowTeamId(v)}>
                    <SelectTrigger className="w-full">
                      <SelectValue>
                        {(v: string) =>
                          v === NO_OVERFLOW
                            ? "Sem transbordo"
                            : (otherTeams.find((t) => t.id === v)?.name ?? v)
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent alignItemWithTrigger={false}>
                      <SelectItem value={NO_OVERFLOW}>Sem transbordo</SelectItem>
                      {otherTeams.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex justify-end">
                <Button onClick={handleSaveInfo} disabled={!infoChanged || savingInfo}>
                  {savingInfo ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      Salvando…
                    </>
                  ) : (
                    "Salvar informações"
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="tabulacoes" className="space-y-4">
          <Card>
            <CardContent className="space-y-4 pt-4">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Tabulações</h2>
                <p className="text-xs text-muted-foreground">
                  Tags de encerramento (kind=&quot;outcome&quot;) desta equipe, mais as globais da
                  conta.
                </p>
              </div>

              {tabulacoesLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                </div>
              ) : tabulacoes.length === 0 ? (
                <p className="text-xs text-muted-foreground">Nenhuma tabulação ainda.</p>
              ) : (
                <div className="space-y-0.5 rounded-lg border border-border p-1.5">
                  {tabulacoes.map((tab) => {
                    const isGlobal = !tab.team_id;
                    const isDeleting = deletingTabulacaoId === tab.id;
                    return (
                      <div key={tab.id} className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
                        <span
                          className="size-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: tab.color }}
                        />
                        <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                          {tab.name}
                        </span>
                        {isGlobal ? (
                          <Badge className="border border-border bg-muted text-xs text-muted-foreground">
                            Global
                          </Badge>
                        ) : isDeleting ? (
                          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                        ) : (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            onClick={() => handleDeleteTabulacao(tab.id)}
                            title="Remover tabulação"
                            aria-label="Remover tabulação"
                            className="shrink-0 text-muted-foreground hover:text-destructive"
                          >
                            <X className="size-3.5" />
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="space-y-2 border-t border-border pt-4">
                <Label>Nova tabulação</Label>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    value={newTabulacaoName}
                    onChange={(e) => setNewTabulacaoName(e.target.value)}
                    placeholder="Nome da tabulação"
                    className="max-w-xs"
                    disabled={creatingTabulacao}
                  />
                  <div className="flex items-center gap-1.5">
                    {TABULACAO_COLORS.map((color) => (
                      <button
                        key={color.value}
                        type="button"
                        onClick={() => setNewTabulacaoColor(color.value)}
                        aria-label={`Usar ${color.name}`}
                        aria-pressed={newTabulacaoColor === color.value}
                        className={`size-6 rounded-full border-2 transition-transform ${
                          newTabulacaoColor === color.value
                            ? "scale-110 border-foreground"
                            : "border-transparent"
                        }`}
                        style={{ backgroundColor: color.value }}
                        title={color.name}
                      />
                    ))}
                  </div>
                  <Button
                    type="button"
                    onClick={handleCreateTabulacao}
                    disabled={creatingTabulacao || !newTabulacaoName.trim()}
                  >
                    {creatingTabulacao ? (
                      <>
                        <Loader2 className="size-4 animate-spin" />
                        Criando…
                      </>
                    ) : (
                      <>
                        <Plus className="size-4" />
                        Adicionar
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="templates" className="space-y-4">
          <Card>
            <CardContent className="space-y-4 pt-4">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Templates permitidos</h2>
                <p className="text-xs text-muted-foreground">
                  Quais templates aprovados os operadores desta equipe podem usar.
                </p>
              </div>

              <div className="flex items-start gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                <Info className="size-3.5 mt-0.5 shrink-0" />
                <span>
                  Se nenhum template estiver marcado, todos os templates aprovados ficam
                  liberados para esta equipe (sem restrição).
                </span>
              </div>

              {templatesLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                </div>
              ) : approvedTemplates.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Nenhum template aprovado nesta conta ainda.
                </p>
              ) : (
                <div className="space-y-0.5 rounded-lg border border-border p-1.5">
                  {approvedTemplates.map((tpl) => {
                    const checked = allowedTemplateIds.has(tpl.id);
                    const isPending = pendingTemplateId === tpl.id;
                    return (
                      <label
                        key={tpl.id}
                        className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted"
                      >
                        <Checkbox
                          checked={checked}
                          disabled={isPending}
                          onCheckedChange={(next) =>
                            handleToggleAllowedTemplate(tpl.id, next === true)
                          }
                        />
                        <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                          {tpl.name}
                        </span>
                        {tpl.language && (
                          <span className="shrink-0 text-xs uppercase text-muted-foreground">
                            {tpl.language}
                          </span>
                        )}
                        {isPending && (
                          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                        )}
                      </label>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Adicionar canal */}
      <Dialog open={addChannelOpen} onOpenChange={setAddChannelOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Adicionar canal</DialogTitle>
            <DialogDescription>
              Só canais sem equipe aparecem aqui — vincule primeiro em outra equipe pra mudar.
            </DialogDescription>
          </DialogHeader>
          {unlinkedChannelsLoading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : unlinkedChannels.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Nenhum canal sem equipe disponível nesta conta.
            </p>
          ) : (
            <Select value={selectedChannelToAdd} onValueChange={(v) => v && setSelectedChannelToAdd(v)}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Selecione um canal">
                  {(v: string) => {
                    const c = unlinkedChannels.find((ch) => ch.id === v);
                    return c ? c.display_phone_number || `Canal ${c.id.slice(0, 8)}` : v;
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                {unlinkedChannels.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.display_phone_number || `Canal ${c.id.slice(0, 8)}`} ·{" "}
                    {c.provider === "waha" ? "WAHA" : "Meta"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAddChannelOpen(false)}
              disabled={addingChannel}
            >
              Cancelar
            </Button>
            <Button
              onClick={handleAddChannel}
              disabled={addingChannel || !selectedChannelToAdd}
            >
              {addingChannel ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Vinculando…
                </>
              ) : (
                "Vincular canal"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
