import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AI_PROVIDERS,
  DEFAULT_MODEL_BY_PROVIDER,
  aiProviderLabel,
  getAiModelsForProvider,
} from '@/lib/ai/models';
import type { AgentFormData } from '../types';

interface ModelTabProps {
  data: AgentFormData;
  onChange: (patch: Partial<AgentFormData>) => void;
  readOnly?: boolean;
}

function OptionalField({
  id,
  label,
  help,
  defaultLabel,
  useDefault,
  onUseDefault,
  readOnly,
  children,
}: {
  id: string;
  label: string;
  help?: string;
  defaultLabel: string;
  useDefault: boolean;
  onUseDefault: (v: boolean) => void;
  readOnly?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="rounded-[10px] border border-border p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          <Label htmlFor={id} className="text-sm font-medium">
            {label}
          </Label>
          {help && <p className="text-xs text-muted-foreground">{help}</p>}
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground shrink-0">
          <Switch checked={useDefault} onCheckedChange={onUseDefault} disabled={readOnly} className="scale-90" />
          Usar padrão
        </label>
      </div>
      <div className={useDefault ? 'opacity-50 pointer-events-none' : ''}>{children}</div>
      {useDefault && <p className="text-xs text-muted-foreground">Padrão: {defaultLabel}</p>}
    </div>
  );
}

const REASONING = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
const FORMATS = [
  ['text', 'Texto'],
  ['json_object', 'Objeto JSON'],
  ['json_schema', 'JSON com esquema'],
] as const;

export function ModelTab({ data, onChange, readOnly }: ModelTabProps) {
  const llm = data.llm;
  const models = getAiModelsForProvider(llm.provider);
  const modelKnown = models.some((m) => m.id === llm.model);
  const patch = (p: Partial<AgentFormData['llm']>) => onChange({ llm: { ...llm, ...p } });
  const supportsSampling = llm.provider !== 'claude';
  const supportsOpenAiExtras = llm.provider === 'openai' || llm.provider === 'hermes';

  function handleProvider(provider: AgentFormData['llm']['provider']) {
    patch({ provider, model: DEFAULT_MODEL_BY_PROVIDER[provider] });
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="space-y-2">
        <Label id="agent-provider-label" className="text-sm font-medium">Provedor</Label>
        <div role="radiogroup" aria-labelledby="agent-provider-label" className="flex flex-wrap gap-2">
          {AI_PROVIDERS.map((p) => {
            const on = llm.provider === p;
            return (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={readOnly}
                onClick={() => !on && handleProvider(p)}
                className={cn(
                  'h-9 rounded-md border px-3 text-[13px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60',
                  on
                    ? 'border-primary bg-primary-soft text-primary-text'
                    : 'border-border bg-card text-foreground hover:bg-surface-hover',
                )}
              >
                {aiProviderLabel(p)}
              </button>
            );
          })}
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label className="text-sm font-medium">Modelo</Label>
          <Select value={llm.model} onValueChange={(v) => patch({ model: v ?? llm.model })} disabled={readOnly}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {!modelKnown && llm.model && <SelectItem value={llm.model}>{llm.model} (fora da lista)</SelectItem>}
              {models.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {supportsSampling && (
        <OptionalField
          id="llm-temperature"
          label="Temperatura"
          help="0 = respostas mais previsíveis; 2 = mais criativas."
          defaultLabel="definido pelo provedor/modelo"
          useDefault={llm.temperatureUseDefault}
          onUseDefault={(v) => patch({ temperatureUseDefault: v })}
          readOnly={readOnly}
        >
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={0}
              max={2}
              step={0.1}
              value={llm.temperature}
              onChange={(e) => patch({ temperature: Number(e.target.value) })}
              disabled={readOnly || llm.temperatureUseDefault}
              className="flex-1"
              aria-label="Temperatura"
            />
            <Input
              id="llm-temperature"
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={llm.temperature}
              onChange={(e) => patch({ temperature: Math.min(2, Math.max(0, Number(e.target.value) || 0)) })}
              disabled={readOnly || llm.temperatureUseDefault}
              className="w-20"
            />
          </div>
        </OptionalField>
      )}

      <OptionalField
        id="llm-max-tokens"
        label="Máximo de tokens da resposta"
        defaultLabel="limite padrão do provedor"
        useDefault={llm.maxTokensUseDefault}
        onUseDefault={(v) => patch({ maxTokensUseDefault: v })}
        readOnly={readOnly}
      >
        <Input
          id="llm-max-tokens"
          type="number"
          min={1}
          value={llm.max_tokens}
          onChange={(e) => patch({ max_tokens: Math.max(1, Math.floor(Number(e.target.value) || 1)) })}
          disabled={readOnly || llm.maxTokensUseDefault}
          className="max-w-40"
        />
      </OptionalField>

      {supportsSampling && (
        <OptionalField
          id="llm-top-p"
          label="Top P"
          help="Amostragem por núcleo (0 a 1)."
          defaultLabel="1"
          useDefault={llm.topPUseDefault}
          onUseDefault={(v) => patch({ topPUseDefault: v })}
          readOnly={readOnly}
        >
          <Input
            id="llm-top-p"
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={llm.top_p}
            onChange={(e) => patch({ top_p: Math.min(1, Math.max(0, Number(e.target.value) || 0)) })}
            disabled={readOnly || llm.topPUseDefault}
            className="max-w-40"
          />
        </OptionalField>
      )}

      {supportsOpenAiExtras && (
        <>
          <OptionalField
            id="llm-frequency"
            label="Penalidade de frequência"
            help="-2 a 2. Valores positivos reduzem repetição de termos."
            defaultLabel="0"
            useDefault={llm.frequencyPenaltyUseDefault}
            onUseDefault={(v) => patch({ frequencyPenaltyUseDefault: v })}
            readOnly={readOnly}
          >
            <Input
              id="llm-frequency"
              type="number"
              min={-2}
              max={2}
              step={0.1}
              value={llm.frequency_penalty}
              onChange={(e) => patch({ frequency_penalty: Math.min(2, Math.max(-2, Number(e.target.value) || 0)) })}
              disabled={readOnly || llm.frequencyPenaltyUseDefault}
              className="max-w-40"
            />
          </OptionalField>

          <OptionalField
            id="llm-presence"
            label="Penalidade de presença"
            help="-2 a 2. Valores positivos incentivam novos assuntos."
            defaultLabel="0"
            useDefault={llm.presencePenaltyUseDefault}
            onUseDefault={(v) => patch({ presencePenaltyUseDefault: v })}
            readOnly={readOnly}
          >
            <Input
              id="llm-presence"
              type="number"
              min={-2}
              max={2}
              step={0.1}
              value={llm.presence_penalty}
              onChange={(e) => patch({ presence_penalty: Math.min(2, Math.max(-2, Number(e.target.value) || 0)) })}
              disabled={readOnly || llm.presencePenaltyUseDefault}
              className="max-w-40"
            />
          </OptionalField>

          <OptionalField
            id="llm-reasoning"
            label="Esforço de raciocínio"
            defaultLabel="definido pelo modelo"
            useDefault={llm.reasoningEffortUseDefault}
            onUseDefault={(v) => patch({ reasoningEffortUseDefault: v })}
            readOnly={readOnly}
          >
            <Select
              value={llm.reasoning_effort}
              onValueChange={(v) => patch({ reasoning_effort: v as AgentFormData['llm']['reasoning_effort'] })}
              disabled={readOnly || llm.reasoningEffortUseDefault}
            >
              <SelectTrigger id="llm-reasoning" className="max-w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REASONING.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </OptionalField>

          <OptionalField
            id="llm-format"
            label="Formato da resposta"
            defaultLabel="texto"
            useDefault={llm.responseFormatUseDefault}
            onUseDefault={(v) => patch({ responseFormatUseDefault: v })}
            readOnly={readOnly}
          >
            <Select
              value={llm.response_format}
              onValueChange={(v) => patch({ response_format: v as AgentFormData['llm']['response_format'] })}
              disabled={readOnly || llm.responseFormatUseDefault}
            >
              <SelectTrigger id="llm-format" className="max-w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FORMATS.map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </OptionalField>
        </>
      )}
    </div>
  );
}
