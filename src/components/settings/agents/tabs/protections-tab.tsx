import { ShieldCheck } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type { AgentFormData } from '../types';

interface ProtectionsTabProps {
  data: AgentFormData;
  onChange: (patch: Partial<AgentFormData>) => void;
  readOnly?: boolean;
}

const PROTECTIONS: Array<{ key: keyof AgentFormData['protections']; label: string; help: string }> = [
  {
    key: 'anti_xingamento',
    label: 'Anti-xingamento',
    help: 'Quando o cliente xinga ou tenta manipular o agente, a conversa vai para a fila humana da equipe em vez de ser respondida pela IA.',
  },
  {
    key: 'anti_loop',
    label: 'Anti-loop',
    help: 'Detecta quando o bot já mandou várias mensagens seguidas em pouco tempo (possível loop com outro robô) e transfere para a fila humana.',
  },
  {
    key: 'pedido_humano_contestacao',
    label: 'Pedido de humano / contestação',
    help: 'Quando o cliente pede um atendente ou contesta a dívida, a conversa é encaminhada à equipe com o motivo correspondente.',
  },
  {
    key: 'pessoa_errada',
    label: 'Pessoa errada',
    help: 'Quando o cliente diz que não é a pessoa procurada, o agente encerra a abordagem com a resposta apropriada.',
  },
];

export function ProtectionsTab({ data, onChange, readOnly }: ProtectionsTabProps) {
  return (
    <div className="space-y-4 max-w-2xl">
      <div>
        <h3 className="text-sm font-medium text-foreground">Proteções</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          Travas automáticas aplicadas antes de o agente responder. Todas vêm ligadas por padrão.
        </p>
      </div>

      {PROTECTIONS.map((p) => (
        <div key={p.key} className="flex items-start justify-between gap-4 rounded-lg border border-border p-4">
          <div className="space-y-0.5">
            <Label htmlFor={`prot-${p.key}`} className="text-sm font-medium cursor-pointer">
              {p.label}
            </Label>
            <p className="text-xs text-muted-foreground">{p.help}</p>
          </div>
          <Switch
            id={`prot-${p.key}`}
            checked={data.protections[p.key]}
            onCheckedChange={(v) => onChange({ protections: { ...data.protections, [p.key]: v } })}
            disabled={readOnly}
          />
        </div>
      ))}

      <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-4">
        <ShieldCheck className="size-4 mt-0.5 text-primary shrink-0" />
        <div className="space-y-0.5">
          <p className="text-sm font-medium text-foreground">Opt-out é sempre aplicado</p>
          <p className="text-xs text-muted-foreground">
            Quando o cliente pede para não receber mais mensagens, isso é sempre respeitado — não é uma opção do
            agente e não pode ser desligado.
          </p>
        </div>
      </div>
    </div>
  );
}
