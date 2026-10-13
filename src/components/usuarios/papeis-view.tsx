'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, Loader2, Lock, Plus, RotateCcw, ShieldCheck, Trash2 } from 'lucide-react';

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
  READ_ONLY_TEXT,
  ROLE_DESCRIPTION_MAX,
  ROLE_NAME_MAX,
  blockedReason,
  compatRoleOf,
  deselectWithDependents,
  differsFromDefault,
  myLevel,
  readOnlyReason,
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
  const { can, me } = usePermissions();
  // Admin e acima criam/editam cargos abaixo do seu nível (roles.manage); o servidor revalida.
  const canManageRoles = can('roles.manage');
  const level = myLevel(me);
  const myPermissions = useMemo(() => new Set<string>(me?.permissions ?? []), [me]);

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

  /** O cargo é o meu? (personalizado: pelo id; de sistema: pela chave, já que o meu `role.id` é nulo.) */
  const isOwnRole = useCallback(
    (r: RoleItem) => (r.kind === 'custom' ? !!me?.role.id && r.id === me.role.id : me?.role.kind === 'system' && r.key === me.role.key),
    [me],
  );

  return (
    <PageBody>
      <div className="flex flex-col gap-1.5 pt-1">
        <h2 className="font-heading text-[28px] font-semibold leading-tight tracking-[-0.025em] text-foreground">Usuários</h2>
        <p className="max-w-[620px] text-sm leading-relaxed text-muted-foreground">
          Cargos de sistema e personalizados. Os cargos controlam o que cada usuário pode fazer.
        </p>
      </div>
      <UsuariosTabs />

      {loadError === 'forbidden' ? (
        <ErrorState title="Você não tem permissão para ver os cargos" hint="Peça a um administrador da organização." />
      ) : loadError === 'error' ? (
        <ErrorState
          title="Não foi possível carregar os cargos"
          onRetry={() => {
            setLoading(true);
            void load();
          }}
        />
      ) : (
        <>
          {!loading && (
            <KpiStrip
              ariaLabel="Resumo dos cargos"
              items={[
                { label: 'Cargos de sistema', value: <CountUp value={roles.filter((r) => r.kind === 'system').length} /> },
                {
                  label: 'Personalizados',
                  value: <CountUp value={customCount} />,
                  note: `de ${maxCustom}`,
                  info: 'Cada organização pode ter até 20 cargos personalizados.',
                },
                {
                  label: 'Ajustados nesta organização',
                  value: <CountUp value={roles.filter((r) => r.kind === 'system' && (r.customized ?? differsFromDefault(r))).length} />,
                  info: 'Cargos de sistema cujas permissões foram alteradas só para esta organização. O padrão global não muda.',
                },
              ]}
            />
          )}

          <PageToolbar
            actions={
              canManageRoles ? (
                <Button onClick={() => setOpenId('new')} disabled={atLimit} title={atLimit ? `Limite de ${maxCustom} cargos personalizados` : undefined}>
                  <Plus className="size-3.5" />
                  Novo cargo
                </Button>
              ) : undefined
            }
          >
            <span className="text-[12.5px] text-muted-foreground">
              {canManageRoles || loading
                ? 'Você edita os cargos abaixo do seu e só concede permissões que você mesmo tem.'
                : 'Você vê os cargos em leitura. Criar e editar cargos é de administradores e do proprietário.'}
            </span>
          </PageToolbar>

          <TableCard label="Cargos">
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
                <EmptyState icon={ShieldCheck} title="Nenhum cargo" />
              </div>
            ) : (
              <DenseTable minWidth={640}>
                <thead>
                  <tr>
                    <Th>Cargo</Th>
                    <Th>Tipo</Th>
                    <Th align="right">Permissões</Th>
                    <Th align="right">Membros</Th>
                    <Th className="hidden md:table-cell">Acesso a dados equivale a</Th>
                  </tr>
                </thead>
                <tbody>
                  {roles.map((r) => {
                    const customized = r.kind === 'system' && (r.customized ?? differsFromDefault(r));
                    return (
                      <Tr
                        key={r.id}
                        className="cursor-pointer"
                        tabIndex={0}
                        aria-label={`Abrir cargo ${r.name}`}
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
                          <span className="flex flex-wrap items-center gap-1.5">
                            <StatusChip tone={r.kind === 'custom' ? 'info' : 'mute'} dot={false}>
                              {r.kind === 'custom' ? 'Personalizado' : 'Sistema'}
                            </StatusChip>
                            {customized && (
                              <StatusChip tone="warn" dot={false}>
                                Ajustado nesta organização
                              </StatusChip>
                            )}
                            {isOwnRole(r) && (
                              <StatusChip tone="brand" dot={false}>
                                Seu cargo
                              </StatusChip>
                            )}
                          </span>
                        </Td>
                        <Td align="right">{r.permissions.length}</Td>
                        <Td align="right">{r.member_count}</Td>
                        <Td className="hidden text-foreground-2 md:table-cell">{r.kind === 'custom' || customized ? ROLE_META[r.compat_role].label : '—'}</Td>
                      </Tr>
                    );
                  })}
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
        canManageRoles={canManageRoles}
        level={level}
        isOwn={openRole ? isOwnRole(openRole) : false}
        myPermissions={myPermissions}
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
  canManageRoles,
  level,
  isOwn,
  myPermissions,
  onClose,
  onChanged,
}: {
  open: boolean;
  role: RoleItem | null;
  isNew: boolean;
  groups: CatalogGroup[];
  catalog: Map<string, CatalogPermission>;
  canManageRoles: boolean;
  level: number;
  isOwn: boolean;
  myPermissions: ReadonlySet<string>;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const isSystem = role?.kind === 'system';
  // Posso editar: cargo novo, ou existente abaixo do meu nível (o servidor manda `editable`). Meu próprio cargo e os de nível igual ou acima: só leitura.
  const reason = role && !isNew ? readOnlyReason(role, level, isOwn) : null;
  const editable = canManageRoles && (isNew || (!!role && reason === null));
  const customized = !!role && isSystem && (role.customized ?? differsFromDefault(role));

  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [selected, setSelected] = useState<Set<string>>(() => new Set(role?.permissions ?? []));
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);

  // Cargo de sistema: só as permissões mudam (nome e descrição são fixos).
  const errors = validateRoleForm({ name: isSystem ? role?.name ?? 'cargo' : name, description: isSystem ? '' : description, permissions: selected });
  const hasErrors = Object.keys(errors).length > 0;
  // Aviso obrigatório (decisão do dono): no acesso direto aos dados o cargo equivale ao cargo de sistema mais baixo que o contém.
  const compat = compatRoleOf(selected);

  const labelOf = (key: string) => catalog.get(key)?.label ?? key;
  /** Só concedo o que eu tenho. */
  const canGrant = (key: string) => myPermissions.has(key);

  function toggle(key: string, checked: boolean) {
    setSelected((prev) => (checked ? selectWithDependencies(prev, key, catalog, canGrant) : deselectWithDependents(prev, key)));
  }

  async function save() {
    setSubmitted(true);
    if (hasErrors) return;
    setSaving(true);
    try {
      const body = isSystem
        ? { permissions: [...selected] }
        : { name: name.trim(), description: description.trim() || (isNew ? undefined : null), permissions: [...selected] };
      const res = await apiFetch(isNew ? '/api/account/roles' : `/api/account/roles/${role?.id}`, {
        method: isNew ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(roleErrorMessage(payload, 'Falha ao salvar o cargo', labelOf));
        return;
      }
      const n = typeof payload.members_updated === 'number' ? payload.members_updated : 0;
      toast.success(
        isNew
          ? 'Cargo criado'
          : n > 0
            ? `Cargo atualizado (${n} membro${n === 1 ? '' : 's'} afetado${n === 1 ? '' : 's'})`
            : 'Cargo atualizado',
      );
      await onChanged();
      onClose();
    } catch (err) {
      console.error('[PapeisView] save error:', err);
      toast.error('Não foi possível conectar ao servidor');
    } finally {
      setSaving(false);
    }
  }

  async function resetToDefault() {
    if (!role) return;
    setResetting(true);
    try {
      const res = await apiFetch(`/api/account/roles/${role.id}/reset`, { method: 'POST' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(roleErrorMessage(payload, 'Falha ao restaurar o padrão', labelOf));
        setConfirmReset(false);
        return;
      }
      toast.success(`Padrão do cargo ${role.name} restaurado`);
      setConfirmReset(false);
      await onChanged();
      onClose();
    } catch (err) {
      console.error('[PapeisView] reset error:', err);
      toast.error('Não foi possível conectar ao servidor');
    } finally {
      setResetting(false);
    }
  }

  async function remove() {
    if (!role) return;
    setDeleting(true);
    try {
      const res = await apiFetch(`/api/account/roles/${role.id}`, { method: 'DELETE' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(roleErrorMessage(payload, 'Falha ao apagar o cargo', labelOf));
        setConfirmDelete(false);
        return;
      }
      toast.success(`Cargo ${role.name} apagado`);
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

  const title = isNew ? 'Novo cargo' : role?.name ?? 'Cargo';
  const canDelete = !isNew && !!role && role.kind === 'custom' && (role.deletable ?? editable);
  const busy = saving || resetting || deleting;

  return (
    <>
      <DetailDrawer
        open={open}
        onOpenChange={(o) => !o && !busy && onClose()}
        title={title}
        description={isNew ? 'Cargo personalizado da organização' : role?.kind === 'custom' ? 'Cargo personalizado' : 'Cargo de sistema'}
        headerExtra={
          customized ? (
            <StatusChip tone="warn" dot={false}>
              Ajustado nesta organização
            </StatusChip>
          ) : undefined
        }
        size="xl"
        footer={
          editable ? (
            <>
              {canDelete && (
                <Button variant="destructive" className="mr-auto" onClick={() => setConfirmDelete(true)} disabled={busy}>
                  <Trash2 className="size-3.5" />
                  Apagar cargo
                </Button>
              )}
              {isSystem && customized && (
                <Button variant="outline" className="mr-auto" onClick={() => setConfirmReset(true)} disabled={busy}>
                  <RotateCcw className="size-3.5" />
                  Restaurar padrão
                </Button>
              )}
              <Button variant="outline" onClick={onClose} disabled={busy}>
                Cancelar
              </Button>
              <Button onClick={() => void save()} disabled={busy}>
                {saving && <Loader2 className="size-4 animate-spin" />}
                {isNew ? 'Criar cargo' : 'Salvar'}
              </Button>
            </>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-5">
          {reason && (
            <div role="status" className="flex items-start gap-2.5 rounded-[10px] border border-border bg-surface-2 px-3.5 py-3">
              <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <p className="text-[13px] text-foreground-2">{READ_ONLY_TEXT[reason]}</p>
            </div>
          )}
          {!reason && !canManageRoles && role && (
            <div role="status" className="flex items-start gap-2.5 rounded-[10px] border border-border bg-surface-2 px-3.5 py-3">
              <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <p className="text-[13px] text-foreground-2">Você vê este cargo em leitura. Editar cargos é de administradores e do proprietário.</p>
            </div>
          )}

          {editable && !isSystem ? (
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

          {editable && isSystem && (
            <p className="text-[13px] text-muted-foreground">
              O ajuste vale só para esta organização: o padrão global do cargo não muda e você pode restaurá-lo quando quiser.
            </p>
          )}

          {editable && (
            <div role="status" className="flex animate-ddm-fade items-start gap-2.5 rounded-[10px] border border-warning-border bg-warning-soft px-3.5 py-3">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
              <p className="text-[13px] text-foreground">
                <span className="font-semibold">No acesso aos dados, este cargo equivale a {ROLE_META[compat].label}.</span>{' '}
                <span className="text-foreground-2">
                  As ações e as rotas seguem exatamente as permissões marcadas; a leitura direta de dados segue o cargo equivalente
                  {compat === 'viewer' ? ' (o Visualizador lê todas as conversas)' : ''}.
                </span>
              </p>
            </div>
          )}

          {!editable && role && (role.kind === 'custom' || customized) && (
            <p className="text-[13px] text-muted-foreground">
              No acesso aos dados, este cargo equivale a <span className="font-semibold text-foreground">{ROLE_META[role.compat_role].label}</span>.
            </p>
          )}

          {editable && (
            <p className="text-xs text-muted-foreground">
              Permissões que você não tem aparecem desabilitadas: você só concede o que você mesmo tem.
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
                      const lacks = !blocked && !canGrant(p.key);
                      const checked = selected.has(p.key);
                      const scope = SCOPE_LABEL[p.scope];
                      const reasonId = `perm-${p.key}-why`;
                      return (
                        <li key={p.key} className="flex items-start gap-3 px-3 py-2.5">
                          {editable && (
                            <Checkbox
                              checked={checked}
                              disabled={!!blocked || lacks || busy}
                              onCheckedChange={(c) => toggle(p.key, c === true)}
                              aria-label={p.label}
                              aria-describedby={blocked || lacks ? reasonId : undefined}
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
                              {editable && lacks && (
                                <StatusChip tone="warn" dot={false}>
                                  Você não tem esta permissão
                                </StatusChip>
                              )}
                            </p>
                            <p className="text-xs text-muted-foreground">{p.description}</p>
                            {editable && (blocked || lacks) && (
                              <p id={reasonId} className="mt-0.5 text-xs text-foreground-2">
                                {blocked === 'Só o proprietário'
                                  ? 'Só o proprietário tem esta permissão.'
                                  : blocked
                                    ? 'Esta permissão ainda não pode ser concedida a cargos.'
                                    : 'Você só concede permissões que você mesmo tem.'}
                              </p>
                            )}
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
            <AlertDialogTitle>Apagar o cargo {role?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {role && role.member_count > 0
                ? `Este cargo está em uso por ${role.member_count} ${role.member_count === 1 ? 'membro' : 'membros'}. Troque o cargo deles antes de apagar.`
                : 'O cargo deixa de existir. Esta ação não pode ser desfeita.'}
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
                'Apagar cargo'
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmReset} onOpenChange={(o) => !o && !resetting && setConfirmReset(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restaurar o padrão do cargo {role?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              As permissões deste cargo voltam ao padrão do sistema nesta organização
              {role && role.member_count > 0
                ? ` e o acesso dos ${role.member_count} ${role.member_count === 1 ? 'membro' : 'membros'} com este cargo é recalculado`
                : ''}
              . O ajuste feito aqui é descartado.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={resetting}>Voltar</AlertDialogCancel>
            <Button onClick={() => void resetToDefault()} disabled={resetting}>
              {resetting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Restaurando...
                </>
              ) : (
                'Restaurar padrão'
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
