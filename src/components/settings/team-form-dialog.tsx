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
import { Loader2 } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
  const [agents, setAgents] = useState<AccountMember[]>([]);
  const [memberUserIds, setMemberUserIds] = useState<Set<string>>(new Set());
  const [membersLoading, setMembersLoading] = useState(false);
  const [pendingMemberId, setPendingMemberId] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !team) {
      setAgents([]);
      setMemberUserIds(new Set());
      return;
    }
    let cancelled = false;
    setMembersLoading(true);
    (async () => {
      try {
        const [membersRes, teamMembersRes] = await Promise.all([
          fetch('/api/account/members', { cache: 'no-store' }),
          fetch(`/api/account/teams/${team.id}/members`, { cache: 'no-store' }),
        ]);
        if (cancelled) return;

        if (membersRes.ok) {
          const data = (await membersRes.json()) as { members?: AccountMember[] };
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
      const res = await fetch(`/api/account/teams/${team.id}/members`, {
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
                <SelectValue />
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
            <div className="space-y-2">
              <Label>Membros</Label>
              {membersLoading ? (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                </div>
              ) : agents.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Nenhum agente na conta ainda.
                </p>
              ) : (
                <div className="max-h-48 space-y-0.5 overflow-y-auto rounded-lg border border-border p-1.5">
                  {agents.map((agent) => {
                    const checked = memberUserIds.has(agent.user_id);
                    const isPending = pendingMemberId === agent.user_id;
                    const displayName = agent.full_name || agent.email || 'Sem nome';
                    return (
                      <label
                        key={agent.user_id}
                        className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted"
                      >
                        <Checkbox
                          checked={checked}
                          disabled={isPending}
                          onCheckedChange={(next) =>
                            handleToggleMember(agent.user_id, next === true)
                          }
                        />
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
                        {isPending && (
                          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                        )}
                      </label>
                    );
                  })}
                </div>
              )}
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
