'use client';

// Configurações → Variáveis e credenciais (migration 175).
//
//  - Variável: texto visível ({{var.NOME}} nas ferramentas).
//  - Credencial: valor cifrado, write-only — nunca volta da API; a tela só
//    mostra "••••1234" e um botão "Substituir" ({{cred.NOME}}, só para os
//    hosts permitidos).
// Owner/admin criam, editam e apagam; supervisor só vê (credenciais
// mascaradas). Agente/viewer nem enxergam a seção (settings-sections.ts).

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Braces, Loader2, LockKeyhole, Pencil, Plus, Search, Trash2 } from 'lucide-react';

import { apiFetch } from '@/lib/api-fetch';
import { usePermission } from '@/hooks/use-permission';
import { Button } from '@/components/ui/button';
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
import { Textarea } from '@/components/ui/textarea';
import { SettingsPanelHead } from './settings-panel-head';
import { ListCard, ListRow } from '@/components/ddm/list-with-drawer';
import { PageToolbar } from '@/components/ddm/page-toolbar';
import { Segmented } from '@/components/ddm/segmented';
import { StatusChip } from '@/components/ddm/status-chip';
import { EmptyState, Skeleton } from '@/components/ddm/states';

interface SecretItem {
  id: string;
  name: string;
  kind: 'variable' | 'credential';
  value?: string;
  last4?: string | null;
  allowed_hosts: string[];
  description: string | null;
  updated_at: string;
}

type KindFilter = 'all' | SecretItem['kind'];

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

function parseHosts(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((h) => h.trim())
    .filter(Boolean);
}

export function SecretsSettings() {
  const canEdit = usePermission('secrets.write');

  const [items, setItems] = useState<SecretItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<SecretItem | 'new' | null>(null);
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/settings/secrets', { cache: 'no-store' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || 'Não foi possível carregar as variáveis e credenciais.');
        return;
      }
      setItems((payload as { secrets: SecretItem[] }).secrets);
    } catch {
      toast.error('Não foi possível falar com o servidor.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleDelete(item: SecretItem) {
    if (
      !window.confirm(
        `Apagar ${item.name}? Ferramentas que usam {{${item.kind === 'credential' ? 'cred' : 'var'}.${item.name}}} vão falhar até você cadastrar de novo.`,
      )
    )
      return;
    const res = await apiFetch(`/api/settings/secrets/${item.id}`, { method: 'DELETE' });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      toast.error(payload.error || 'Não foi possível apagar.');
      return;
    }
    toast.success(`${item.name} apagado`);
    setItems((prev) => prev.filter((i) => i.id !== item.id));
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-2" aria-busy>
        <Skeleton className="h-6 w-56" />
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-14 rounded-[10px]" />
        ))}
      </div>
    );
  }

  const q = query.trim().toLocaleLowerCase('pt-BR');
  const visible = items.filter(
    (i) => (kindFilter === 'all' || i.kind === kindFilter) && (!q || i.name.toLocaleLowerCase('pt-BR').includes(q)),
  );
  const refOf = (item: SecretItem) => `{{${item.kind === 'credential' ? 'cred' : 'var'}.${item.name}}}`;

  async function copyRef(item: SecretItem) {
    try {
      await navigator.clipboard.writeText(refOf(item));
      toast.success(`${refOf(item)} copiado`);
    } catch {
      toast.error('Não foi possível copiar.');
    }
  }

  return (
    <section className="flex flex-col gap-3.5">
      <SettingsPanelHead
        className="mb-0"
        title="Variáveis e credenciais"
        description={
          <>
            Valores da conta usados pelas ferramentas dos agentes de IA, sem colar tokens no fluxo. Use{' '}
            <code className="text-xs">{'{{var.NOME}}'}</code> para variáveis e{' '}
            <code className="text-xs">{'{{cred.NOME}}'}</code> para credenciais na URL, nos headers e no
            body da ferramenta. Credenciais ficam cifradas, nunca voltam para a tela e só são enviadas aos
            hosts permitidos.
          </>
        }
        action={
          canEdit ? (
            <Button onClick={() => setEditing('new')}>
              <Plus className="size-4" />
              Nova
            </Button>
          ) : undefined
        }
      />

      {!canEdit && (
        <p className="text-sm text-muted-foreground">
          Você pode ver as variáveis e as credenciais (mascaradas). Só quem tem permissão cria, edita ou troca valores.
        </p>
      )}

      {items.length > 0 && (
        <PageToolbar>
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar pelo nome"
              aria-label="Buscar variável ou credencial"
              className="h-9 pl-8"
            />
          </div>
          <Segmented<KindFilter>
            ariaLabel="Tipo"
            value={kindFilter}
            onChange={setKindFilter}
            options={[
              { value: 'all', label: 'Todas', count: items.length },
              { value: 'variable', label: 'Variáveis', count: items.filter((i) => i.kind === 'variable').length },
              { value: 'credential', label: 'Credenciais', count: items.filter((i) => i.kind === 'credential').length },
            ]}
          />
        </PageToolbar>
      )}

      {items.length === 0 ? (
        <EmptyState icon={LockKeyhole} title="Nenhuma variável ou credencial cadastrada." />
      ) : visible.length === 0 ? (
        <p className="rounded-[10px] border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          Nada encontrado com esse filtro.
        </p>
      ) : (
        <ListCard aria-label="Variáveis e credenciais">
          {visible.map((item, i) => (
            <ListRow key={item.id} index={i} label={item.name} className="flex-wrap">
              <span
                aria-hidden
                className={
                  item.kind === 'credential'
                    ? 'flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary-text'
                    : 'flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-3 text-muted-foreground'
                }
              >
                {item.kind === 'credential' ? <LockKeyhole className="size-4" /> : <Braces className="size-4" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="text-[13px] font-semibold text-foreground">{item.name}</code>
                  <StatusChip tone={item.kind === 'credential' ? 'brand' : 'mute'} dot={false}>
                    {item.kind === 'credential' ? 'Credencial' : 'Variável'}
                  </StatusChip>
                </div>
                <div className="mt-0.5 truncate text-xs text-muted-foreground">
                  <span className="font-mono">{item.kind === 'credential' ? `••••${item.last4 ?? ''}` : item.value}</span>
                  {item.description ? <span> · {item.description}</span> : null}
                </div>
                {item.kind === 'credential' && item.allowed_hosts.length > 0 && (
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">Hosts: {item.allowed_hosts.join(', ')}</div>
                )}
              </div>
              <span className="hidden text-xs text-muted-foreground lg:inline">Atualizado em {fmtDate(item.updated_at)}</span>
              <button
                type="button"
                onClick={() => void copyRef(item)}
                title="Copiar referência"
                className="hidden h-7 items-center rounded-md border bg-card-2 px-2 font-mono text-[11.5px] text-primary-text hover:bg-surface-hover sm:inline-flex"
              >
                {refOf(item)}
              </button>
              {canEdit && (
                <div className="flex gap-1">
                  <Button variant="ghost" size="icon-sm" onClick={() => setEditing(item)} aria-label={`Editar ${item.name}`} title="Editar">
                    <Pencil className="size-4" />
                  </Button>
                  <Button variant="ghost" size="icon-sm" onClick={() => void handleDelete(item)} aria-label={`Apagar ${item.name}`} title="Apagar">
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              )}
            </ListRow>
          ))}
        </ListCard>
      )}

      {editing && (
        <SecretDialog
          item={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setItems((prev) => {
              const without = prev.filter((i) => i.id !== saved.id);
              return [...without, saved].sort((a, b) => a.name.localeCompare(b.name));
            });
            setEditing(null);
          }}
        />
      )}
    </section>
  );
}

function SecretDialog({
  item,
  onClose,
  onSaved,
}: {
  item: SecretItem | null;
  onClose: () => void;
  onSaved: (saved: SecretItem) => void;
}) {
  const isNew = item === null;
  const [name, setName] = useState(item?.name ?? '');
  const [kind, setKind] = useState<'variable' | 'credential'>(item?.kind ?? 'variable');
  // Variável: valor visível. Credencial: write-only — vazio ao editar mantém o atual.
  const [value, setValue] = useState(item?.kind === 'variable' ? (item.value ?? '') : '');
  const [replacing, setReplacing] = useState(isNew);
  const [hosts, setHosts] = useState((item?.allowed_hosts ?? []).join('\n'));
  const [description, setDescription] = useState(item?.description ?? '');
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const payload: Record<string, unknown> = { description };
      if (isNew) {
        payload.name = name.trim().toUpperCase();
        payload.kind = kind;
      }
      if (kind === 'credential') {
        payload.allowed_hosts = parseHosts(hosts);
        // Edição sem "Substituir": não manda valor (a API mantém o atual).
        if (isNew || replacing) payload.value = value;
      } else {
        payload.value = value;
      }
      const res = await apiFetch(isNew ? '/api/settings/secrets' : `/api/settings/secrets/${item.id}`, {
        method: isNew ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || 'Não foi possível salvar.');
        return;
      }
      toast.success(isNew ? 'Cadastrado' : 'Atualizado');
      onSaved((data as { secret: SecretItem }).secret);
    } catch {
      toast.error('Não foi possível falar com o servidor.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="border-border bg-popover sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isNew ? 'Nova variável ou credencial' : `Editar ${item.name}`}</DialogTitle>
          <DialogDescription>
            {kind === 'credential'
              ? 'O valor é cifrado no servidor e nunca mais aparece na tela.'
              : 'Variáveis são texto comum, visível para quem acessa esta seção.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {isNew && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="secret-name">Nome</Label>
                <Input
                  id="secret-name"
                  value={name}
                  onChange={(e) => setName(e.target.value.toUpperCase())}
                  placeholder="DDM_TOKEN"
                  disabled={saving}
                />
                <p className="text-muted-foreground text-xs">MAIÚSCULAS e sublinhado. Não pode ser alterado depois.</p>
              </div>
              <div className="flex gap-2">
                {(['variable', 'credential'] as const).map((k) => (
                  <Button
                    key={k}
                    type="button"
                    variant={kind === k ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setKind(k)}
                    disabled={saving}
                  >
                    {k === 'variable' ? 'Variável' : 'Credencial'}
                  </Button>
                ))}
              </div>
            </>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="secret-value">Valor</Label>
            {kind === 'credential' && !isNew && !replacing ? (
              <div className="flex items-center gap-2">
                <Input value={`••••${item?.last4 ?? ''}`} disabled readOnly />
                <Button type="button" variant="outline" onClick={() => setReplacing(true)} disabled={saving}>
                  Substituir
                </Button>
              </div>
            ) : (
              <Input
                id="secret-value"
                type={kind === 'credential' ? 'password' : 'text'}
                autoComplete="off"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={kind === 'credential' ? 'Cole o token/chave' : 'Valor'}
                disabled={saving}
              />
            )}
          </div>

          {kind === 'credential' && (
            <div className="space-y-1.5">
              <Label htmlFor="secret-hosts">Hosts permitidos</Label>
              <Textarea
                id="secret-hosts"
                value={hosts}
                onChange={(e) => setHosts(e.target.value)}
                placeholder={'api.exemplo.com\nddmacordos.com'}
                rows={3}
                disabled={saving}
              />
              <p className="text-muted-foreground text-xs">
                Um por linha. A credencial só é enviada para estes domínios (e subdomínios). Obrigatório.
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="secret-desc">Descrição (opcional)</Label>
            <Input
              id="secret-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={300}
              disabled={saving}
            />
          </div>

          <p className="text-muted-foreground bg-muted rounded-md p-2 text-xs">
            Uso nas ferramentas: <code>{kind === 'credential' ? '{{cred.' : '{{var.'}{name || 'NOME'}
              {'}}'}</code>{' '}
            na URL, nos headers ou no body.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
