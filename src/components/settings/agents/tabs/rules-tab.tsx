import { Plus, ArrowUp, ArrowDown, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import type { AgentFormData } from '../types';

interface RulesTabProps {
  data: AgentFormData;
  onChange: (patch: Partial<AgentFormData>) => void;
  readOnly?: boolean;
}

export function RulesTab({ data, onChange, readOnly }: RulesTabProps) {
  const rules = data.rules;

  function handleAddRule() {
    const newRule = {
      id: `rule-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      content: '',
      enabled: true,
    };
    onChange({ rules: [...rules, newRule] });
  }

  function handleUpdateRule(index: number, content: string) {
    const updated = rules.map((r, i) => (i === index ? { ...r, content } : r));
    onChange({ rules: updated });
  }

  function handleToggleRule(index: number, enabled: boolean) {
    const updated = rules.map((r, i) => (i === index ? { ...r, enabled } : r));
    onChange({ rules: updated });
  }

  function handleRemoveRule(index: number) {
    const updated = rules.filter((_, i) => i !== index);
    onChange({ rules: updated });
  }

  function handleMoveRule(index: number, direction: 'up' | 'down') {
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= rules.length) return;

    const copy = [...rules];
    const temp = copy[index];
    copy[index] = copy[targetIndex];
    copy[targetIndex] = temp;
    onChange({ rules: copy });
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-foreground">Regras de Comportamento</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Diretrizes prioritárias inseridas de forma estruturada no prompt. Use regras para proibições,
            formatos obrigatórios de resposta ou tratativas especiais.
          </p>
        </div>
        {!readOnly && (
          <Button type="button" variant="outline" size="sm" onClick={handleAddRule} className="shrink-0">
            <Plus className="size-3.5 mr-1.5" />
            Adicionar regra
          </Button>
        )}
      </div>

      {rules.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-8 text-center space-y-3">
          <p className="text-sm text-muted-foreground">
            Nenhuma regra adicionada ainda. As regras ajudam a modular e condicionar o comportamento do agente.
          </p>
          {!readOnly && (
            <Button type="button" variant="secondary" size="sm" onClick={handleAddRule}>
              <Plus className="size-3.5 mr-1.5" />
              Adicionar primeira regra
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {rules.map((rule, index) => {
            const isFirst = index === 0;
            const isLast = index === rules.length - 1;

            return (
              <div
                key={rule.id}
                className="group rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary/40 space-y-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-xs font-mono">
                      #{index + 1}
                    </Badge>
                    <span className="text-xs font-medium text-muted-foreground">
                      {rule.enabled ? 'Ativa' : 'Desativada'}
                    </span>
                  </div>

                  <div className="flex items-center gap-1">
                    {!readOnly && (
                      <>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          disabled={isFirst}
                          onClick={() => handleMoveRule(index, 'up')}
                          title="Mover para cima"
                        >
                          <ArrowUp className="size-3.5" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          disabled={isLast}
                          onClick={() => handleMoveRule(index, 'down')}
                          title="Mover para baixo"
                        >
                          <ArrowDown className="size-3.5" />
                        </Button>
                        <div className="h-4 w-px bg-border mx-1" />
                        <div className="flex items-center gap-1.5 mr-1">
                          <Switch
                            id={`rule-toggle-${rule.id}`}
                            checked={rule.enabled}
                            onCheckedChange={(checked) => handleToggleRule(index, checked)}
                            className="scale-90"
                          />
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-7 text-muted-foreground hover:text-destructive"
                          onClick={() => handleRemoveRule(index)}
                          title="Remover regra"
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </>
                    )}
                  </div>
                </div>

                <div>
                  <Textarea
                    value={rule.content}
                    onChange={(e) => handleUpdateRule(index, e.target.value)}
                    placeholder="Ex: Nunca confirme valores de acordo sem antes chamar a ferramenta de cálculo..."
                    rows={2}
                    disabled={readOnly}
                    className="text-sm resize-y"
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
