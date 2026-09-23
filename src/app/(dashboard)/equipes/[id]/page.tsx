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
// ============================================================

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, Loader2, MessageCircle, Pencil, Search, X } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { apiFetch } from "@/lib/api-fetch";
import { normalizeForSearch } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { ROLE_META } from "@/components/settings/role-meta";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AccountMember, Team } from "@/types";

const NO_OVERFLOW = "__none__";

interface LinkedChannel {
  id: string;
  provider: "meta" | "waha";
  display_phone_number: string | null;
  habilitado: boolean;
}

function channelEnabledBadge(habilitado: boolean): { label: string; className: string } {
  return habilitado
    ? { label: "Habilitado", className: "bg-[#DCFCE7] text-[#14532D]" }
    : { label: "Desabilitado", className: "bg-muted text-muted-foreground" };
}

export default function EquipeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const supabase = createClient();
  const { accountId } = useAuth();

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

  // ---- members — same state/logic shape as TeamFormDialog ----
  const [allAccountMembers, setAllAccountMembers] = useState<AccountMember[]>([]);
  const [agents, setAgents] = useState<AccountMember[]>([]);
  const [memberUserIds, setMemberUserIds] = useState<Set<string>>(new Set());
  const [membersLoading, setMembersLoading] = useState(true);
  const [pendingMemberId, setPendingMemberId] = useState<string | null>(null);
  const [memberSearch, setMemberSearch] = useState("");

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

  // Members — mirrors TeamFormDialog's own fetch effect (fetch.ts's
  // /api/account/members for the roster, apiFetch's per-team members
  // route for current membership).
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
          setAgents((data.members ?? []).filter((m) => m.role === "agent"));
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

  const currentMembers = allAccountMembers.filter((m) => memberUserIds.has(m.user_id));

  const normalizedSearch = normalizeForSearch(memberSearch.trim());
  const availableAgents = agents
    .filter((a) => !memberUserIds.has(a.user_id))
    .filter((a) => {
      if (!normalizedSearch) return true;
      const haystack = normalizeForSearch(`${a.full_name} ${a.email ?? ""}`);
      return haystack.includes(normalizedSearch);
    });

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

      {/* Membros */}
      <Card>
        <CardContent className="space-y-4 pt-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Membros</h2>
            <p className="text-xs text-muted-foreground">
              {currentMembers.length} membro{currentMembers.length === 1 ? "" : "s"}
            </p>
          </div>

          {membersLoading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : currentMembers.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nenhum membro nesta equipe ainda.</p>
          ) : (
            <div className="space-y-0.5 rounded-lg border border-border p-1.5">
              {currentMembers.map((member) => {
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
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {roleMeta.label}
                    </span>
                    {isPending ? (
                      <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => handleToggleMember(member.user_id, false)}
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
            <Label>Adicionar membro</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={memberSearch}
                onChange={(e) => setMemberSearch(e.target.value)}
                placeholder="Buscar por nome ou e-mail..."
                className="pl-8"
                disabled={agents.length === 0}
              />
            </div>
            {agents.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nenhum operador na conta ainda.</p>
            ) : availableAgents.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {memberSearch.trim()
                  ? "Nenhum operador encontrado para essa busca."
                  : "Todos os operadores já estão nesta equipe."}
              </p>
            ) : (
              <div className="max-h-48 space-y-0.5 overflow-y-auto rounded-lg border border-border p-1.5">
                {availableAgents.map((agent) => {
                  const isPending = pendingMemberId === agent.user_id;
                  const displayName = agent.full_name || agent.email || "Sem nome";
                  const roleMeta = ROLE_META[agent.role];
                  return (
                    <button
                      type="button"
                      key={agent.user_id}
                      disabled={isPending}
                      onClick={() => handleToggleMember(agent.user_id, true)}
                      className="flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Avatar className="size-6 shrink-0">
                        {agent.avatar_url ? (
                          <AvatarImage src={agent.avatar_url} alt={displayName} />
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

      {/* Canais vinculados */}
      <Card>
        <CardContent className="space-y-3 pt-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Canais vinculados</h2>
            <Link href="/canais" className="text-xs text-primary hover:underline">
              Gerenciar canais
            </Link>
          </div>
          {channels.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nenhum canal vinculado a esta equipe.</p>
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
    </div>
  );
}
