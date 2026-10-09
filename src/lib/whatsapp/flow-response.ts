// PRD 21, PR-21.1 — resposta de WhatsApp Flow (`interactive.nfm_reply`) recebida pelo webhook da Meta.
//
// Antes: o webhook gravava "[Interactive reply]" e o JSON preenchido pelo devedor era descartado (FLOW-01).
// Agora: o `response_json` é preservado (messages.flow_response), o conteúdo da conversa fica legível para o atendente e as
// respostas viram variáveis do fluxo ativo (flow_*) — a OPERAÇÃO decide no Flow Builder o que fazer com elas. Nada aqui
// chama efetivação de acordo (decisão do dono, 09/10).

export interface NfmReplyPayload {
  name?: string
  body?: string
  response_json?: string
}

export interface ParsedFlowResponse {
  /** Identificador do Flow que a Meta manda em `nfm_reply.name`. */
  flowName: string | null
  /** Respostas do usuário (objeto JSON). Null quando o JSON veio inválido, grande demais ou não é objeto. */
  data: Record<string, unknown> | null
  /** Texto legível para a conversa / histórico / IA. */
  text: string
  /** Motivo de `data` ser null (para log; nunca contém o conteúdo). */
  issue: 'invalid_json' | 'too_large' | 'not_object' | 'empty' | null
}

/** Limite do `response_json` que aceitamos parsear (uma resposta real tem poucos KB). */
export const MAX_RESPONSE_JSON_CHARS = 100_000
const MAX_SUMMARY_FIELDS = 12
const MAX_VALUE_CHARS = 80
const MAX_TEXT_CHARS = 500
const MAX_VAR_FIELDS = 40
const MAX_VAR_VALUE_CHARS = 2_000
const DEFAULT_LABEL = 'Formulário respondido'

function scalar(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value.trim().slice(0, MAX_VALUE_CHARS)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

function summarize(data: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(data)) {
    if (key === 'flow_token') continue // correlação interna da Meta, sem valor para quem lê
    const text = scalar(value)
    if (text === null || text === '') continue
    parts.push(`${key}: ${text}`)
    if (parts.length >= MAX_SUMMARY_FIELDS) break
  }
  return parts.join('; ')
}

export function parseNfmReply(nfm: NfmReplyPayload | null | undefined): ParsedFlowResponse {
  const flowName = typeof nfm?.name === 'string' && nfm.name.trim() ? nfm.name.trim() : null
  const label = typeof nfm?.body === 'string' && nfm.body.trim() ? nfm.body.trim().slice(0, 120) : DEFAULT_LABEL
  const raw = nfm?.response_json

  let data: Record<string, unknown> | null = null
  let issue: ParsedFlowResponse['issue'] = null
  if (typeof raw !== 'string' || raw.trim() === '') {
    issue = 'empty'
  } else if (raw.length > MAX_RESPONSE_JSON_CHARS) {
    issue = 'too_large'
  } else {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>
      else issue = 'not_object'
    } catch {
      issue = 'invalid_json'
    }
  }

  const summary = data ? summarize(data) : ''
  const text = (summary ? `${label}: ${summary}` : label).slice(0, MAX_TEXT_CHARS)
  return { flowName, data, text, issue }
}

/** Chave de variável do fluxo: o motor só interpola `{{vars.[a-zA-Z0-9_]+}}`. */
function varKey(key: string): string | null {
  const clean = key.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)
  return clean ? `flow_${clean}` : null
}

/**
 * Variáveis que a resposta do Flow deixa no run ativo: `flow_name`, `flow_response_json` (tudo, em texto) e `flow_<campo>` para
 * cada valor simples (ex.: `{{vars.flow_parcelas}}`). Só dados — o fluxo decide o que fazer.
 */
export function flowResponseVars(parsed: ParsedFlowResponse): Record<string, string> {
  const vars: Record<string, string> = {}
  if (parsed.flowName) vars.flow_name = parsed.flowName
  if (!parsed.data) return vars
  vars.flow_response_json = JSON.stringify(parsed.data).slice(0, MAX_VAR_VALUE_CHARS)
  let count = 0
  for (const [key, value] of Object.entries(parsed.data)) {
    if (key === 'flow_token') continue
    const k = varKey(key)
    const v = scalar(value)
    if (!k || v === null) continue
    vars[k] = v
    if (++count >= MAX_VAR_FIELDS) break
  }
  return vars
}
