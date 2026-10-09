import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { KNOWN_AI_EXIT_TAGS } from '@/lib/ai/exit-tags';
import type { AgentFormData } from '../types';

interface BehaviorTabProps {
  data: AgentFormData;
  onChange: (patch: Partial<AgentFormData>) => void;
  readOnly?: boolean;
}

const MODES: Array<{ value: AgentFormData['behavior']['mode']; label: string; help: string }> = [
  { value: 'once', label: 'Uma resposta', help: 'Responde uma vez e segue o fluxo.' },
  { value: 'loop', label: 'Conversa (loop)', help: 'Conversa por até o máximo de turnos, saindo quando o agente sinaliza.' },
  { value: 'takeover', label: 'Assume a conversa', help: 'Assume a conversa até uma tag de saída ou handoff.' },
];

function intValue(raw: string, min: number): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) ? Math.max(min, n) : min;
}

export function BehaviorTab({ data, onChange, readOnly }: BehaviorTabProps) {
  const b = data.behavior;
  const r = data.recovery;
  const setB = (p: Partial<AgentFormData['behavior']>) => onChange({ behavior: { ...b, ...p } });
  const setR = (p: Partial<AgentFormData['recovery']>) => onChange({ recovery: { ...r, ...p } });
  const mode = MODES.find((m) => m.value === b.mode);
  const tags = KNOWN_AI_EXIT_TAGS.includes(r.integration_failure_tag)
    ? KNOWN_AI_EXIT_TAGS
    : [...KNOWN_AI_EXIT_TAGS, r.integration_failure_tag];

  return (
    <div className="space-y-8 max-w-2xl">
      <section className="space-y-4">
        <h3 className="text-sm font-medium text-foreground">Comportamento</h3>
        <div className="space-y-2">
          <Label className="text-sm font-medium">Modo</Label>
          <Select value={b.mode} onValueChange={(v) => setB({ mode: v as AgentFormData['behavior']['mode'] })} disabled={readOnly}>
            <SelectTrigger className="max-w-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODES.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {mode && <p className="text-xs text-muted-foreground">{mode.help}</p>}
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="b-max-turns" className="text-sm font-medium">Máximo de turnos</Label>
            <Input id="b-max-turns" type="number" min={1} value={b.max_turns} disabled={readOnly}
              onChange={(e) => setB({ max_turns: intValue(e.target.value, 1) })} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="b-debounce" className="text-sm font-medium">Espera entre mensagens (ms)</Label>
            <Input id="b-debounce" type="number" min={0} value={b.debounce_ms} disabled={readOnly}
              onChange={(e) => setB({ debounce_ms: intValue(e.target.value, 0) })} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="b-stall" className="text-sm font-medium">Alerta de travamento (s)</Label>
            <Input id="b-stall" type="number" min={1} value={b.stall_seconds} disabled={readOnly}
              onChange={(e) => setB({ stall_seconds: intValue(e.target.value, 1) })} />
          </div>
        </div>

        <div className="space-y-2 max-w-xs">
          <Label htmlFor="b-timeout" className="text-sm font-medium">Tempo limite do modelo (ms)</Label>
          <Input id="b-timeout" type="number" min={1} value={data.execution.llm_timeout_ms} disabled={readOnly}
            onChange={(e) => onChange({ execution: { ...data.execution, llm_timeout_ms: intValue(e.target.value, 1) } })} />
        </div>

        <div className="flex items-center justify-between rounded-[10px] border border-border p-4">
          <div className="space-y-0.5">
            <Label htmlFor="b-inherit" className="text-sm font-medium cursor-pointer">Herdar contexto anterior</Label>
            <p className="text-xs text-muted-foreground">
              Inclui no prompt o resultado dos nós de IA anteriores da mesma conversa.
            </p>
          </div>
          <Switch id="b-inherit" checked={b.herdar_contexto} onCheckedChange={(v) => setB({ herdar_contexto: v })} disabled={readOnly} />
        </div>
      </section>

      <section className="space-y-4">
        <h3 className="text-sm font-medium text-foreground">Recuperação de falhas</h3>
        <div className="space-y-2 max-w-xs">
          <Label htmlFor="r-retries" className="text-sm font-medium">Novas tentativas por turno</Label>
          <Input id="r-retries" type="number" min={0} value={r.attempt_retries} disabled={readOnly}
            onChange={(e) => setR({ attempt_retries: intValue(e.target.value, 0) })} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="r-empty" className="text-sm font-medium">Texto quando o modelo responde vazio</Label>
          <Textarea id="r-empty" rows={2} value={r.empty_reply_text} disabled={readOnly}
            onChange={(e) => setR({ empty_reply_text: e.target.value })} className="text-sm" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="r-fail" className="text-sm font-medium">Texto quando uma integração falha</Label>
          <Textarea id="r-fail" rows={2} value={r.integration_failure_text} disabled={readOnly}
            onChange={(e) => setR({ integration_failure_text: e.target.value })} className="text-sm" />
        </div>
        <div className="space-y-2 max-w-xs">
          <Label className="text-sm font-medium">Tag de saída em falha de integração</Label>
          <Select value={r.integration_failure_tag} onValueChange={(v) => setR({ integration_failure_tag: v ?? r.integration_failure_tag })} disabled={readOnly}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {tags.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </section>
    </div>
  );
}
