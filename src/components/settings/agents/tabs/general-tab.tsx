import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import type { AgentFormData, AgentUsageItem } from '../types';

interface GeneralTabProps {
  data: AgentFormData;
  onChange: (patch: Partial<AgentFormData>) => void;
  readOnly?: boolean;
  usedIn?: AgentUsageItem[];
}

export function GeneralTab({ data, onChange, readOnly, usedIn = [] }: GeneralTabProps) {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="agent-name" className="text-sm font-medium">
          Nome do Agente <span className="text-destructive">*</span>
        </Label>
        <Input
          id="agent-name"
          value={data.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="Ex: Assistente de Negociação, Especialista em Suporte..."
          disabled={readOnly}
          className="max-w-xl"
        />
        <p className="text-xs text-muted-foreground">
          Identificador do agente exibido no catálogo de agentes e nos nós de IA do Flow Builder.
        </p>
      </div>

      <div className="rounded-[10px] border border-border p-4 space-y-3 max-w-xl">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="agent-enabled" className="text-sm font-medium cursor-pointer">
              Status do Agente
            </Label>
            <p className="text-xs text-muted-foreground">
              {data.enabled
                ? 'Agente ativo e pronto para responder nos fluxos vinculados.'
                : 'Agente desativado. Nós que utilizam este agente seguirão para a rota de falha ou transbordo.'}
            </p>
          </div>
          <Switch
            id="agent-enabled"
            checked={data.enabled}
            onCheckedChange={(checked) => onChange({ enabled: checked })}
            disabled={readOnly}
          />
        </div>
      </div>

      {usedIn.length > 0 && (
        <div className="rounded-[10px] border border-border bg-card-2 p-4 space-y-2 max-w-xl">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Uso em Fluxos
            </span>
            <Badge variant="secondary" className="text-xs">
              {usedIn.length} {usedIn.length === 1 ? 'fluxo' : 'fluxos'}
            </Badge>
          </div>
          <ul className="text-xs text-muted-foreground space-y-1">
            {usedIn.map((item, idx) => (
              <li key={`${item.flow_id}-${item.node_key}-${idx}`} className="flex items-center gap-1.5">
                <span className="size-1.5 rounded-full bg-primary" />
                <span className="font-medium text-foreground">{item.flow_name}</span>
                <span>(nó: <code>{item.node_key}</code>)</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
