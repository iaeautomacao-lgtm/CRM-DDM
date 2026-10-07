import { AlertTriangle, Trash2, Wrench } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type { AgentFormData, ToolCatalogItem } from '../types';

interface ToolsTabProps {
  data: AgentFormData;
  onChange: (patch: Partial<AgentFormData>) => void;
  catalog: ToolCatalogItem[];
  readOnly?: boolean;
}

export function ToolsTab({ data, onChange, catalog, readOnly }: ToolsTabProps) {
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

  function toggleEnabled(toolId: string, enabled: boolean) {
    onChange({ tools: data.tools.map((t) => (t.tool_id === toolId ? { ...t, enabled } : t)) });
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-foreground">Ferramentas do agente</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Escolha quais ferramentas do catálogo este agente pode usar. Desligar uma ferramenta aqui mantém o vínculo,
            mas o agente deixa de usá-la.
          </p>
        </div>
        <a href="/settings?tab=tools" className="text-xs text-primary hover:underline shrink-0">
          Gerenciar catálogo de ferramentas
        </a>
      </div>

      {catalog.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-8 text-center space-y-2">
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
                className="rounded-lg border border-border bg-card p-4 space-y-2 transition-colors hover:border-primary/40"
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
                  <p className="flex items-start gap-1.5 text-xs text-amber-600">
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
        <div className="rounded-lg border border-amber-300/60 bg-amber-50/40 dark:bg-amber-950/10 p-4 space-y-2">
          <p className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-500">
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
    </div>
  );
}
