// Detecção de "alterações não salvas" do builder de Automações: compara o que foi salvo (ou aberto) com o estado atual
// só nos campos que o servidor guarda. Puro e sem dependência de React, para ficar testável.

export interface DirtyComparable {
  name: string;
  description: string | null;
  trigger_type: string;
  trigger_config: unknown;
  is_active: boolean;
  line_ids?: string[] | null;
  steps: unknown;
}

function snapshot(s: DirtyComparable): string {
  return JSON.stringify({
    name: s.name ?? "",
    description: s.description ?? "",
    trigger_type: s.trigger_type,
    trigger_config: s.trigger_config ?? {},
    is_active: !!s.is_active,
    line_ids: [...(s.line_ids ?? [])].sort(),
    steps: s.steps ?? [],
  });
}

/** True quando o estado atual difere do último estado salvo/aberto. */
export function isBuilderDirty(saved: DirtyComparable, current: DirtyComparable): boolean {
  return snapshot(saved) !== snapshot(current);
}
