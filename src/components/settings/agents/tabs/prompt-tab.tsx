import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { AgentFormData } from '../types';

interface PromptTabProps {
  data: AgentFormData;
  onChange: (patch: Partial<AgentFormData>) => void;
  readOnly?: boolean;
}

export function PromptTab({ data, onChange, readOnly }: PromptTabProps) {
  const charCount = data.prompt_content.length;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label htmlFor="agent-prompt" className="text-sm font-medium">
          Persona e Instruções Gerais <span className="text-destructive">*</span>
        </Label>
        <p className="text-xs text-muted-foreground">
          Defina o papel, tom de voz, persona e as diretrizes principais do agente. Regras específicas,
          ferramentas e base de conhecimento serão anexadas automaticamente na composição final.
        </p>
      </div>

      <div className="space-y-2">
        <Textarea
          id="agent-prompt"
          value={data.prompt_content}
          onChange={(e) => onChange({ prompt_content: e.target.value })}
          placeholder="Exemplo: Você é o Ben, assistente virtual amigável do Grupo DDM. Seu objetivo é ajudar clientes a consultar pendências e orientá-los com clareza..."
          rows={16}
          disabled={readOnly}
          className="font-mono text-sm leading-relaxed resize-y min-h-[320px]"
        />
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Dica: Use formatação clara e tópicos para organizar as atribuições do assistente.</span>
          <span>{charCount.toLocaleString('pt-BR')} caracteres</span>
        </div>
      </div>
    </div>
  );
}
