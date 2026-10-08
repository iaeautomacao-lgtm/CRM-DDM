import { supabaseAdmin } from './admin-client'
import type { BuilderStepInput } from './steps-tree'

// As rotas de automação gravam com service role e o engine executa os passos
// com service role: um `tag_id`/`agent_id`/`pipeline_id` de OUTRA conta
// passaria direto (contact_tags nem tem account_id). Antes de salvar, confere
// que cada referência do gatilho e dos passos pertence à conta do chamador.

type RefKind = 'tags' | 'pipelines' | 'pipeline_stages' | 'profiles'

export interface AutomationRefs {
  tags: Set<string>
  pipelines: Set<string>
  pipeline_stages: Set<string>
  profiles: Set<string>
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** Junta os ids referenciados pelo gatilho e pelos passos (árvore ou lista plana). */
export function collectAutomationRefs(
  triggerConfig: unknown,
  steps: BuilderStepInput[] | undefined,
): AutomationRefs {
  const refs: AutomationRefs = {
    tags: new Set(),
    pipelines: new Set(),
    pipeline_stages: new Set(),
    profiles: new Set(),
  }
  const add = (kind: RefKind, v: unknown) => {
    const id = str(v)
    if (id) refs[kind].add(id)
  }

  if (triggerConfig && typeof triggerConfig === 'object') {
    add('tags', (triggerConfig as { tag_id?: unknown }).tag_id)
  }

  const walk = (list: BuilderStepInput[] | undefined) => {
    for (const s of list ?? []) {
      if (!s || typeof s !== 'object') continue
      const cfg = (s.step_config ?? {}) as Record<string, unknown>
      switch (s.step_type) {
        case 'add_tag':
        case 'remove_tag':
          add('tags', cfg.tag_id)
          break
        case 'assign_conversation':
          add('profiles', cfg.agent_id)
          break
        case 'create_deal':
          add('pipelines', cfg.pipeline_id)
          add('pipeline_stages', cfg.stage_id)
          break
        case 'close_conversation':
          add('tags', cfg.outcome_tag_id)
          break
        case 'condition':
          // Condição "tem a etiqueta": o operando é o id de uma etiqueta.
          if (cfg.subject === 'tag_presence') add('tags', cfg.operand)
          break
      }
      walk(s.branches?.yes)
      walk(s.branches?.no)
    }
  }
  walk(steps)
  return refs
}

/**
 * Devolve uma mensagem (pt-BR) se alguma referência não pertencer à conta;
 * `null` quando está tudo ok. Falha de consulta também bloqueia (fail-closed).
 */
export async function validateAutomationRefs(
  accountId: string,
  triggerConfig: unknown,
  steps: BuilderStepInput[] | undefined,
): Promise<string | null> {
  const refs = collectAutomationRefs(triggerConfig, steps)
  const db = supabaseAdmin()
  const checks: Array<[RefKind, string, string]> = [
    ['tags', 'id', 'etiqueta'],
    ['pipelines', 'id', 'funil'],
    ['pipeline_stages', 'id', 'etapa do funil'],
    ['profiles', 'user_id', 'agente'],
  ]
  for (const [table, column, label] of checks) {
    const ids = [...refs[table]]
    if (ids.length === 0) continue
    const { data, error } = await db
      .from(table)
      .select(column)
      .eq('account_id', accountId)
      .in(column, ids)
    if (error) {
      console.error('[automations] validação de referências falhou:', table, error.message)
      return 'Não foi possível validar as referências da automação.'
    }
    const found = new Set(
      ((data ?? []) as unknown as Array<Record<string, string>>).map((r) => r[column]),
    )
    if (ids.some((id) => !found.has(id))) {
      return `A automação referencia ${label} que não existe nesta conta.`
    }
  }
  return null
}
