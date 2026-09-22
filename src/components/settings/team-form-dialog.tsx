'use client';

// ============================================================
// TeamFormDialog — create/edit form for a single team.
//
// Extracted out of teams-panel.tsx so the Monitoramento "Equipes" tab
// can offer the same "create a team" flow without a full navigation
// to Settings. Same fields, same validation, same direct-Supabase-
// client CRUD (RLS from migration 049 is the real gate — admin+ for
// INSERT/UPDATE) as before the extraction; behavior is unchanged.
//
// Controlled: the caller owns `open` and decides what `team` means
// (null = create, a Team = edit) and what `teams` to offer as
// overflow options. `onSaved` fires after a successful insert/update,
// before the dialog closes — callers use it to refetch their own list.
// ============================================================

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Search, X } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { apiFetch } from '@/lib/api-fetch';
import { normalizeForSearch } from '@/lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ROLE_META } from './role-meta';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { AccountMember, Team } from '@/types';

// Base UI's Select needs a real string value — there's no "no
// selection" affordance, so an explicit sentinel stands in for
// overflow_team_id = NULL and gets translated back at save time.
const NO_OVERFLOW = '__none__';

interface TeamFormState {
  name: string;
  /** Raw input text — parsed/validated on save, not on keystroke. */
  sessionTimeoutMinutes: string;
  overflowTeamId: string;
}

const EMPTY_FORM: TeamFormState = {
  name: '',
  sessionTimeoutMinutes: '',
  overflowTeamId: NO_OVERFLOW,
};

export interface TeamFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = create a new team; otherwise the team being edited. */
  team: Team | null;
  /** Full team list for the account — used to populate the overflow
   *  dropdown (the team being edited, if any, is excluded automatically). */
  teams: Team[];
  accountId: string | null;
  /** Called after a successful insert/update, before the dialog closes. */
  onSaved: () => void | Promise<void>;
}

export function TeamFormDialog({
  open,
  onOpenChange,
  team,
  teams,
  accountId,
  onSaved,
}: TeamFormDialogProps) {
  const supabase = createClient();
  const [form, setForm] = useState<TeamFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  // Re-seed whenever the dialog opens (create vs. edit) rather than on
  // every `team` identity change — avoids clobbering in-progress edits
  // if the parent's `team` prop ever changes while already open.
  useEffect(() => {
    if (!open) return;
    setForm(
      team
        ? {
            name: team.name,
            sessionTimeoutMinutes:
              team.session_timeout_minutes != null
                ? String(team.session_timeout_minutes)
                : '',
            overflowTeamId: team.overflow_team_id ?? NO_OVERFLOW,
          }
        : EMPTY_FORM,
    );
  }, [open, team]);

  // ----------------------------------------------------------
  // "Membros" section — edit mode only (a team needs a row in the DB
  // before agents can be linked to it, so create mode never shows
  // this). Loads the account's agents once + this team's current
  // wacrm.team_members roster, then every checkbox toggle is an
  // immediate POST/DELETE against /api/account/teams/[teamId]/members
  // — no separate "save members" step, mirroring the toggle-is-the-
  // save pattern already used for role changes in members-tab.tsx.
  // ----------------------------------------------------------
  // `agents` (role === 'agent') is the addable pool — unchanged from
  // before. `allAccountMembers` is the full, unfiltered roster, kept
  // separately so a current member whose role isn't 'agent' (added
  // through some other path — team_members has no role constraint of
  // its own) still resolves to a name/avatar/role instead of silently
  // disappearing from the "current members" list.
  const [agents, setAgents] = useState<AccountMember[]>([]);
  const [allAccountMembers, setAllAccountMembers] = useState<AccountMember[]>([]);
  const [memberUserIds, setMemberUserIds] = useState<Set<string>>(new Set());
  const [membersLoading, setMembersLoading] = useState(false);
  const [pendingMemberId, setPendingMemberId] = useState<string | null>(null);
  const [memberSearch, setMemberSearch] = useState('');

  useEffect(() => {
    if (!open || !team) {
      setAgents([]);
      setAllAccountMembers([]);
      setMemberUserIds(new Set());
      setMemberSearch('');
      return;
    }
    let cancelled = false;
    setMembersLoading(true);
    (async () => {
      try {
        const [membersRes, teamMembersRes] = await Promise.all([
          fetch('/api/account/members', { cache: 'no-store' }),
          apiFetch(`/api/account/teams/${team.id}/members`, { cache: 'no-store' }),
        ]);
        if (cancelled) return;

        if (membersRes.ok) {
          const data = (await membersRes.json()) as { members?: AccountMember[] };
          setAllAccountMembers(data.members ?? []);
          setAgents((data.members ?? []).filter((m) => m.role === 'agent'));
        } else {
          toast.error('Failed to load agents');
        }

        if (teamMembersRes.ok) {
          const data = (await teamMembersRes.json()) as { userIds?: string[] };
          setMemberUserIds(new Set(data.userIds ?? []));
        } else {
          toast.error('Failed to load team members');
        }
      } catch (err) {
        if (!cancelled) {
          console.error('[TeamFormDialog] members fetch error:', err);
          toast.error('Could not reach the server');
        }
      } finally {
        if (!cancelled) setMembersLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, team]);

  const currentMembers = allAccountMembers.filter((m) => memberUserIds.has(m.user_id));

  // Available-to-add pool: agents (the only role this dialog lets you
  // add — unchanged), already-members excluded, filtered by the
  // search box against name and email.
  const normalizedSearch = normalizeForSearch(memberSearch.trim());
  const availableAgents = agents
    .filter((a) => !memberUserIds.has(a.user_id))
    .filter((a) => {
      if (!normalizedSearch) return true;
      const haystack = normalizeForSearch(`${a.full_name} ${a.email ?? ''}`);
      return haystack.includes(normalizedSearch);
    });

  async function handleToggleMember(agentId: string, checked: boolean) {
    if (!team) return;
    setPendingMemberId(agentId);
    // Optimistic — revert below on failure.
    setMemberUserIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(agentId);
      else next.delete(agentId);
      return next;
    });
    try {
      const res = await apiFetch(`/api/account/teams/${team.id}/members`, {
        method: checked ? 'POST' : 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: agentId }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || 'Failed to update team membership');
      }
    } catch (err) {
      setMemberUserIds((prev) => {
        const next = new Set(prev);
        if (checked) next.delete(agentId);
        else next.add(agentId);
        return next;
      });
      console.error('[TeamFormDialog] toggle member error:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to update team membership');
    } finally {
      setPendingMemberId(null);
    }
  }

  async function handleSave() {
    const trimmedName = form.name.trim();
    if (!trimmedName) {
      toast.error('Team name is required');
      return;
    }

    let sessionTimeoutMinutes: number | null = null;
    if (form.sessionTimeoutMinutes.trim()) {
      const parsed = Number(form.sessionTimeoutMinutes);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        toast.error('Session timeout must be a positive number of minutes');
        return;
      }
      sessionTimeoutMinutes = Math.floor(parsed);
    }

    const overflowTeamId = form.overflowTeamId === NO_OVERFLOW ? null : form.overflowTeamId;

    setSaving(true);
    try {
      if (team) {
        const { error } = await supabase
          .from('teams')
          .update({
            name: trimmedName,
            session_timeout_minutes: sessionTimeoutMinutes,
            overflow_team_id: overflowTeamId,
          })
          .eq('id', team.id);
        if (error) throw error;
        toast.success('Team updated');
      } else {
        if (!accountId) throw new Error('Not authenticated');
        const { error } = await supabase.from('teams').insert({
          account_id: accountId,
          name: trimmedName,
          session_timeout_minutes: sessionTimeoutMinutes,
          overflow_team_id: overflowTeamId,
        });
        if (error) throw error;
        toast.success('Team created');
      }
      await onSaved();
      onOpenChange(false);
    } catch (err) {
      console.error('[TeamFormDialog] save error:', err);
      const msg = err instanceof Error ? err.message : 'Failed to save team';
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  // A team can't be its own overflow target (DB CHECK backs this up
  // too — see teams_overflow_not_self in migration 049).
  const overflowOptions = teams.filter((t) => t.id !== team?.id);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{team ? 'Editar equipe' : 'Nova equipe'}</DialogTitle>
          <DialogDescription>
            Tempo de sessão e transbordo ficam salvos, mas ainda não são
            aplicados automaticamente.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="team-name">Nome</Label>
            <Input
              id="team-name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="ex.: Suporte"
              maxLength={80}
              disabled={saving}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="team-timeout">
              Tempo de sessão (minutos){' '}
              <span className="text-xs text-muted-foreground">(opcional)</span>
            </Label>
            <Input
              id="team-timeout"
              type="number"
              min={1}
              value={form.sessionTimeoutMinutes}
              onChange={(e) =>
                setForm((f) => ({ ...f, sessionTimeoutMinutes: e.target.value }))
              }
              placeholder="ex.: 30"
              disabled={saving}
            />
          </div>

          <div className="space-y-2">
            <Label>
              Equipe de transbordo{' '}
              <span className="text-xs text-muted-foreground">(opcional)</span>
            </Label>
            <Select
              value={form.overflowTeamId}
              onValueChange={(v) => v && setForm((f) => ({ ...f, overflowTeamId: v }))}
            >
              <SelectTrigger className="w-full">
                {/* Select.Value has no built-in value → label lookup, so
                    without this children render it shows the raw stored
                    value ("__none__") instead of the matching SelectItem's
                    text — see fields.tsx for the same pattern. */}
                <SelectValue>
                  {(v: string) =>
                    v === NO_OVERFLOW
                      ? 'Sem transbordo'
                      : (overflowOptions.find((t) => t.id === v)?.name ?? v)
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_OVERFLOW}>Sem transbordo</SelectItem>
                {overflowOptions.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Create mode has no team row yet to link agents against —
              this section only renders once a team exists in the DB. */}
          {team && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Membros atuais</Label>
                {membersLoading ? (
                  <div className="flex items-center justify-center py-4">
                    <Loader2 className="size-4 animate-spin text-muted-foreground" />
                  </div>
                ) : currentMembers.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Nenhum membro nesta equipe ainda.
                  </p>
                ) : (
                  <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-lg border border-border p-1.5">
                    {currentMembers.map((member) => {
                      const isPending = pendingMemberId === member.user_id;
                      const displayName = member.full_name || member.email || 'Sem nome';
                      const roleMeta = ROLE_META[member.role];
                      return (
                        <div
                          key={member.user_id}
                          className="flex items-center gap-2.5 rounded-md px-2 py-1.5"
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
              </div>

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
                  <p className="text-xs text-muted-foreground">
                    Nenhum operador na conta ainda.
                  </p>
                ) : availableAgents.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {memberSearch.trim()
                      ? 'Nenhum operador encontrado para essa busca.'
                      : 'Todos os operadores já estão nesta equipe.'}
                  </p>
                ) : (
                  <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-lg border border-border p-1.5">
                    {availableAgents.map((agent) => {
                      const isPending = pendingMemberId === agent.user_id;
                      const displayName = agent.full_name || agent.email || 'Sem nome';
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
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancelar
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Salvando…
              </>
            ) : team ? (
              'Salvar alterações'
            ) : (
              'Criar equipe'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
