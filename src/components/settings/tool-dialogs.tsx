'use client';

// Formulário de criação/edição e teste de ferramenta de IA (catálogo, migration 176).
// Compartilhado por Configurações → Ferramentas e pela aba Ferramentas do editor do
// agente ("Criar ferramenta"). Credenciais nunca aparecem: só marcadores {{cred.NOME}}.

import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

import { apiFetch } from '@/lib/api-fetch';
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
import { AiToolEditor } from '@/components/flows/forms/ai-tool-editor';
import type { AiAgentTool } from '@/lib/flows/types';

export interface ToolItem {
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

/** Ferramenta como o POST/PATCH de /api/settings/tools devolve (sem host/uso). */
export type SavedTool = Omit<ToolItem, 'host' | 'used_in_flows'>;

const emptyTool = (): AiAgentTool => ({
  name: '',
  description: '',
  parameters: { type: 'object', properties: {}, required: [] },
  http: { url: '', method: 'GET', headers: {}, body: '' },
  timeout_ms: 30000,
});

export function ToolDialog({
  item,
  onClose,
  onSaved,
  description,
}: {
  item: ToolItem | null;
  onClose: () => void;
  onSaved: (tool: SavedTool) => void;
  /** Texto extra abaixo do aviso de https/credenciais (ex.: "será vinculada a este agente"). */
  description?: string;
}) {
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
      onSaved(data.tool as SavedTool);
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
            {description ? ` ${description}` : ''}
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

export function TestDialog({
  item,
  onClose,
}: {
  item: Pick<ToolItem, 'id' | 'name' | 'parameters'>;
  onClose: () => void;
}) {
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
