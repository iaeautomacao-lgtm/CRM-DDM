'use client';

// ============================================================
// TeamsPanel — Settings → Equipes
//
// Phase 3a CRUD only: name, session_timeout_minutes, overflow_team_id.
// Nothing here reads those last two fields automatically yet — they're
// saved for later phases (3b assignment, 3c overflow) to consume.
//
// Membership (which agent belongs to this team) is edited from
// Settings → Team members instead (a second Select next to Role) —
// deliberately not duplicated here, per the phase 3a plan.
//
// CRUD goes straight through the Supabase client, no API route: RLS
// (migration 049) already restricts INSERT/UPDATE/DELETE to admin+
// and SELECT to any account member, the same shape as tags
// (tag-manager.tsx) — `<RequireRole>` below is just the UX layer that
// hides the buttons non-admins can't use anyway.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Pencil, Plus, Trash2, Users as UsersIcon } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { RequireRole } from '@/components/auth/require-role';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SettingsPanelHead } from './settings-panel-head';
import { TeamFormDialog } from './team-form-dialog';
import type { Team } from '@/types';

interface DeleteCounts {
  agents: number;
  conversations: number;
}

export function TeamsPanel() {
  const supabase = createClient();
  const { accountId } = useAuth();

  const [loading, setLoading] = useState(true);
  const [teams, setTeams] = useState<Team[]>([]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTeam, setEditingTeam] = useState<Team | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<Team | null>(null);
  const [deleteCounts, setDeleteCounts] = useState<DeleteCounts | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchTeams = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('teams')
        .select('*')
        .eq('account_id', accountId)
        .order('name', { ascending: true });
      if (error) throw error;
      setTeams((data ?? []) as Team[]);
    } catch (err) {
      console.error('[TeamsPanel] fetch error:', err);
      toast.error('Failed to load teams');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  useEffect(() => {
    void fetchTeams();
  }, [fetchTeams]);

  function openCreate() {
    setEditingTeam(null);
    setDialogOpen(true);
  }

  function openEdit(team: Team) {
    setEditingTeam(team);
    setDialogOpen(true);
  }

  async function confirmDelete(team: Team) {
    setDeleteTarget(team);
    setDeleteCounts(null);
    try {
      const [agentsRes, conversationsRes] = await Promise.all([
        supabase
          .from('profiles')
          .select('user_id', { count: 'exact', head: true })
          .eq('team_id', team.id),
        supabase
          .from('conversations')
          .select('id', { count: 'exact', head: true })
          .eq('team_id', team.id),
      ]);
      setDeleteCounts({
        agents: agentsRes.count ?? 0,
        conversations: conversationsRes.count ?? 0,
      });
    } catch (err) {
      // Non-fatal — the confirm dialog still works, just without the
      // "N agents / M conversations linked" hint.
      console.error('[TeamsPanel] delete-count error:', err);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const { error } = await supabase.from('teams').delete().eq('id', deleteTarget.id);
      if (error) throw error;
      toast.success('Team deleted');
      setTeams((prev) => prev.filter((t) => t.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (err) {
      console.error('[TeamsPanel] delete error:', err);
      toast.error('Failed to delete team');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="max-w-2xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title="Equipes"
        description="Filas nomeadas para rotear conversas. Tempo de sessão e transbordo ficam salvos aqui, mas nenhuma automação os usa ainda — isso vem em fases futuras."
        action={
          <RequireRole min="admin">
            <Button onClick={openCreate}>
              <Plus className="size-4" />
              Nova equipe
            </Button>
          </RequireRole>
        }
      />

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      ) : teams.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
            <UsersIcon className="size-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Nenhuma equipe ainda.</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y divide-border">
              {teams.map((team) => {
                const overflowTeam = teams.find((t) => t.id === team.overflow_team_id);
                return (
                  <li
                    key={team.id}
                    className="flex flex-wrap items-center gap-3 px-4 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">
                        {team.name}
                      </p>
                      {(team.session_timeout_minutes || overflowTeam) && (
                        <div className="mt-1 flex flex-wrap gap-1.5 text-xs text-muted-foreground">
                          {team.session_timeout_minutes ? (
                            <span className="rounded-full border border-border bg-muted px-2 py-0.5">
                              Sessão: {team.session_timeout_minutes} min
                            </span>
                          ) : null}
                          {overflowTeam ? (
                            <span className="rounded-full border border-border bg-muted px-2 py-0.5">
                              Transbordo: {overflowTeam.name}
                            </span>
                          ) : null}
                        </div>
                      )}
                    </div>
                    <RequireRole min="admin">
                      <div className="flex items-center gap-1.5">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openEdit(team)}
                          title="Editar equipe"
                          aria-label="Editar equipe"
                        >
                          <Pencil className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => confirmDelete(team)}
                          title="Excluir equipe"
                          aria-label="Excluir equipe"
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </RequireRole>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}

      <TeamFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        team={editingTeam}
        teams={teams}
        accountId={accountId}
        onSaved={fetchTeams}
      />

      {/* Delete confirmation */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Excluir equipe</DialogTitle>
            <DialogDescription>
              Excluir &quot;{deleteTarget?.name}&quot;?{' '}
              {deleteCounts ? (
                deleteCounts.agents > 0 || deleteCounts.conversations > 0 ? (
                  <>
                    Essa equipe tem {deleteCounts.agents} agente
                    {deleteCounts.agents === 1 ? '' : 's'} e {deleteCounts.conversations}{' '}
                    conversa{deleteCounts.conversations === 1 ? '' : 's'} vinculado(s) —
                    eles ficam sem equipe, não são excluídos.
                  </>
                ) : (
                  'Nenhum agente ou conversa está vinculado a ela.'
                )
              ) : (
                'Verificando agentes e conversas vinculados…'
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              Cancelar
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Excluindo...
                </>
              ) : (
                'Excluir equipe'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
