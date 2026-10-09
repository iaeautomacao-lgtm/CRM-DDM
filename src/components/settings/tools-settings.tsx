'use client';

// Configurações → Ferramentas (migration 176): catálogo de ferramentas HTTP
// reutilizáveis dos agentes de IA, com liga/desliga. Owner/admin criam,
// editam, testam e apagam; supervisor só vê. Credenciais nunca aparecem aqui:
// a ferramenta guarda só marcadores {{cred.NOME}} / {{var.NOME}}.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Pencil, Play, Plus, Trash2, Wrench } from 'lucide-react';

import { apiFetch } from '@/lib/api-fetch';
import { hasMinRole } from '@/lib/auth/roles';
import { useAuth } from '@/hooks/use-auth';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { SettingsPanelHead } from './settings-panel-head';
import { TestDialog, ToolDialog, type ToolItem } from './tool-dialogs';

export function ToolsSettings() {
  const { accountRole } = useAuth();
  const canEdit = !!accountRole && hasMinRole(accountRole, 'admin');

  const [items, setItems] = useState<ToolItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<ToolItem | 'new' | null>(null);
  const [testing, setTesting] = useState<ToolItem | null>(null);

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
      <div className="flex items-center justify-center py-12">
        <Loader2 className="text-primary size-6 animate-spin" />
      </div>
    );
  }

  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead
        title="Ferramentas"
        description={
          <>
            Chamadas HTTP que os agentes de IA podem fazer (consultar CPF, buscar dados). Cadastre uma vez e use em vários
            fluxos; desligue para o agente parar de usar. Para tokens use{' '}
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
        <p className="text-muted-foreground text-sm">Você pode ver as ferramentas. Só owner e admin criam, editam ou testam.</p>
      )}

      {items.length === 0 ? (
        <Card>
          <CardContent className="text-muted-foreground flex flex-col items-center gap-2 py-10 text-sm">
            <Wrench className="size-6" />
            Nenhuma ferramenta cadastrada.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <Card key={item.id}>
              <CardContent className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">{item.display_name || item.name}</span>
                    <code className="text-muted-foreground text-xs">{item.name}</code>
                    <Badge variant="secondary">{item.http.method}</Badge>
                    {!item.enabled && <Badge variant="outline">Desligada</Badge>}
                  </div>
                  <div className="text-muted-foreground mt-1 truncate text-sm">{item.host || '—'}</div>
                  <div className="text-muted-foreground mt-0.5 text-xs">
                    Usada em {item.used_in_flows} fluxo{item.used_in_flows === 1 ? '' : 's'}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={item.enabled}
                    onCheckedChange={(v) => void toggle(item, v)}
                    disabled={!canEdit}
                    aria-label={`${item.enabled ? 'Desligar' : 'Ligar'} ${item.name}`}
                  />
                  {canEdit && (
                    <>
                      <Button variant="outline" size="sm" onClick={() => setTesting(item)}>
                        <Play className="size-4" />
                        Testar
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setEditing(item)}>
                        <Pencil className="size-4" />
                        Editar
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => void remove(item)} aria-label={`Apagar ${item.name}`}>
                        <Trash2 className="size-4" />
                      </Button>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
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
      {testing && <TestDialog item={testing} onClose={() => setTesting(null)} />}
    </section>
  );
}
