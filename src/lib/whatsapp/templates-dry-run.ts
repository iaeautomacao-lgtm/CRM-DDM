// WHATSAPP_TEMPLATES_DRY_RUN (só desenvolvimento/testes): pula a chamada à Meta e grava um meta_template_id
// SINTÉTICO. Em produção isso criaria um template "aprovado" que nunca existiu (ENV-05) — por isso a variável é
// IGNORADA quando NODE_ENV=production (aviso uma vez por processo).

let warned = false

/** Só para testes. */
export function resetTemplatesDryRunWarning(): void {
  warned = false
}

export function templatesDryRunEnabled(
  env: Record<string, string | undefined> = process.env,
  log: Pick<Console, 'warn'> = console,
): boolean {
  const requested = env.WHATSAPP_TEMPLATES_DRY_RUN === 'true' || env.WHATSAPP_TEMPLATES_DRY_RUN === '1'
  if (!requested) return false
  if (env.NODE_ENV === 'production') {
    if (!warned) {
      warned = true
      log.warn('[templates] WHATSAPP_TEMPLATES_DRY_RUN ignorada em produção (geraria template sintético). Remova-a do ambiente.')
    }
    return false
  }
  return true
}
