'use client';

import { useState } from 'react';
import { AlertTriangle, Play, Plus, Trash2, Wrench } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { TestDialog, ToolDialog, type SavedTool } from '../../tool-dialogs';
import type { AgentFormData, ToolCatalogItem } from '../types';

interface ToolsTabProps {
  data: AgentFormData;
  onChange: (patch: Partial<AgentFormData>) => void;
  catalog: ToolCatalogItem[];
  readOnly?: boolean;
  /** Tem `ai.tools.edit`: pode criar e testar ferramentas do catálogo daqui. */
  canManageTools?: boolean;
  /** Ferramenta recém-criada: entra no catálogo do editor (o vínculo é feito aqui). */
  onToolCreated?: (tool: ToolCatalogItem) => void;
}

export function ToolsTab({ data, onChange, catalog, readOnly, canManageTools, onToolCreated }: ToolsTabProps) {
  const [creating, setCreating] = useState(false);
  const [testing, setTesting] = useState<ToolCatalogItem | null>(null);
  const canCreate = !readOnly && !!canManageTools;
  const selected = new Map(data.tools.map((t) => [t.tool_id, t]));
  const catalogIds = new Set(catalog.map((t) => t.id));
  const orphans = data.tools.filter((t) => !catalogIds.has(t.tool_id));

  function toggleUse(toolId: string, use: boolean) {
    if (use) {
      onChange({ tools: [...data.tools, { tool_id: toolId, enabled: true }] });
    } else {
      onChange({ tools: data.tools.filter((t) => t.tool_id !== toolId) });
    }
  }

  function created(tool: SavedTool) {
    setCreating(false);
    onToolCreated?.({
      id: tool.id,
      name: tool.name,
      display_name: tool.display_name,
      description: tool.description,
      enabled: tool.enabled,
      http: tool.http,
      parameters: tool.parameters,
    });
    // Já vincula ao agente em edição (vale ao publicar a nova versão).
    if (!data.tools.some((t) => t.tool_id === tool.id)) {
      onChange({ tools: [...data.tools, { tool_id: tool.id, enabled: true }] });
    }
  }

  function toggleEnabled(toolId: string, enabled: boolean) {
    onChange({ tools: data.tools.map((t) => (t.tool_id === toolId ? { ...t, enabled } : t)) });
  }

  function toggleLegacy(name: string, enabled: boolean) {
    onChange({ legacyTools: data.legacyTools.map((t) => (t.name === name ? { ...t, enabled } : t)) });
  }

  return (
    <div className="space-y-6">
      {data.legacyTools.length > 0 && (
        <div className="space-y-2 rounded-[10px] border border-border bg-card-2 p-4">
          <h3 className="text-sm font-medium text-foreground">Ferramentas legadas deste agente (vindas do fluxo)</h3>
          <p className="text-xs text-muted-foreground">
            Estas ferramentas vieram da configuração do nó e são preservadas a cada versão. Só dá para ligar ou desligar;
            para editar, cadastre a ferramenta no catálogo.
          </p>
          <div className="space-y-2">
            {data.legacyTools.map((tool) => (
              <div key={tool.name} className="flex items-center justify-between gap-3 rounded-md border border-border bg-card p-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="text-sm font-medium">{tool.name}</code>
                    <Badge variant="secondary">{tool.method}</Badge>
                    <Badge variant="outline">Legada</Badge>
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">{tool.description}</p>
                </div>
                <Switch
                  checked={tool.enabled}
                  onCheckedChange={(v) => toggleLegacy(tool.name, v)}
                  disabled={readOnly}
                  aria-label={`${tool.enabled ? 'Desligar' : 'Ligar'} ${tool.name}`}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-foreground">Ferramentas do agente</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Escolha quais ferramentas do catálogo este agente pode usar. Desligar uma ferramenta aqui mantém o vínculo,
            mas o agente deixa de usá-la.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <a href="/settings?tab=tools" className="text-xs text-primary hover:underline">
            Gerenciar catálogo de ferramentas
          </a>
          {canCreate && (
            <Button type="button" size="sm" onClick={() => setCreating(true)}>
              <Plus className="size-4" />
              Criar ferramenta
            </Button>
          )}
        </div>
      </div>

      {catalog.length === 0 ? (
        <div className="rounded-[10px] border border-dashed border-border p-8 text-center space-y-2">
          <Wrench className="size-5 mx-auto text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            Nenhuma ferramenta cadastrada no catálogo da conta ainda.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {catalog.map((tool) => {
            const link = selected.get(tool.id);
            const used = !!link;
            return (
              <div
                key={tool.id}
                className="rounded-[10px] border border-border bg-card p-4 space-y-2 transition-colors hover:border-border-strong"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <Checkbox
                    id={`tool-use-${tool.id}`}
                    checked={used}
                    onCheckedChange={(v) => toggleUse(tool.id, v === true)}
                    disabled={readOnly}
                    aria-label={`Usar ${tool.name} neste agente`}
                  />
                  <div className="min-w-0 flex-1">
                    <Label htmlFor={`tool-use-${tool.id}`} className="flex flex-wrap items-center gap-2 cursor-pointer">
                      <span className="text-sm font-semibold">{tool.display_name || tool.name}</span>
                      <code className="text-xs text-muted-foreground">{tool.name}</code>
                      {tool.http?.method && <Badge variant="secondary">{tool.http.method}</Badge>}
                      {!tool.enabled && <Badge variant="outline">Desligada no catálogo</Badge>}
                    </Label>
                    {tool.description && (
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{tool.description}</p>
                    )}
                  </div>
                  {canManageTools && tool.parameters && (
                    <Button type="button" variant="outline" size="sm" onClick={() => setTesting(tool)}>
                      <Play className="size-3.5" />
                      Testar
                    </Button>
                  )}
                  {used && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">{link.enabled ? 'Ligada' : 'Desligada'}</span>
                      <Switch
                        checked={link.enabled}
                        onCheckedChange={(v) => toggleEnabled(tool.id, v)}
                        disabled={readOnly}
                        aria-label={`${link.enabled ? 'Desligar' : 'Ligar'} ${tool.name} neste agente`}
                      />
                    </div>
                  )}
                </div>
                {used && !tool.enabled && (
                  <p className="flex items-start gap-1.5 text-xs text-warning">
                    <AlertTriangle className="size-3.5 mt-0.5 shrink-0" />
                    Desligada no catálogo — o agente não a usa. Ligue em Configurações → Ferramentas.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {orphans.length > 0 && (
        <div className="rounded-[10px] border border-warning-border bg-warning-soft p-4 space-y-2">
          <p className="flex items-center gap-1.5 text-xs font-medium text-warning">
            <AlertTriangle className="size-3.5" />
            Ferramentas vinculadas que não existem mais no catálogo
          </p>
          {orphans.map((t) => (
            <div key={t.tool_id} className="flex items-center justify-between gap-2 text-xs">
              <code className="text-muted-foreground truncate">{t.tool_id}</code>
              {!readOnly && (
                <Button type="button" variant="ghost" size="sm" onClick={() => toggleUse(t.tool_id, false)}>
                  <Trash2 className="size-3.5 mr-1" />
                  Remover
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      {creating && (
        <ToolDialog
          item={null}
          description="Ao salvar, ela já fica vinculada a este agente (vale ao publicar a nova versão)."
          onClose={() => setCreating(false)}
          onSaved={created}
        />
      )}
      {testing?.parameters && (
        <TestDialog
          item={{ id: testing.id, name: testing.name, parameters: testing.parameters }}
          onClose={() => setTesting(null)}
        />
      )}
    </div>
  );
}
