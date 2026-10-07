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
import { Switch } from '@/components/ui/switch';
import { AiToolEditor } from '@/components/flows/forms/ai-tool-editor';
import type { AiAgentTool } from '@/lib/flows/types';
import { SettingsPanelHead } from './settings-panel-head';

interface ToolItem {
  id: string;
  name: string;
  display_name: string;
  description: string;
  parameters: AiAgentTool['parameters'];
  http: AiAgentTool['http'];
  timeout_ms: number;
  enabled: boolean;
  host: string;
  used_in_flows: number;
  updated_at: string;
}

const emptyTool = (): AiAgentTool => ({
  name: '',
  description: '',
  parameters: { type: 'object', properties: {}, required: [] },
  http: { url: '', method: 'GET', headers: {}, body: '' },
  timeout_ms: 30000,
});

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

function ToolDialog({ item, onClose, onSaved }: { item: ToolItem | null; onClose: () => void; onSaved: () => void }) {
  const isNew = item === null;
  const [tool, setTool] = useState<AiAgentTool>(
    item
      ? { name: item.name, description: item.description, parameters: item.parameters, http: { headers: {}, ...item.http }, timeout_ms: item.timeout_ms }
      : emptyTool(),
  );
  const [displayName, setDisplayName] = useState(item?.display_name ?? '');
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const payload = {
        name: tool.name,
        display_name: displayName || tool.name,
        description: tool.description,
        parameters: tool.parameters,
        http: tool.http,
        timeout_ms: tool.timeout_ms ?? 30000,
      };
      const res = await apiFetch(isNew ? '/api/settings/tools' : `/api/settings/tools/${item.id}`, {
        method: isNew ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || 'Não foi possível salvar.');
        return;
      }
      if (Array.isArray(data.warnings) && data.warnings.length > 0) {
        toast.warning(`Salva, mas ${data.warnings.join(', ')} não existe(m) em Variáveis e credenciais.`);
      } else {
        toast.success(isNew ? 'Ferramenta criada' : 'Ferramenta atualizada');
      }
      onSaved();
    } catch {
      toast.error('Não foi possível falar com o servidor.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="border-border bg-popover max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isNew ? 'Nova ferramenta' : `Editar ${item.name}`}</DialogTitle>
          <DialogDescription>
            A URL precisa ser https. Não cole tokens: use {'{{cred.NOME}}'} (cadastre em Variáveis e credenciais).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="tool-display">Nome de exibição</Label>
            <Input id="tool-display" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Buscar CPF" maxLength={80} disabled={saving} />
          </div>
          <AiToolEditor tool={tool} onChange={setTool} showTimeout lockName={!isNew} />
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

function TestDialog({ item, onClose }: { item: ToolItem; onClose: () => void }) {
  const props = Object.keys(item.parameters.properties ?? {});
  const [args, setArgs] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; status?: number; body?: string; error?: string } | null>(null);

  async function run() {
    setRunning(true);
    setResult(null);
    try {
      const provided = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== ''));
      const res = await apiFetch(`/api/settings/tools/${item.id}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ arguments: provided }),
      });
      setResult(await res.json().catch(() => ({ ok: false, error: 'Resposta inválida.' })));
    } catch {
      setResult({ ok: false, error: 'Não foi possível falar com o servidor.' });
    } finally {
      setRunning(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !running && onClose()}>
      <DialogContent className="border-border bg-popover sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Testar {item.name}</DialogTitle>
          <DialogDescription>
            Chama a ferramenta de verdade. Mostramos só o status HTTP e o início da resposta (credenciais nunca aparecem).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {props.map((p) => (
            <div key={p} className="space-y-1">
              <Label htmlFor={`arg-${p}`}>{p}</Label>
              <Input id={`arg-${p}`} value={args[p] ?? ''} placeholder="(vazio = valor de exemplo)" onChange={(e) => setArgs((a) => ({ ...a, [p]: e.target.value }))} disabled={running} />
            </div>
          ))}
          {result && (
            <div className="bg-muted rounded-md p-2 text-xs">
              {result.error ? (
                <span className="text-destructive">{result.error}</span>
              ) : (
                <>
                  <div className="font-semibold">
                    HTTP {result.status} {result.ok ? '— ok' : '— erro'}
                  </div>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all">{result.body}</pre>
                </>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={running}>
            Fechar
          </Button>
          <Button onClick={() => void run()} disabled={running}>
            {running && <Loader2 className="size-4 animate-spin" />}
            Executar teste
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
