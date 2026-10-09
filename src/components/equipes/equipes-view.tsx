'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Loader2, Pencil, Plus, Search, Trash2, Users as UsersIcon } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { RequireRole } from '@/components/auth/require-role';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { EmptyState } from '@/components/dashboard/empty-state';
import { ErrorState } from '@/components/dashboard/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { CountUp } from '@/components/motion/count-up';
import { KpiStrip } from '@/components/ddm/kpi-strip';
import { PageBody, PageToolbar } from '@/components/ddm/page-toolbar';
import { CellMain, DenseTable, TableCard, Td, Th, Tr } from '@/components/ddm/table-card';
import { TeamFormDialog } from '@/components/settings/team-form-dialog';
import type { Team } from '@/types';

interface DeleteCounts {
  agents: number;
  conversations: number;
}

type CountMap = Map<string, number>;

function countBy<T>(rows: T[] | null, key: (r: T) => string): CountMap {
  const m: CountMap = new Map();
  for (const r of rows ?? []) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
  return m;
}

function CountUnknown() {
  return (
    <span title="Não foi possível carregar esta contagem" className="text-muted-foreground">
      <span aria-hidden="true">—</span>
      <span className="sr-only">Contagem indisponível</span>
    </span>
  );
}

export function EquipesView() {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const { accountId, accountRole, user } = useAuth();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [teams, setTeams] = useState<Team[]>([]);
  const [members, setMembers] = useState<CountMap>(new Map());
  const [channels, setChannels] = useState<CountMap>(new Map());
  const [tags, setTags] = useState<CountMap>(new Map());
  const [templates, setTemplates] = useState<CountMap>(new Map());
  const [search, setSearch] = useState('');

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTeam, setEditingTeam] = useState<Team | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Team | null>(null);
  const [deleteCounts, setDeleteCounts] = useState<DeleteCounts | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteCheckFailed, setDeleteCheckFailed] = useState(false);
  // Contagens que falharam na última carga: a célula mostra "—" em vez de 0.
  const [countErrors, setCountErrors] = useState({ members: false, channels: false, tags: false, templates: false });

  const fetchTeams = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      // Admin vê só as equipes que supervisiona (team_members); proprietário vê todas.
      // Escopo apenas de leitura: o RLS continua valendo.
      let myTeamIds: string[] | null = null;
      if (accountRole === 'admin' && user?.id) {
        const { data: mine, error: mineErr } = await supabase.from('team_members').select('team_id').eq('user_id', user.id);
        if (mineErr) throw mineErr;
        myTeamIds = (mine ?? []).map((m) => m.team_id as string);
        if (myTeamIds.length === 0) {
          setTeams([]);
          setMembers(new Map());
          setChannels(new Map());
          setTags(new Map());
          setTemplates(new Map());
          setLoadError(false);
          return;
        }
      }

      let q = supabase.from('teams').select('*').eq('account_id', accountId).order('name', { ascending: true });
      if (myTeamIds) q = q.in('id', myTeamIds);
      const { data, error } = await q;
      if (error) throw error;
      const rows = (data ?? []) as Team[];
      setTeams(rows);

      const ids = rows.map((t) => t.id);
      if (ids.length > 0) {
        const [m, c, t, tp] = await Promise.all([
          supabase.from('team_members').select('team_id, user_id').in('team_id', ids),
          supabase.from('whatsapp_config').select('id, team_id').in('team_id', ids),
          supabase.from('team_outcome_tags').select('team_id, tag_id').in('team_id', ids),
          supabase.from('team_allowed_templates').select('team_id, template_id').in('team_id', ids),
        ]);
        setCountErrors({ members: !!m.error, channels: !!c.error, tags: !!t.error, templates: !!tp.error });
        if (!m.error) setMembers(countBy(m.data, (r) => r.team_id as string));
        if (!c.error) setChannels(countBy(c.data, (r) => r.team_id as string));
        if (!t.error) setTags(countBy(t.data, (r) => r.team_id as string));
        if (!tp.error) setTemplates(countBy(tp.data, (r) => r.team_id as string));
      } else {
        setCountErrors({ members: false, channels: false, tags: false, templates: false });
        setMembers(new Map());
        setChannels(new Map());
        setTags(new Map());
        setTemplates(new Map());
      }
      setLoadError(false);
    } catch (err) {
      console.error('[EquipesView] fetch error:', err);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [accountId, accountRole, user?.id, supabase]);

  useEffect(() => {
    void fetchTeams();
  }, [fetchTeams]);

  async function confirmDelete(team: Team) {
    setDeleteTarget(team);
    setDeleteCounts(null);
    setDeleteCheckFailed(false);
    try {
      const [agentsRes, convRes] = await Promise.all([
        supabase.from('profiles').select('user_id', { count: 'exact', head: true }).eq('team_id', team.id),
        supabase.from('conversations').select('id', { count: 'exact', head: true }).eq('team_id', team.id),
      ]);
      if (agentsRes.error || convRes.error || agentsRes.count === null || convRes.count === null) {
        // Não afirma "nenhum vínculo" quando a consulta falhou.
        console.error('[EquipesView] delete-count error:', agentsRes.error ?? convRes.error);
        setDeleteCheckFailed(true);
        return;
      }
      setDeleteCounts({ agents: agentsRes.count, conversations: convRes.count });
    } catch (err) {
      console.error('[EquipesView] delete-count error:', err);
      setDeleteCheckFailed(true);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const { error } = await supabase.from('teams').delete().eq('id', deleteTarget.id);
      if (error) throw error;
      toast.success('Equipe excluída');
      setTeams((prev) => prev.filter((t) => t.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (err) {
      console.error('[EquipesView] delete error:', err);
      toast.error('Erro ao excluir equipe');
    } finally {
      setDeleting(false);
    }
  }

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? teams.filter((t) => t.name.toLowerCase().includes(q)) : teams;
  }, [teams, search]);

  const sum = (m: CountMap) => teams.reduce((acc, t) => acc + (m.get(t.id) ?? 0), 0);
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  return (
    <PageBody>
      <div className="flex flex-col gap-1.5 pt-1">
        <h2 className="font-heading text-[28px] font-semibold leading-tight tracking-[-0.025em] text-foreground">Equipes</h2>
        <p className="max-w-[620px] text-sm leading-relaxed text-muted-foreground">
          Filas nomeadas para rotear conversas, com os usuários, canais, tabulações e templates de cada uma.
        </p>
      </div>

      {loadError ? (
        <ErrorState title="Não foi possível carregar as equipes" onRetry={() => void fetchTeams()} />
      ) : (
        <>
          {!loading && teams.length > 0 && (
            <KpiStrip
              ariaLabel="Resumo das equipes"
              items={[
                { label: 'Equipes', value: <CountUp value={teams.length} /> },
                { label: 'Vínculos de usuários', value: countErrors.members ? <CountUnknown /> : <CountUp value={sum(members)} />, info: 'Soma dos usuários em cada equipe.' },
                { label: 'Canais vinculados', value: countErrors.channels ? <CountUnknown /> : <CountUp value={sum(channels)} /> },
              ]}
            />
          )}

          <PageToolbar
            actions={
              <RequireRole min="owner">
                <Button
                  onClick={() => {
                    setEditingTeam(null);
                    setDialogOpen(true);
                  }}
                >
                  <Plus className="size-3.5" />
                  Nova equipe
                </Button>
              </RequireRole>
            }
          >
            <label className="relative flex min-w-0 flex-[1_1_240px] items-center sm:max-w-[360px]">
              <Search className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground" aria-hidden="true" />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar equipe"
                aria-label="Buscar equipes"
                className="h-[34px] w-full rounded-md border border-border bg-card pl-[34px] pr-2.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary focus:shadow-[0_0_0_3px_var(--primary-soft-2)]"
              />
            </label>
          </PageToolbar>

          <TableCard label="Equipes">
            {loading ? (
              <div className="flex flex-col" aria-busy="true">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="flex items-center gap-3 border-b border-border px-[18px] py-3.5" aria-hidden="true">
                    <Skeleton className="h-3 w-40" />
                    <Skeleton className="ml-auto h-3 w-24" />
                  </div>
                ))}
              </div>
            ) : visible.length === 0 ? (
              <div className="p-4">
                <EmptyState
                  icon={UsersIcon}
                  title={teams.length === 0 ? 'Nenhuma equipe ainda' : 'Nada encontrado'}
                  hint={teams.length === 0 ? 'Só o proprietário cria equipes.' : 'Ajuste a busca.'}
                />
              </div>
            ) : (
              <DenseTable>
                <thead>
                  <tr>
                    <Th>Equipe</Th>
                    <Th align="right">Usuários</Th>
                    <Th align="right">Canais</Th>
                    <Th align="right" className="hidden md:table-cell">Tabulações</Th>
                    <Th align="right" className="hidden md:table-cell">Templates</Th>
                    <Th className="hidden lg:table-cell">Sessão</Th>
                    <Th className="hidden lg:table-cell">Transbordo</Th>
                    <Th align="right">
                      <span className="sr-only">Ações</span>
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((team) => {
                    const overflow = teams.find((t) => t.id === team.overflow_team_id);
                    return (
                      <Tr
                        key={team.id}
                        className="cursor-pointer"
                        tabIndex={0}
                        aria-label={`Abrir equipe ${team.name}`}
                        onClick={() => router.push(`/equipes/${team.id}`)}
                        onKeyDown={(e) => {
                          if (e.target !== e.currentTarget) return;
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            router.push(`/equipes/${team.id}`);
                          }
                        }}
                      >
                        <Td>
                          <span className="flex min-w-0 items-center gap-2.5">
                            {team.color ? <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: team.color }} /> : null}
                            <CellMain title={team.name} />
                          </span>
                        </Td>
                        <Td align="right">{countErrors.members ? <CountUnknown /> : (members.get(team.id) ?? 0)}</Td>
                        <Td align="right">{countErrors.channels ? <CountUnknown /> : (channels.get(team.id) ?? 0)}</Td>
                        <Td align="right" className="hidden md:table-cell">{countErrors.tags ? <CountUnknown /> : (tags.get(team.id) ?? 0)}</Td>
                        <Td align="right" className="hidden md:table-cell">{countErrors.templates ? <CountUnknown /> : (templates.get(team.id) ?? 0)}</Td>
                        <Td className="hidden text-foreground-2 lg:table-cell">
                          {team.session_timeout_minutes ? `${team.session_timeout_minutes} min` : '—'}
                        </Td>
                        <Td className="hidden text-foreground-2 lg:table-cell">{overflow?.name ?? '—'}</Td>
                        <Td align="right">
                          <RequireRole min="owner">
                            <span className="inline-flex items-center gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  setEditingTeam(team);
                                  setDialogOpen(true);
                                }}
                                title="Editar equipe"
                                aria-label={`Editar ${team.name}`}
                              >
                                <Pencil className="size-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => void confirmDelete(team)}
                                title="Excluir equipe"
                                aria-label={`Excluir ${team.name}`}
                                className="text-muted-foreground hover:text-destructive"
                              >
                                <Trash2 className="size-4" />
                              </Button>
                            </span>
                          </RequireRole>
                        </Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </DenseTable>
            )}
          </TableCard>
        </>
      )}

      <TeamFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        team={editingTeam}
        teams={teams}
        accountId={accountId}
        onSaved={fetchTeams}
      />

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && !deleting && setDeleteTarget(null)}>
        <AlertDialogContent className="sm:max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir equipe</AlertDialogTitle>
            <AlertDialogDescription>
              Excluir &quot;{deleteTarget?.name}&quot;?{' '}
              {deleteCounts
                ? deleteCounts.agents > 0 || deleteCounts.conversations > 0
                  ? `Essa equipe tem ${plural(deleteCounts.agents, 'agente', 'agentes')} e ${plural(deleteCounts.conversations, 'conversa', 'conversas')} vinculados: eles ficam sem equipe, não são excluídos.`
                  : 'Nenhum agente ou conversa está vinculado a ela.'
                : deleteCheckFailed
                  ? 'Não foi possível verificar os vínculos (agentes e conversas). Você ainda pode excluir; o que estiver vinculado fica sem equipe.'
                  : 'Verificando agentes e conversas vinculados…'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancelar</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => void handleDelete()}
              disabled={deleting || (deleteCounts === null && !deleteCheckFailed)}
            >
              {deleting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Excluindo...
                </>
              ) : (
                'Excluir equipe'
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageBody>
  );
}
