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
import { Loader2, LockKeyhole, Pencil, Plus, Trash2 } from 'lucide-react';

import { apiFetch } from '@/lib/api-fetch';
import { hasMinRole } from '@/lib/auth/roles';
import { useAuth } from '@/hooks/use-auth';
import { Badge } from '@/components/ui/badge';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { SettingsPanelHead } from './settings-panel-head';

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
  const { accountRole } = useAuth();
  const canEdit = !!accountRole && hasMinRole(accountRole, 'admin');

  const [items, setItems] = useState<SecretItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<SecretItem | 'new' | null>(null);

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
      <div className="flex items-center justify-center py-12">
        <Loader2 className="text-primary size-6 animate-spin" />
      </div>
    );
  }

  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead
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
        <p className="text-muted-foreground text-sm">
          Você pode ver as variáveis e as credenciais (mascaradas). Só owner e admin criam, editam ou trocam valores.
        </p>
      )}

      {items.length === 0 ? (
        <Card>
          <CardContent className="text-muted-foreground flex flex-col items-center gap-2 py-10 text-sm">
            <LockKeyhole className="size-6" />
            Nenhuma variável ou credencial cadastrada.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <Card key={item.id}>
              <CardContent className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="text-sm font-semibold">{item.name}</code>
                    <Badge variant={item.kind === 'credential' ? 'default' : 'secondary'}>
                      {item.kind === 'credential' ? 'Credencial' : 'Variável'}
                    </Badge>
                  </div>
                  <div className="text-muted-foreground mt-1 truncate text-sm">
                    {item.kind === 'credential' ? (
                      <span className="font-mono">••••{item.last4 ?? ''}</span>
                    ) : (
                      <span className="font-mono">{item.value}</span>
                    )}
                    {item.description ? <span> — {item.description}</span> : null}
                  </div>
                  {item.kind === 'credential' && (
                    <div className="text-muted-foreground mt-0.5 text-xs">
                      Hosts permitidos: {item.allowed_hosts.join(', ')}
                    </div>
                  )}
                  <div className="text-muted-foreground mt-0.5 text-xs">Atualizado em {fmtDate(item.updated_at)}</div>
                </div>
                {canEdit && (
                  <div className="flex gap-1">
                    <Button variant="outline" size="sm" onClick={() => setEditing(item)}>
                      <Pencil className="size-4" />
                      Editar
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => void handleDelete(item)} aria-label={`Apagar ${item.name}`}>
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
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
