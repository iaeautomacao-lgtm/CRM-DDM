'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, Crown, Power, KeyRound, Loader2, MailX, Plus, Search, Trash2, Upload, UsersRound } from 'lucide-react';

import { apiFetch } from '@/lib/api-fetch';
import { createClient } from '@/lib/supabase/client';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmptyState } from '@/components/dashboard/empty-state';
import { ErrorState, ForbiddenState } from '@/components/dashboard/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { CountUp } from '@/components/motion/count-up';
import { KpiStrip } from '@/components/ddm/kpi-strip';
import { PageBody, PageToolbar } from '@/components/ddm/page-toolbar';
import { Segmented } from '@/components/ddm/segmented';
import { StatusChip, type StatusTone } from '@/components/ddm/status-chip';
import { CellMain, DenseTable, TableCard, Td, Th, Tr } from '@/components/ddm/table-card';
import { DetailDrawer } from '@/components/ddm/list-with-drawer';
import { usePermissions } from '@/hooks/use-permission';
import { useAuth } from '@/hooks/use-auth';
import { usePresence } from '@/hooks/use-presence';
import type { AccountRole } from '@/lib/auth/roles';
import type { PresenceStatus } from '@/lib/presence';
import { BulkImportMembersDialog } from '@/components/settings/bulk-import-members-dialog';
import { InviteMemberDialog } from '@/components/settings/invite-member-dialog';
import { ROLE_META } from '@/components/settings/role-meta';

interface Member {
  user_id: string;
  full_name: string;
  email: string | null;
  avatar_url: string | null;
  role: AccountRole;
  joined_at: string;
  team_id: string | null;
  /** Status da conta (migration 311). Os campos de acesso só vêm para quem tem members.manage. */
  active: boolean;
  deactivated_at: string | null;
  last_sign_in_at: string | null;
  last_active_at: string | null;
}

interface Invitation {
  id: string;
  role: 'admin' | 'supervisor' | 'agent' | 'viewer';
  label: string | null;
  created_at: string;
  expires_at: string;
}

type Filter = 'all' | AccountRole | 'invites';
type StatusFilter = 'all' | 'active' | 'inactive';

// Papéis editáveis no seletor. Proprietário nunca é opção: a promoção passa pela transferência de propriedade.
const EDITABLE_ROLES: AccountRole[] = ['admin', 'supervisor', 'agent', 'viewer'];
const MIN_RESET_PASSWORD_LENGTH = 8;

const ROLE_TONE: Record<AccountRole, StatusTone> = {
  owner: 'brand',
  admin: 'info',
  supervisor: 'info',
  agent: 'mute',
  viewer: 'mute',
};

const PRESENCE_TONE: Record<PresenceStatus, StatusTone> = { online: 'ok', away: 'warn', offline: 'mute' };
const PRESENCE_TEXT: Record<PresenceStatus, string> = { online: 'Online', away: 'Ausente', offline: 'Offline' };

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('pt-BR', { year: 'numeric', month: 'short', day: 'numeric' });
}

function fmtExpiresIn(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'expirado';
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `expira em ${days} dia${days === 1 ? '' : 's'}`;
  const hours = Math.max(1, Math.floor(ms / 3_600_000));
  return `expira em ${hours} hora${hours === 1 ? '' : 's'}`;
}

/** "agora", "há 5 min", "há 3 h", "há 2 dias" — a partir do último batimento de presença. */
function fmtLastSeen(iso: string | null | undefined, now: number): string {
  if (!iso) return '—';
  const diff = Math.max(0, now - new Date(iso).getTime());
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.floor(h / 24);
  return `há ${d} dia${d === 1 ? '' : 's'}`;
}

function initial(m: { full_name: string; email: string | null }): string {
  return (m.full_name || m.email || 'U').charAt(0).toUpperCase();
}

/** Último acesso: atividade no app (last_active_at); sem ela, o último login. Online vira "agora". */
function lastAccessLabel(m: Pick<Member, 'last_active_at' | 'last_sign_in_at'>, presence: PresenceStatus, now: number): string {
  if (presence === 'online') return 'agora';
  return fmtLastSeen(m.last_active_at ?? m.last_sign_in_at, now);
}

function RoleChip({ role }: { role: AccountRole }) {
  return (
    <StatusChip tone={ROLE_TONE[role]} dot={false}>
      {ROLE_META[role].label}
    </StatusChip>
  );
}

export function UsuariosView() {
  const { user } = useAuth();
  const { can } = usePermissions();
  const canManageMembers = can('members.manage');
  const canInvite = can('members.invite');
  const canBulkInvite = can('members.bulk_invite');
  const canResetPassword = can('members.reset_password');
  // Só o proprietário (ownership.transfer); o servidor revalida.
  const canTransferOwnership = can('ownership.transfer');
  const { getPresence, now } = usePresence();

  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [teamNames, setTeamNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<'forbidden' | 'error' | null>(null);

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [bulkImportOpen, setBulkImportOpen] = useState(false);
  const [removingMember, setRemovingMember] = useState<Member | null>(null);
  const [resetPasswordMember, setResetPasswordMember] = useState<Member | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [resettingPassword, setResettingPassword] = useState(false);
  const [pendingMemberAction, setPendingMemberAction] = useState<string | null>(null);
  const [transferTarget, setTransferTarget] = useState<Member | null>(null);
  const [transferring, setTransferring] = useState(false);
  // Desativar/reativar (POST /api/account/members/{id}/status): nunca o proprietário nem a si mesmo.
  const [statusTarget, setStatusTarget] = useState<{ member: Member; active: boolean } | null>(null);
  const [changingStatus, setChangingStatus] = useState(false);

  const load = useCallback(async () => {
    try {
      const [mres, ires] = await Promise.all([
        apiFetch('/api/account/members', { cache: 'no-store' }),
        canInvite ? apiFetch('/api/account/invitations', { cache: 'no-store' }) : Promise.resolve(null),
      ]);
      if (!mres.ok) {
        setLoadError(mres.status === 403 ? 'forbidden' : 'error');
        return;
      }
      const mdata = (await mres.json()) as { members: Member[] };
      setMembers(mdata.members);
      if (ires?.ok) {
        const idata = (await ires.json()) as { invitations: Invitation[] };
        setInvitations(idata.invitations);
      } else {
        if (ires) toast.error('Falha ao carregar convites');
        setInvitations([]);
      }
      setLoadError(null);
    } catch (err) {
      console.error('[UsuariosView] load error:', err);
      setLoadError('error');
    } finally {
      setLoading(false);
    }
  }, [canInvite]);

  useEffect(() => {
    void load();
  }, [load]);

  // Nomes das equipes (só para a coluna "Equipe"; falha não bloqueia a tela).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data } = await createClient().from('teams').select('id, name');
      if (cancelled || !data) return;
      setTeamNames(Object.fromEntries((data as { id: string; name: string }[]).map((t) => [t.id, t.name])));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const counts = useMemo(() => {
    const p = { online: 0, away: 0 };
    for (const m of members) {
      const s = getPresence(m.user_id);
      if (s === 'online') p.online += 1;
      else if (s === 'away') p.away += 1;
    }
    const byRole: Record<AccountRole, number> = { owner: 0, admin: 0, supervisor: 0, agent: 0, viewer: 0 };
    for (const m of members) byRole[m.role] += 1;
    return { ...p, byRole };
  }, [members, getPresence]);

  const filteredMembers = useMemo(() => {
    if (filter === 'invites') return [];
    const q = search.trim().toLowerCase();
    return members.filter((m) => {
      if (filter !== 'all' && m.role !== filter) return false;
      if (statusFilter === 'active' && !m.active) return false;
      if (statusFilter === 'inactive' && m.active) return false;
      if (!q) return true;
      return (m.full_name || '').toLowerCase().includes(q) || (m.email || '').toLowerCase().includes(q);
    });
  }, [members, filter, statusFilter, search]);

  const filteredInvites = useMemo(() => {
    if (filter !== 'invites') return [];
    const q = search.trim().toLowerCase();
    return invitations.filter((i) => !q || (i.label ?? '').toLowerCase().includes(q));
  }, [invitations, filter, search]);

  const selected = members.find((m) => m.user_id === selectedId) ?? null;

  async function handleRoleChange(member: Member, nextRole: AccountRole) {
    if (member.role === nextRole) return;
    const previousRole = member.role;
    const apply = (role: AccountRole) =>
      setMembers((prev) => prev.map((m) => (m.user_id === member.user_id ? { ...m, role } : m)));
    setPendingMemberAction(member.user_id);
    apply(nextRole);
    try {
      const res = await apiFetch(`/api/account/members/${member.user_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: nextRole }),
      });
      if (!res.ok) {
        apply(previousRole);
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || 'Falha ao atualizar papel');
        return;
      }
      toast.success(`${member.full_name || 'Usuário'} atualizado para ${ROLE_META[nextRole].label}`);
    } catch (err) {
      apply(previousRole);
      console.error('[UsuariosView] role change error:', err);
      toast.error('Não foi possível conectar ao servidor');
    } finally {
      setPendingMemberAction(null);
    }
  }

  async function handleRemove() {
    if (!removingMember) return;
    setPendingMemberAction(removingMember.user_id);
    try {
      const res = await apiFetch(`/api/account/members/${removingMember.user_id}`, { method: 'DELETE' });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || 'Falha ao remover usuário');
        return;
      }
      toast.success(`${removingMember.full_name || 'Usuário'} removido`);
      setMembers((prev) => prev.filter((m) => m.user_id !== removingMember.user_id));
      if (selectedId === removingMember.user_id) setSelectedId(null);
      setRemovingMember(null);
    } catch (err) {
      console.error('[UsuariosView] remove error:', err);
      toast.error('Não foi possível conectar ao servidor');
    } finally {
      setPendingMemberAction(null);
    }
  }

  function closeResetPasswordDialog() {
    setResetPasswordMember(null);
    setNewPassword('');
    setConfirmPassword('');
  }

  async function handleResetPassword() {
    if (!resetPasswordMember) return;
    if (newPassword.length < MIN_RESET_PASSWORD_LENGTH) {
      toast.error(`A senha deve ter pelo menos ${MIN_RESET_PASSWORD_LENGTH} caracteres`);
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error('As senhas não coincidem');
      return;
    }
    setResettingPassword(true);
    try {
      const res = await apiFetch(`/api/account/members/${resetPasswordMember.user_id}/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: newPassword }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || 'Falha ao redefinir senha');
        return;
      }
      toast.success(`Senha de ${resetPasswordMember.full_name || 'usuário'} redefinida`);
      closeResetPasswordDialog();
    } catch (err) {
      console.error('[UsuariosView] reset password error:', err);
      toast.error('Não foi possível conectar ao servidor');
    } finally {
      setResettingPassword(false);
    }
  }

  async function handleTransferOwnership() {
    if (!transferTarget) return;
    setTransferring(true);
    try {
      const res = await apiFetch('/api/account/transfer-ownership', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newOwnerUserId: transferTarget.user_id }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || 'Falha ao transferir a propriedade');
        return;
      }
      toast.success(`Propriedade transferida para ${transferTarget.full_name || 'o usuário'}`);
      setTransferTarget(null);
      setSelectedId(null);
      // Seu papel mudou para Administrador: recarrega para refazer as permissões.
      window.location.reload();
    } catch (err) {
      console.error('[UsuariosView] transfer ownership error:', err);
      toast.error('Não foi possível conectar ao servidor');
    } finally {
      setTransferring(false);
    }
  }

  async function handleChangeStatus() {
    if (!statusTarget) return;
    const { member, active } = statusTarget;
    setChangingStatus(true);
    try {
      const res = await apiFetch(`/api/account/members/${member.user_id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || (active ? 'Falha ao reativar o usuário' : 'Falha ao desativar o usuário'));
        return;
      }
      setMembers((prev) =>
        prev.map((m) =>
          m.user_id === member.user_id ? { ...m, active, deactivated_at: active ? null : new Date().toISOString() } : m,
        ),
      );
      const name = member.full_name || 'Usuário';
      if (payload.ban_failed) {
        toast.warning(`${name} foi desativado e as sessões caíram, mas o bloqueio de login não foi concluído. Tente de novo.`);
      } else {
        toast.success(active ? `${name} reativado` : `${name} desativado`);
      }
      setStatusTarget(null);
    } catch (err) {
      console.error('[UsuariosView] status change error:', err);
      toast.error('Não foi possível conectar ao servidor');
    } finally {
      setChangingStatus(false);
    }
  }

  async function handleRevoke(invite: Invitation) {
    try {
      const res = await apiFetch(`/api/account/invitations/${invite.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || 'Falha ao revogar convite');
        return;
      }
      toast.success('Convite revogado');
      setInvitations((prev) => prev.filter((i) => i.id !== invite.id));
    } catch (err) {
      console.error('[UsuariosView] revoke error:', err);
      toast.error('Não foi possível conectar ao servidor');
    }
  }

  const segOptions: { value: Filter; label: string; count: number }[] = [
    { value: 'all', label: 'Todos', count: members.length },
    ...(['owner', 'admin', 'supervisor', 'agent', 'viewer'] as AccountRole[])
      .filter((r) => counts.byRole[r] > 0)
      .map((r) => ({ value: r as Filter, label: ROLE_META[r].label, count: counts.byRole[r] })),
    ...(canInvite ? [{ value: 'invites' as Filter, label: 'Convites', count: invitations.length }] : []),
  ];

  const selectedCanEdit = !!selected && canManageMembers && selected.role !== 'owner' && selected.user_id !== user?.id;
  const selectedCanTransfer = !!selected && canTransferOwnership && selected.role !== 'owner' && selected.user_id !== user?.id;

  return (
    <PageBody>
      <div className="flex flex-col gap-1.5 pt-1">
        <h2 className="font-heading text-[28px] font-semibold leading-tight tracking-[-0.025em] text-foreground">Usuários</h2>
        <p className="max-w-[620px] text-sm leading-relaxed text-muted-foreground">
          Pessoas com acesso a esta conta. Os papéis controlam o que cada usuário pode fazer.
        </p>
      </div>

      {loadError === 'forbidden' ? (
        <ForbiddenState title="Você não tem permissão para ver os usuários" />
      ) : loadError === 'error' ? (
        <ErrorState
          title="Não foi possível carregar os usuários"
          onRetry={() => {
            setLoading(true);
            void load();
          }}
        />
      ) : (
        <>
          {!loading && members.length > 0 && (
            <KpiStrip
              ariaLabel="Resumo dos usuários"
              items={[
                { label: 'Usuários', value: <CountUp value={members.length} /> },
                { label: 'Online agora', value: <CountUp value={counts.online} />, noteTone: 'ok' },
                { label: 'Ausentes', value: <CountUp value={counts.away} /> },
                ...(canInvite
                  ? [
                      {
                        label: 'Convites pendentes',
                        value: <CountUp value={invitations.length} />,
                        onClick: () => setFilter('invites'),
                        active: filter === 'invites',
                      },
                    ]
                  : []),
              ]}
            />
          )}

          <PageToolbar
            actions={
              canInvite ? (
                <>
                  {/* Convite em lote é só do proprietário no servidor (members.bulk_invite). */}
                  {canBulkInvite && (
                    <Button variant="outline" onClick={() => setBulkImportOpen(true)}>
                      <Upload className="size-3.5" />
                      Importar usuários
                    </Button>
                  )}
                  <Button onClick={() => setInviteOpen(true)}>
                    <Plus className="size-3.5" />
                    Convidar usuário
                  </Button>
                </>
              ) : undefined
            }
          >
            <label className="relative flex min-w-0 flex-[1_1_240px] items-center sm:max-w-[360px]">
              <Search className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground" aria-hidden="true" />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={filter === 'invites' ? 'Buscar convite' : 'Buscar nome ou e-mail'}
                aria-label="Buscar usuários"
                className="h-[34px] w-full rounded-md border border-border bg-card pl-[34px] pr-2.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary focus:shadow-[0_0_0_3px_var(--primary-soft-2)]"
              />
            </label>
            <Segmented ariaLabel="Filtrar por papel" size="lg" value={filter} onChange={setFilter} options={segOptions} />
            {canManageMembers && filter !== 'invites' && (
              <Segmented
                ariaLabel="Filtrar por status"
                size="lg"
                value={statusFilter}
                onChange={setStatusFilter}
                options={[
                  { value: 'all', label: 'Todos' },
                  { value: 'active', label: 'Ativos', count: members.filter((m) => m.active).length },
                  { value: 'inactive', label: 'Desativados', count: members.filter((m) => !m.active).length },
                ]}
              />
            )}
          </PageToolbar>

          <TableCard label={filter === 'invites' ? 'Convites pendentes' : 'Usuários'}>
            {loading ? (
              <div className="flex flex-col" aria-busy="true">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="flex items-center gap-3 border-b border-border px-[18px] py-3.5" aria-hidden="true">
                    <Skeleton className="size-[30px] rounded-full" />
                    <Skeleton className="h-3 w-40" />
                    <Skeleton className="ml-auto h-5 w-24 rounded-full" />
                  </div>
                ))}
              </div>
            ) : filter === 'invites' ? (
              filteredInvites.length === 0 ? (
                <div className="p-4">
                  <EmptyState
                    icon={UsersRound}
                    title={invitations.length === 0 ? 'Nenhum convite pendente' : 'Nada encontrado'}
                    hint={
                      invitations.length === 0
                        ? 'Clique em “Convidar usuário” para gerar um link compartilhável.'
                        : 'Ajuste a busca.'
                    }
                  />
                </div>
              ) : (
                <>
                  <p className="px-[18px] pb-2 text-xs text-muted-foreground">
                    A URL do convite só é exibida uma vez, na criação, por segurança. Para compartilhar de novo, revogue o convite e crie outro.
                  </p>
                  <DenseTable minWidth={560}>
                    <thead>
                      <tr>
                        <Th>Convite</Th>
                        <Th>Papel</Th>
                        <Th>Validade</Th>
                        <Th align="right">
                          <span className="sr-only">Ações</span>
                        </Th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredInvites.map((inv) => (
                        <Tr key={inv.id} interactive={false}>
                          <Td>
                            <CellMain title={inv.label || 'Convite sem título'} sub={`Criado em ${fmtDate(inv.created_at)}`} />
                          </Td>
                          <Td>
                            <RoleChip role={inv.role} />
                          </Td>
                          <Td>
                            <StatusChip tone="warn">{fmtExpiresIn(inv.expires_at)}</StatusChip>
                          </Td>
                          <Td align="right">
                            <Button variant="outline" size="sm" onClick={() => void handleRevoke(inv)}>
                              <MailX className="size-3.5" />
                              Revogar
                            </Button>
                          </Td>
                        </Tr>
                      ))}
                    </tbody>
                  </DenseTable>
                </>
              )
            ) : filteredMembers.length === 0 ? (
              <div className="p-4">
                <EmptyState
                  icon={UsersRound}
                  title={members.length === 0 ? 'Nenhum usuário' : 'Nada encontrado'}
                  hint={members.length === 0 ? undefined : 'Ajuste a busca ou o filtro.'}
                />
              </div>
            ) : (
              <DenseTable minWidth={760}>
                <thead>
                  <tr>
                    <Th>Usuário</Th>
                    <Th>Papel</Th>
                    <Th className="hidden md:table-cell">Equipe</Th>
                    <Th>Situação</Th>
                    {canManageMembers && (
                      <Th align="right" className="hidden sm:table-cell">
                        Último acesso
                      </Th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {filteredMembers.map((m) => {
                    const presence = getPresence(m.user_id);
                    return (
                      <Tr
                        key={m.user_id}
                        className={m.active ? 'cursor-pointer' : 'cursor-pointer opacity-60'}
                        tabIndex={0}
                        aria-label={`Abrir ${m.full_name || 'usuário'}`}
                        onClick={() => setSelectedId(m.user_id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setSelectedId(m.user_id);
                          }
                        }}
                      >
                        <Td>
                          <span className="flex min-w-0 items-center gap-2.5">
                            <Avatar className="size-[30px] shrink-0">
                              {m.avatar_url ? <AvatarImage src={m.avatar_url} alt="" /> : null}
                              <AvatarFallback className="bg-primary/10 text-xs font-medium text-primary">{initial(m)}</AvatarFallback>
                            </Avatar>
                            <CellMain
                              title={
                                <>
                                  {m.full_name || 'Sem nome'}
                                  {m.user_id === user?.id && <span className="ml-1.5 text-[10px] font-semibold uppercase text-muted-foreground">Você</span>}
                                </>
                              }
                              sub={m.email}
                            />
                          </span>
                        </Td>
                        <Td>
                          <RoleChip role={m.role} />
                        </Td>
                        <Td className="hidden text-foreground-2 md:table-cell">{(m.team_id && teamNames[m.team_id]) || '—'}</Td>
                        <Td>
                          {m.active ? (
                            <StatusChip tone={PRESENCE_TONE[presence]}>{PRESENCE_TEXT[presence]}</StatusChip>
                          ) : (
                            <StatusChip tone="mute">Desativado</StatusChip>
                          )}
                        </Td>
                        {canManageMembers && (
                          <Td align="right" className="hidden text-muted-foreground sm:table-cell">
                            {lastAccessLabel(m, presence, now)}
                          </Td>
                        )}
                      </Tr>
                    );
                  })}
                </tbody>
              </DenseTable>
            )}
          </TableCard>
        </>
      )}

      <DetailDrawer
        open={!!selected}
        onOpenChange={(o) => !o && setSelectedId(null)}
        title={selected?.full_name || 'Usuário'}
        description={selected?.email ?? 'Usuário da conta'}
        headerExtra={selected ? <RoleChip role={selected.role} /> : null}
        size="md"
        footer={
          selected && (canResetPassword || selectedCanEdit || selectedCanTransfer) && selected.user_id !== user?.id ? (
            <>
              {canResetPassword && (
                <Button variant="outline" onClick={() => setResetPasswordMember(selected)}>
                  <KeyRound className="size-3.5" />
                  Redefinir senha
                </Button>
              )}
              {selectedCanTransfer && (
                <Button variant="outline" onClick={() => setTransferTarget(selected)}>
                  <Crown className="size-3.5" />
                  Transferir propriedade
                </Button>
              )}
              {selectedCanEdit && (
                <Button variant="outline" onClick={() => setStatusTarget({ member: selected, active: !selected.active })}>
                  <Power className="size-3.5" />
                  {selected.active ? 'Desativar' : 'Reativar'}
                </Button>
              )}
              {selectedCanEdit && (
                <Button variant="destructive" onClick={() => setRemovingMember(selected)} disabled={pendingMemberAction === selected.user_id}>
                  <Trash2 className="size-3.5" />
                  Remover da conta
                </Button>
              )}
            </>
          ) : undefined
        }
      >
        {selected && (
          <dl className="flex flex-col gap-4 text-sm">
            <div className="flex items-center gap-3">
              <Avatar className="size-12">
                {selected.avatar_url ? <AvatarImage src={selected.avatar_url} alt="" /> : null}
                <AvatarFallback className="bg-primary/10 text-base font-medium text-primary">{initial(selected)}</AvatarFallback>
              </Avatar>
              {selected.active ? (
                <StatusChip tone={PRESENCE_TONE[getPresence(selected.user_id)]}>{PRESENCE_TEXT[getPresence(selected.user_id)]}</StatusChip>
              ) : (
                <StatusChip tone="mute">Desativado</StatusChip>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <dt className="text-xs font-semibold text-muted-foreground">Papel</dt>
              <dd>
                {selectedCanEdit ? (
                  <Select value={selected.role} onValueChange={(v) => v && void handleRoleChange(selected, v as AccountRole)}>
                    <SelectTrigger className="w-full" disabled={pendingMemberAction === selected.user_id}>
                      <SelectValue>{(value: AccountRole | null) => (value ? ROLE_META[value].label : '')}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {EDITABLE_ROLES.map((r) => (
                        <SelectItem key={r} value={r}>
                          {ROLE_META[r].label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <span className="text-foreground">
                    {ROLE_META[selected.role].label}
                    {selected.role === 'owner' && <span className="ml-1.5 text-xs text-muted-foreground">(a propriedade só muda por transferência)</span>}
                  </span>
                )}
              </dd>
            </div>
            <div className="flex flex-col gap-1.5">
              <dt className="text-xs font-semibold text-muted-foreground">Equipe</dt>
              <dd className="text-foreground">{(selected.team_id && teamNames[selected.team_id]) || 'Sem equipe'}</dd>
            </div>
            <div className="flex flex-col gap-1.5">
              <dt className="text-xs font-semibold text-muted-foreground">Entrou em</dt>
              <dd className="text-foreground">{fmtDate(selected.joined_at)}</dd>
            </div>
            {canManageMembers && (
              <div className="flex flex-col gap-1.5">
                <dt className="text-xs font-semibold text-muted-foreground">Último acesso</dt>
                <dd className="text-foreground">{lastAccessLabel(selected, getPresence(selected.user_id), now)}</dd>
              </div>
            )}
          </dl>
        )}
      </DetailDrawer>

      <AlertDialog open={statusTarget !== null} onOpenChange={(open) => !open && !changingStatus && setStatusTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{statusTarget?.active ? 'Reativar usuário?' : 'Desativar usuário?'}</AlertDialogTitle>
            <AlertDialogDescription>
              {statusTarget?.active
                ? `${statusTarget.member.full_name || 'Este usuário'} volta a poder entrar na conta com o papel que já tinha.`
                : `${statusTarget?.member.full_name || 'Este usuário'} perde o acesso agora: as sessões abertas caem, o login é bloqueado e a pessoa sai da distribuição de conversas. O histórico dela é mantido e você pode reativar depois.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={changingStatus}>Voltar</AlertDialogCancel>
            <Button variant={statusTarget?.active ? 'default' : 'destructive'} onClick={() => void handleChangeStatus()} disabled={changingStatus}>
              {changingStatus ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Aguarde...
                </>
              ) : statusTarget?.active ? (
                'Reativar'
              ) : (
                'Desativar'
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={transferTarget !== null} onOpenChange={(open) => !open && !transferring && setTransferTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Transferir a propriedade da conta?</AlertDialogTitle>
            <AlertDialogDescription>
              {transferTarget?.full_name || 'Este usuário'} passa a ser o proprietário da conta e você passa a ser Administrador. Só o novo proprietário poderá
              desfazer isso.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={transferring}>Voltar</AlertDialogCancel>
            <Button variant="destructive" onClick={() => void handleTransferOwnership()} disabled={transferring}>
              {transferring ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Transferindo...
                </>
              ) : (
                'Transferir propriedade'
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <InviteMemberDialog open={inviteOpen} onOpenChange={setInviteOpen} onCreated={load} />
      <BulkImportMembersDialog open={bulkImportOpen} onOpenChange={setBulkImportOpen} onImported={load} />

      <Dialog open={removingMember !== null} onOpenChange={(open) => !open && setRemovingMember(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-warning" />
              Remover usuário
            </DialogTitle>
            <DialogDescription>
              Remover <span className="font-medium text-foreground">{removingMember?.full_name || 'este usuário'}</span> da conta? A pessoa será
              desconectada desta conta e receberá uma nova conta pessoal no próximo login. O login dela não será excluído.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemovingMember(null)}>
              Cancelar
            </Button>
            <Button variant="destructive" onClick={() => void handleRemove()} disabled={!!pendingMemberAction}>
              {pendingMemberAction ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Removendo...
                </>
              ) : (
                'Remover usuário'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={resetPasswordMember !== null} onOpenChange={(open) => !open && closeResetPasswordDialog()}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="size-4 text-primary" />
              Redefinir senha
            </DialogTitle>
            <DialogDescription>
              Defina uma nova senha para <span className="font-medium text-foreground">{resetPasswordMember?.full_name || 'este usuário'}</span>. A pessoa poderá
              usá-la a partir do próximo login.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="usr-new-pw">Nova senha</Label>
              <Input
                id="usr-new-pw"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder={`Mínimo ${MIN_RESET_PASSWORD_LENGTH} caracteres`}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="usr-confirm-pw">Confirmar senha</Label>
              <Input
                id="usr-confirm-pw"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Repita a senha"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeResetPasswordDialog}>
              Cancelar
            </Button>
            <Button onClick={() => void handleResetPassword()} disabled={resettingPassword}>
              {resettingPassword ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Redefinindo...
                </>
              ) : (
                'Redefinir senha'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageBody>
  );
}
