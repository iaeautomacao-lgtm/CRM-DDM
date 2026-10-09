'use client';

// Configurações → Integrações → Ferramentas (migration 176): catálogo de ferramentas HTTP
// reutilizáveis dos agentes de IA, com liga/desliga. Owner/admin criam,
// editam, testam e apagam; supervisor só vê. Credenciais nunca aparecem aqui:
// a ferramenta guarda só marcadores {{cred.NOME}} / {{var.NOME}}.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Plus, Trash2, Wrench } from 'lucide-react';

import { apiFetch } from '@/lib/api-fetch';
import { usePermission } from '@/hooks/use-permission';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { SettingsPanelHead } from './settings-panel-head';
import { ToolDialog, type ToolItem } from './tool-dialogs';
import { ListCard, ListRow } from '@/components/ddm/list-with-drawer';
import { StatusChip } from '@/components/ddm/status-chip';
import { EmptyState, Skeleton } from '@/components/ddm/states';

export function ToolsSettings() {
  const canEdit = usePermission('ai.tools.edit');

  const [items, setItems] = useState<ToolItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<ToolItem | 'new' | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/settings/tools', { cache: 'no-store' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || 'Não foi possível carregar as ferramentas.');
        return;
      }
      setItems((payload as { tools: ToolItem[] }).tools);
    } catch {
      toast.error('Não foi possível falar com o servidor.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(item: ToolItem, enabled: boolean) {
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, enabled } : i)));
    const res = await apiFetch(`/api/settings/tools/${item.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) {
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, enabled: !enabled } : i)));
      const payload = await res.json().catch(() => ({}));
      toast.error(payload.error || 'Não foi possível alterar.');
      return;
    }
    toast.success(enabled ? `${item.name} ligada` : `${item.name} desligada — o agente deixa de usá-la`);
  }

  async function remove(item: ToolItem, force = false) {
    if (!force && !window.confirm(`Apagar a ferramenta ${item.name}?`)) return;
    const res = await apiFetch(`/api/settings/tools/${item.id}${force ? '?force=true' : ''}`, { method: 'DELETE' });
    if (res.status === 409) {
      const payload = await res.json().catch(() => ({}));
      if (window.confirm(`${payload.error}\n\nApagar mesmo assim?`)) await remove(item, true);
      return;
    }
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      toast.error(payload.error || 'Não foi possível apagar.');
      return;
    }
    toast.success(`${item.name} apagada`);
    setItems((prev) => prev.filter((i) => i.id !== item.id));
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-2" aria-busy>
        <Skeleton className="h-6 w-48" />
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-16 rounded-[10px]" />
        ))}
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-3.5">
      <SettingsPanelHead
        className="mb-0"
        title="Ferramentas dos agentes"
        description={
          <>
            Chamadas HTTP que os agentes de IA podem fazer durante a conversa. Cadastre uma vez e escolha quais cada agente
            usa em Agentes de IA → Ferramentas; desligue para nenhum agente usar. Para tokens use{' '}
            <code className="text-xs">{'{{cred.NOME}}'}</code> (Variáveis e credenciais) — nunca cole o valor aqui.
          </>
        }
        action={
          canEdit ? (
            <Button onClick={() => setEditing('new')}>
              <Plus className="size-4" />
              Nova ferramenta
            </Button>
          ) : undefined
        }
      />

      {!canEdit && (
        <p className="text-sm text-muted-foreground">Você pode ver as ferramentas. Só quem tem permissão cria, edita ou testa.</p>
      )}

      {items.length === 0 ? (
        <EmptyState icon={Wrench} title="Nenhuma ferramenta cadastrada." hint={canEdit ? 'Crie a primeira em “Nova ferramenta”.' : undefined} />
      ) : (
        <ListCard aria-label="Ferramentas dos agentes">
          {items.map((item, i) => (
            <ListRow
              key={item.id}
              index={i}
              label={item.display_name || item.name}
              onSelect={canEdit ? () => setEditing(item) : undefined}
              className={item.enabled ? undefined : 'opacity-80'}
            >
              <Switch
                checked={item.enabled}
                onCheckedChange={(v) => void toggle(item, v)}
                disabled={!canEdit}
                aria-label={`${item.enabled ? 'Desligar' : 'Ligar'} ${item.name}`}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13.5px] font-semibold text-foreground">{item.display_name || item.name}</span>
                  <code className="text-xs text-muted-foreground">{item.name}</code>
                  {!item.enabled && <StatusChip tone="mute">Desligada</StatusChip>}
                </div>
                {item.description && <p className="mt-0.5 line-clamp-2 text-xs text-foreground-2">{item.description}</p>}
                <p className="mt-0.5 text-xs text-muted-foreground md:hidden">
                  <strong className="font-semibold">{item.http.method}</strong> {item.host || '—'} · usada em {item.used_in_flows} fluxo
                  {item.used_in_flows === 1 ? '' : 's'}
                </p>
              </div>
              <span className="hidden w-48 shrink-0 truncate text-xs text-muted-foreground md:inline" title={item.host}>
                <strong className="font-semibold text-foreground-2">{item.http.method}</strong> {item.host || '—'}
              </span>
              <span className="hidden w-28 shrink-0 text-xs text-muted-foreground md:inline">
                Usada em {item.used_in_flows} fluxo{item.used_in_flows === 1 ? '' : 's'}
              </span>
              {canEdit && (
                <div className="flex shrink-0 items-center gap-1">
                  <Button variant="outline" size="sm" onClick={() => setEditing(item)}>
                    Editar
                  </Button>
                  <Button variant="ghost" size="icon-sm" onClick={() => void remove(item)} aria-label={`Apagar ${item.name}`} title="Apagar">
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              )}
            </ListRow>
          ))}
        </ListCard>
      )}

      {editing && (
        <ToolDialog
          item={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </section>
  );
}
