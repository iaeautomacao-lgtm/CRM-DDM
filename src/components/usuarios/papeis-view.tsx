'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, Loader2, Plus, ShieldCheck, Trash2 } from 'lucide-react';

import { apiFetch } from '@/lib/api-fetch';
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
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/dashboard/empty-state';
import { ErrorState } from '@/components/dashboard/error-state';
import { CountUp } from '@/components/motion/count-up';
import { KpiStrip } from '@/components/ddm/kpi-strip';
import { PageBody, PageToolbar } from '@/components/ddm/page-toolbar';
import { StatusChip } from '@/components/ddm/status-chip';
import { CellMain, DenseTable, TableCard, Td, Th, Tr } from '@/components/ddm/table-card';
import { DetailDrawer } from '@/components/ddm/list-with-drawer';
import { usePermissions } from '@/hooks/use-permission';
import { ROLE_META } from '@/components/settings/role-meta';
import { UsuariosTabs } from './usuarios-tabs';
import {
  ROLE_DESCRIPTION_MAX,
  ROLE_NAME_MAX,
  blockedReason,
  compatRoleOf,
  deselectWithDependents,
  roleErrorMessage,
  selectWithDependencies,
  validateRoleForm,
  type CatalogGroup,
  type CatalogPermission,
  type RoleItem,
} from '@/lib/roles/editor';

interface RolesPayload {
  roles: RoleItem[];
  limits: { max_custom_roles: number; custom_roles: number };
}

const SCOPE_LABEL: Record<CatalogPermission['scope'], string | null> = {
  account: 'Toda a organização',
  team: 'Das equipes',
  own: 'Só as próprias',
  'n/a': null,
};

export function PapeisView() {
  const { can } = usePermissions();
  // Só o proprietário cria, edita, apaga e atribui (roles.manage); o servidor revalida.
  const canManageRoles = can('roles.manage');

  const [data, setData] = useState<RolesPayload | null>(null);
  const [groups, setGroups] = useState<CatalogGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<'forbidden' | 'error' | null>(null);

  const [openId, setOpenId] = useState<string | 'new' | null>(null);

  const load = useCallback(async () => {
    try {
      const [rres, cres] = await Promise.all([
        apiFetch('/api/account/roles', { cache: 'no-store' }),
        apiFetch('/api/account/permission-catalog', { cache: 'no-store' }),
      ]);
      if (!rres.ok || !cres.ok) {
        setLoadError(rres.status === 403 || cres.status === 403 ? 'forbidden' : 'error');
        return;
      }
      setData((await rres.json()) as RolesPayload);
      setGroups(((await cres.json()) as { groups: CatalogGroup[] }).groups);
      setLoadError(null);
    } catch (err) {
      console.error('[PapeisView] load error:', err);
      setLoadError('error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const catalog = useMemo(
    () => new Map<string, CatalogPermission>(groups.flatMap((g) => g.permissions.map((p) => [p.key, p] as const))),
    [groups],
  );

  const roles = data?.roles ?? [];
  const customCount = data?.limits.custom_roles ?? 0;
  const maxCustom = data?.limits.max_custom_roles ?? 20;
  const atLimit = customCount >= maxCustom;
  const openRole = openId && openId !== 'new' ? roles.find((r) => r.id === openId) ?? null : null;

  return (
    <PageBody>
      <div className="flex flex-col gap-1.5 pt-1">
        <h2 className="font-heading text-[28px] font-semibold leading-tight tracking-[-0.025em] text-foreground">Usuários</h2>
        <p className="max-w-[620px] text-sm leading-relaxed text-muted-foreground">
          Papéis de sistema e personalizados. Os papéis controlam o que cada usuário pode fazer.
        </p>
      </div>
      <UsuariosTabs />

      {loadError === 'forbidden' ? (
        <ErrorState title="Você não tem permissão para ver os papéis" hint="Peça a um administrador da organização." />
      ) : loadError === 'error' ? (
        <ErrorState
          title="Não foi possível carregar os papéis"
          onRetry={() => {
            setLoading(true);
            void load();
          }}
        />
      ) : (
        <>
          {!loading && (
            <KpiStrip
              ariaLabel="Resumo dos papéis"
              items={[
                { label: 'Papéis de sistema', value: <CountUp value={roles.filter((r) => r.kind === 'system').length} /> },
                {
                  label: 'Personalizados',
                  value: <CountUp value={customCount} />,
                  note: `de ${maxCustom}`,
                  info: 'Cada organização pode ter até 20 papéis personalizados.',
                },
              ]}
            />
          )}

          <PageToolbar
            actions={
              canManageRoles ? (
                <Button onClick={() => setOpenId('new')} disabled={atLimit} title={atLimit ? `Limite de ${maxCustom} papéis personalizados` : undefined}>
                  <Plus className="size-3.5" />
                  Novo papel
                </Button>
              ) : undefined
            }
          >
            {!canManageRoles && !loading && (
              <span className="text-[12.5px] text-muted-foreground">Só o proprietário cria, edita e atribui papéis personalizados.</span>
            )}
          </PageToolbar>

          <TableCard label="Papéis">
            {loading ? (
              <div className="flex flex-col" aria-busy="true">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="flex items-center gap-3 border-b border-border px-[18px] py-3.5" aria-hidden="true">
                    <Skeleton className="h-3 w-40" />
                    <Skeleton className="ml-auto h-5 w-24 rounded-full" />
                  </div>
                ))}
              </div>
            ) : roles.length === 0 ? (
              <div className="p-4">
                <EmptyState icon={ShieldCheck} title="Nenhum papel" />
              </div>
            ) : (
              <DenseTable minWidth={640}>
                <thead>
                  <tr>
                    <Th>Papel</Th>
                    <Th>Tipo</Th>
                    <Th align="right">Permissões</Th>
                    <Th align="right">Membros</Th>
                    <Th className="hidden md:table-cell">Acesso a dados equivale a</Th>
                  </tr>
                </thead>
                <tbody>
                  {roles.map((r) => (
                    <Tr
                      key={r.id}
                      className="cursor-pointer"
                      tabIndex={0}
                      aria-label={`Abrir papel ${r.name}`}
                      onClick={() => setOpenId(r.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setOpenId(r.id);
                        }
                      }}
                    >
                      <Td>
                        <CellMain title={r.name} sub={r.description} />
                      </Td>
                      <Td>
                        <StatusChip tone={r.kind === 'custom' ? 'info' : 'mute'} dot={false}>
                          {r.kind === 'custom' ? 'Personalizado' : 'Sistema'}
                        </StatusChip>
                      </Td>
                      <Td align="right">{r.permissions.length}</Td>
                      <Td align="right">{r.member_count}</Td>
                      <Td className="hidden text-foreground-2 md:table-cell">{r.kind === 'custom' ? ROLE_META[r.compat_role].label : '—'}</Td>
                    </Tr>
                  ))}
                </tbody>
              </DenseTable>
            )}
          </TableCard>
        </>
      )}

      <RoleDrawer
        key={openId ?? 'closed'}
        open={openId !== null}
        role={openRole}
        isNew={openId === 'new'}
        groups={groups}
        catalog={catalog}
        canEdit={canManageRoles}
        onClose={() => setOpenId(null)}
        onChanged={async () => {
          await load();
        }}
      />
    </PageBody>
  );
}

function RoleDrawer({
  open,
  role,
  isNew,
  groups,
  catalog,
  canEdit,
  onClose,
  onChanged,
}: {
  open: boolean;
  role: RoleItem | null;
  isNew: boolean;
  groups: CatalogGroup[];
  catalog: Map<string, CatalogPermission>;
  canEdit: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  // Só papel personalizado se edita; o de sistema é somente leitura.
  const editable = canEdit && (isNew || role?.kind === 'custom');
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [selected, setSelected] = useState<Set<string>>(() => new Set(role?.permissions ?? []));
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const errors = validateRoleForm({ name, description, permissions: selected });
  const hasErrors = Object.keys(errors).length > 0;
  // Aviso obrigatório (decisão do dono): no acesso direto aos dados o papel equivale ao papel de sistema mais baixo que o contém.
  const compat = compatRoleOf(selected);

  function toggle(key: string, checked: boolean) {
    setSelected((prev) => (checked ? selectWithDependencies(prev, key, catalog) : deselectWithDependents(prev, key)));
  }

  async function save() {
    setSubmitted(true);
    if (hasErrors) return;
    setSaving(true);
    try {
      const body = { name: name.trim(), description: description.trim() || (isNew ? undefined : null), permissions: [...selected] };
      const res = await apiFetch(isNew ? '/api/account/roles' : `/api/account/roles/${role?.id}`, {
        method: isNew ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(roleErrorMessage(payload, 'Falha ao salvar o papel'));
        return;
      }
      const changed = typeof payload.members_updated === 'number' && payload.members_updated > 0;
      toast.success(isNew ? 'Papel criado' : changed ? `Papel atualizado (${payload.members_updated} membro${payload.members_updated === 1 ? '' : 's'} afetado${payload.members_updated === 1 ? '' : 's'})` : 'Papel atualizado');
      await onChanged();
      onClose();
    } catch (err) {
      console.error('[PapeisView] save error:', err);
      toast.error('Não foi possível conectar ao servidor');
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!role) return;
    setDeleting(true);
    try {
      const res = await apiFetch(`/api/account/roles/${role.id}`, { method: 'DELETE' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(roleErrorMessage(payload, 'Falha ao apagar o papel'));
        setConfirmDelete(false);
        return;
      }
      toast.success(`Papel ${role.name} apagado`);
      setConfirmDelete(false);
      await onChanged();
      onClose();
    } catch (err) {
      console.error('[PapeisView] delete error:', err);
      toast.error('Não foi possível conectar ao servidor');
    } finally {
      setDeleting(false);
    }
  }

  const title = isNew ? 'Novo papel' : role?.name ?? 'Papel';

  return (
    <>
      <DetailDrawer
        open={open}
        onOpenChange={(o) => !o && !saving && onClose()}
        title={title}
        description={isNew ? 'Papel personalizado da organização' : role?.kind === 'custom' ? 'Papel personalizado' : 'Papel de sistema (somente leitura)'}
        size="xl"
        footer={
          editable ? (
            <>
              {!isNew && (
                <Button variant="destructive" className="mr-auto" onClick={() => setConfirmDelete(true)} disabled={saving}>
                  <Trash2 className="size-3.5" />
                  Apagar papel
                </Button>
              )}
              <Button variant="outline" onClick={onClose} disabled={saving}>
                Cancelar
              </Button>
              <Button onClick={() => void save()} disabled={saving}>
                {saving && <Loader2 className="size-4 animate-spin" />}
                {isNew ? 'Criar papel' : 'Salvar'}
              </Button>
            </>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-5">
          {editable ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="role-name">Nome</Label>
                <Input
                  id="role-name"
                  value={name}
                  maxLength={ROLE_NAME_MAX}
                  onChange={(e) => setName(e.target.value)}
                  aria-invalid={(submitted && !!errors.name) || undefined}
                  placeholder="Ex.: Qualidade"
                />
                {submitted && errors.name && <p className="text-xs text-danger">{errors.name}</p>}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="role-description">Descrição (opcional)</Label>
                <Textarea
                  id="role-description"
                  value={description}
                  maxLength={ROLE_DESCRIPTION_MAX}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                />
                {submitted && errors.description && <p className="text-xs text-danger">{errors.description}</p>}
              </div>
            </>
          ) : role?.description ? (
            <p className="text-sm text-muted-foreground">{role.description}</p>
          ) : null}

          {editable && (
            <div role="status" className="flex animate-ddm-fade items-start gap-2.5 rounded-[10px] border border-warning-border bg-warning-soft px-3.5 py-3">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
              <p className="text-[13px] text-foreground">
                <span className="font-semibold">No acesso aos dados, este papel equivale a {ROLE_META[compat].label}.</span>{' '}
                <span className="text-foreground-2">
                  As ações e as rotas seguem exatamente as permissões marcadas; a leitura direta de dados segue o papel equivalente
                  {compat === 'viewer' ? ' (o Visualizador lê todas as conversas)' : ''}.
                </span>
              </p>
            </div>
          )}

          {!editable && role?.kind === 'custom' && (
            <p className="text-[13px] text-muted-foreground">
              No acesso aos dados, este papel equivale a <span className="font-semibold text-foreground">{ROLE_META[role.compat_role].label}</span>.{' '}
              Só o proprietário edita papéis personalizados.
            </p>
          )}

          {submitted && errors.permissions && <p className="text-xs text-danger">{errors.permissions}</p>}

          <div className="flex flex-col gap-5">
            {groups.map((g) => {
              const visible = editable ? g.permissions : g.permissions.filter((p) => selected.has(p.key));
              if (visible.length === 0) return null;
              return (
                <section key={g.key} aria-label={g.label} className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g.label}</h3>
                  <ul className="divide-y divide-border overflow-hidden rounded-[10px] border border-border">
                    {visible.map((p) => {
                      const blocked = blockedReason(p);
                      const checked = selected.has(p.key);
                      const scope = SCOPE_LABEL[p.scope];
                      return (
                        <li key={p.key} className="flex items-start gap-3 px-3 py-2.5">
                          {editable && (
                            <Checkbox
                              checked={checked}
                              disabled={!!blocked || saving}
                              onCheckedChange={(c) => toggle(p.key, c === true)}
                              aria-label={p.label}
                              className="mt-0.5"
                            />
                          )}
                          <div className="min-w-0 flex-1">
                            <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-foreground">
                              {p.label}
                              {scope && (
                                <StatusChip tone="mute" dot={false}>
                                  {scope}
                                </StatusChip>
                              )}
                              {editable && blocked && (
                                <StatusChip tone="warn" dot={false}>
                                  {blocked}
                                </StatusChip>
                              )}
                            </p>
                            <p className="text-xs text-muted-foreground">{p.description}</p>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>
        </div>
      </DetailDrawer>

      <AlertDialog open={confirmDelete} onOpenChange={(o) => !o && !deleting && setConfirmDelete(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apagar o papel {role?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {role && role.member_count > 0
                ? `Este papel está em uso por ${role.member_count} ${role.member_count === 1 ? 'membro' : 'membros'}. Troque o papel deles antes de apagar.`
                : 'O papel deixa de existir. Esta ação não pode ser desfeita.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Voltar</AlertDialogCancel>
            <Button variant="destructive" onClick={() => void remove()} disabled={deleting}>
              {deleting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Apagando...
                </>
              ) : (
                'Apagar papel'
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
