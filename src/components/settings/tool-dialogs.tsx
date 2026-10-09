'use client';

// Formulário de criação/edição e teste de ferramenta de IA (catálogo, migration 176), no padrão do redesenho DDM:
// gaveta à direita com as abas "Definição" e "Testar" (protótipo Integracoes.dc.html). Compartilhado por
// Configurações → Integrações → Ferramentas e pela aba Ferramentas do editor do agente ("Criar ferramenta").
// Credenciais nunca aparecem: só marcadores {{cred.NOME}}.

import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Play } from 'lucide-react';

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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DetailDrawer } from '@/components/ddm/list-with-drawer';
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

const TAB_CLASS =
  'flex-none px-0 pb-2.5 pt-1 text-[13px] data-active:text-foreground after:bg-primary after:!bottom-[-1px]';

/** Gaveta de criar/editar ferramenta. Para ferramenta já salva, a aba "Testar" chama a de verdade. */
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
  const [tab, setTab] = useState<'definition' | 'test'>('definition');

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

  const showTest = !isNew && tab === 'test';

  return (
    <DetailDrawer
      open
      onOpenChange={(open) => !open && !saving && onClose()}
      title={isNew ? 'Nova ferramenta' : item.display_name || item.name}
      description={`A URL precisa ser https. Não cole tokens: use {{cred.NOME}} (cadastre em Variáveis e credenciais).${description ? ` ${description}` : ''}`}
      size="xl"
      footer={
        showTest ? (
          <Button variant="outline" onClick={onClose}>
            Fechar
          </Button>
        ) : (
          <>
            <Button variant="outline" onClick={onClose} disabled={saving}>
              Cancelar
            </Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              {isNew ? 'Criar ferramenta' : 'Salvar'}
            </Button>
          </>
        )
      }
    >
      {!isNew && (
        <Tabs value={tab} onValueChange={(v) => setTab(v as 'definition' | 'test')} className="mb-4">
          <div className="border-b">
            <TabsList variant="line" className="h-auto justify-start gap-5 p-0">
              <TabsTrigger value="definition" className={TAB_CLASS}>
                Definição
              </TabsTrigger>
              <TabsTrigger value="test" className={TAB_CLASS}>
                Testar
              </TabsTrigger>
            </TabsList>
          </div>
        </Tabs>
      )}
      {showTest ? (
        <div className="animate-ddm-fade">
          <ToolTestPanel item={{ id: item.id, name: item.name, parameters: item.parameters }} />
        </div>
      ) : (
        <div className="animate-ddm-fade flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tool-display">Nome de exibição</Label>
            <Input id="tool-display" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Buscar CPF" maxLength={80} disabled={saving} />
          </div>
          <AiToolEditor tool={tool} onChange={setTool} showTimeout lockName={!isNew} />
        </div>
      )}
    </DetailDrawer>
  );
}

type TestResult = { ok: boolean; status?: number; body?: string; error?: string };

/** Formulário de teste (argumentos + resultado), usado na gaveta e no diálogo de teste. */
export function ToolTestPanel({ item }: { item: Pick<ToolItem, 'id' | 'name' | 'parameters'> }) {
  const props = Object.keys(item.parameters.properties ?? {});
  const [args, setArgs] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);

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
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Chama a ferramenta de verdade. Mostramos só o status HTTP e o início da resposta (credenciais nunca aparecem).
      </p>
      {props.map((p) => (
        <div key={p} className="flex flex-col gap-1">
          <Label htmlFor={`arg-${p}`}>{p}</Label>
          <Input
            id={`arg-${p}`}
            value={args[p] ?? ''}
            placeholder="(vazio = valor de exemplo)"
            onChange={(e) => setArgs((a) => ({ ...a, [p]: e.target.value }))}
            disabled={running}
          />
        </div>
      ))}
      <Button onClick={() => void run()} disabled={running} className="self-start">
        {running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
        Executar teste
      </Button>
      {result && (
        <div
          role="status"
          className={
            result.error || !result.ok
              ? 'rounded-lg border border-destructive/40 bg-danger-soft p-2.5 text-xs'
              : 'rounded-lg border bg-card-2 p-2.5 text-xs'
          }
        >
          {result.error ? (
            <span className="text-destructive">{result.error}</span>
          ) : (
            <>
              <div className={result.ok ? 'font-semibold text-success' : 'font-semibold text-destructive'}>
                HTTP {result.status} {result.ok ? '— ok' : '— erro'}
              </div>
              <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-all text-foreground">{result.body}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function TestDialog({
  item,
  onClose,
}: {
  item: Pick<ToolItem, 'id' | 'name' | 'parameters'>;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Testar {item.name}</DialogTitle>
          <DialogDescription>Execução real da ferramenta com argumentos de exemplo ou os que você preencher.</DialogDescription>
        </DialogHeader>
        <ToolTestPanel item={item} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Fechar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
