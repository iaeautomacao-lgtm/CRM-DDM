// Acordito: o copiloto interno do atendente (decisão do dono, 14/10). Gera 3 sugestões de resposta a partir do histórico recente da conversa,
// dos dados básicos do contato e das respostas rápidas visíveis ao usuário. REGRAS:
//   - NUNCA envia mensagem: só devolve texto para o atendente escolher, editar e enviar;
//   - chave e modelo da CONTA (ai_config); sem chave própria ⇒ `ai_not_configured` (nunca cai na chave do .env);
//   - cota diária de IA da conta (kind 'copilot', daily-quota); cache por conversa + id da última mensagem do cliente;
//   - a conversa, as mensagens e as respostas rápidas são lidas pelo cliente COM a sessão do usuário (RLS = mesmo escopo do inbox);
//   - o texto de orientação vem da operação, pela tela (copilot_config.guidance); o código só tem um padrão NEUTRO mínimo;
//   - nada do texto (histórico, sugestões) vai para o log.
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { callLlmForAnalysis, stripJsonFences } from '@/lib/ai/llm-shared'
import { resolveAccountRewriteKey } from '@/lib/ai/rewrite'
import { consumeAiQuota } from '@/lib/ai/daily-quota'
import { ACORDITO_EMPTY_MESSAGE, ACORDITO_ERROR_MESSAGE, ACORDITO_UNAVAILABLE_MESSAGE, buildAcorditoSystem } from '@/lib/ai/acordito/persona'

type Db = Pick<SupabaseClient, 'from'>

/** Orientação padrão (neutra) quando a operação ainda não escreveu a dela. */
export const COPILOT_DEFAULT_GUIDANCE = 'Sugira respostas curtas, educadas e objetivas em português.'
export const COPILOT_MAX_GUIDANCE_CHARS = 4000
export const COPILOT_SUGGESTION_COUNT = 3
export const COPILOT_HISTORY_LIMIT = 30
export const COPILOT_MAX_MESSAGE_CHARS = 600
export const COPILOT_MAX_QUICK_REPLIES = 30
export const COPILOT_MAX_QUICK_REPLY_CHARS = 300
export const COPILOT_MAX_SUGGESTION_CHARS = 1500
export const COPILOT_MAX_OUTPUT_TOKENS = 900
export const COPILOT_TIMEOUT_MS = 25_000
/** Quanto tempo as sugestões ficam guardadas (cache e validação do feedback). */
export const COPILOT_RETENTION_DAYS = 3

export type CopilotErrorCode = 'ai_not_configured' | 'copilot_disabled' | 'quota_exceeded' | 'forbidden' | 'ai_bad_response' | 'ai_failed'

export const COPILOT_ERROR_STATUS: Record<CopilotErrorCode, number> = {
  ai_not_configured: 409,
  copilot_disabled: 409,
  quota_exceeded: 429,
  forbidden: 403,
  ai_bad_response: 502,
  ai_failed: 502,
}

export interface CopilotSuggestion {
  id: string
  text: string
}

export type CopilotOutcome =
  | { ok: true; suggestions: CopilotSuggestion[]; basedOnMessageId: string | null; cached: boolean }
  | { ok: false; code: CopilotErrorCode }

export interface CopilotConfig {
  enabled: boolean
  /** Texto salvo pela operação (pode ser vazio). */
  guidance: string
}

export interface CopilotHistoryMessage {
  sender_type: string
  origin?: string | null
  content_type?: string | null
  content_text?: string | null
}

export interface CopilotQuickReply {
  title: string
  content: string
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text)

function speakerOf(m: CopilotHistoryMessage): string {
  if (m.sender_type === 'customer') return 'Cliente'
  if (m.origin === 'ai' || m.sender_type === 'bot') return 'IA'
  return 'Atendente'
}

function textOf(m: CopilotHistoryMessage): string {
  const text = (m.content_text ?? '').replace(/\s+/g, ' ').trim()
  if (text) return clip(text, COPILOT_MAX_MESSAGE_CHARS)
  return m.content_type && m.content_type !== 'text' ? `[${m.content_type}]` : ''
}

/** Regras da superfície "sugestões do copiloto" (o texto de negócio vem da orientação da operação; aqui só formato e segurança). */
export const COPILOT_RULES: readonly string[] = [
  'Você ajuda um atendente humano da equipe que conversa com um cliente pelo WhatsApp: escreva sugestões de resposta na voz do ATENDENTE, para ele escolher, editar e enviar. Você nunca envia nada.',
  'Não invente valores, datas, prazos, descontos, links, nomes nem políticas que não estejam na conversa ou nas respostas rápidas do <contexto>.',
  'Responda à última mensagem do cliente. Cada sugestão é uma mensagem pronta para enviar, sem aspas, sem rótulos e sem explicações.',
  `Devolva exatamente ${COPILOT_SUGGESTION_COUNT} sugestões diferentes entre si e responda SOMENTE com JSON no formato: {"suggestions": [{"text": "<mensagem 1>"}, {"text": "<mensagem 2>"}, {"text": "<mensagem 3>"}]}`,
]

/** Prompt do copiloto: persona do Acordito + regras da superfície + orientação da operação; conversa, contato e respostas rápidas em <contexto>. */
export function buildCopilotPrompt(input: {
  guidance: string
  contactName?: string | null
  messages: CopilotHistoryMessage[]
  quickReplies: CopilotQuickReply[]
}): string {
  const lines = input.messages
    .map((m) => ({ who: speakerOf(m), text: textOf(m) }))
    .filter((l) => l.text)
    .map((l) => `${l.who}: ${l.text}`)
  const replies = input.quickReplies
    .slice(0, COPILOT_MAX_QUICK_REPLIES)
    .map((q) => `- ${clip(q.title.trim(), 80)}: ${clip(q.content.replace(/\s+/g, ' ').trim(), COPILOT_MAX_QUICK_REPLY_CHARS)}`)
  const context = [
    'Contato:',
    input.contactName?.trim() ? `Nome: ${clip(input.contactName.trim(), 80)}` : 'Nome: (não informado)',
    '',
    'Respostas rápidas:',
    replies.length > 0 ? replies.join('\n') : '(nenhuma)',
    '',
    'Conversa:',
    lines.join('\n'),
  ].join('\n')
  return buildAcorditoSystem({ rules: COPILOT_RULES, guidance: input.guidance.trim() || COPILOT_DEFAULT_GUIDANCE, context })
}

/** Texto de erro para a tela (com o nome do Acordito); o detalhe técnico fica só no log. */
export const COPILOT_ERROR_MESSAGE: Record<CopilotErrorCode, string> = {
  ai_not_configured: ACORDITO_UNAVAILABLE_MESSAGE,
  copilot_disabled: 'O Acordito está desligado para esta conta.',
  quota_exceeded: 'O Acordito atingiu o limite de uso de hoje.',
  forbidden: 'Você não tem acesso a esta conversa.',
  ai_bad_response: ACORDITO_EMPTY_MESSAGE,
  ai_failed: ACORDITO_ERROR_MESSAGE,
}

/** Valida a resposta do modelo: até 3 textos não vazios, sem repetição. Vazio = formato inaproveitável. */
export function parseCopilotResponse(raw: string): string[] {
  let data: unknown
  try {
    data = JSON.parse(stripJsonFences(raw))
  } catch {
    return []
  }
  const list = Array.isArray(data) ? data : (data as { suggestions?: unknown } | null)?.suggestions
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const item of list) {
    const value = typeof item === 'string' ? item : (item as { text?: unknown } | null)?.text
    const text = typeof value === 'string' ? value.trim().slice(0, COPILOT_MAX_SUGGESTION_CHARS) : ''
    if (text && !out.includes(text)) out.push(text)
    if (out.length === COPILOT_SUGGESTION_COUNT) break
  }
  return out
}

export async function loadCopilotConfig(db: Db, accountId: string): Promise<CopilotConfig> {
  const { data, error } = await db.from('copilot_config').select('enabled, guidance').eq('account_id', accountId).maybeSingle()
  // Sem a migration 354 (tabela ausente): desligado, não há onde guardar as sugestões.
  if (error) return { enabled: false, guidance: '' }
  // Sem linha: a conta nunca mexeu na configuração → o Acordito nasce LIGADO (decisão do dono, 14/10).
  if (!data) return { enabled: true, guidance: '' }
  const row = data as { enabled?: boolean | null; guidance?: string | null }
  return { enabled: row.enabled !== false, guidance: row.guidance ?? '' }
}

export interface CopilotDeps {
  call?: typeof callLlmForAnalysis
  quota?: typeof consumeAiQuota
  newId?: () => string
  now?: () => number
}

export interface CopilotInput {
  /** Cliente COM a sessão do usuário (RLS): conversa, mensagens e respostas rápidas no escopo dele. */
  userDb: Db
  /** Service role: configuração, cache, chave da conta e cota (sempre filtrando por conta). */
  adminDb: Db
  accountId: string
  userId: string
  conversationId: string
  force?: boolean
}

/** Gera (ou devolve do cache) as sugestões. Erros de infraestrutura do banco lançam; o resto vira `{ ok:false, code }`. */
export async function getCopilotSuggestions(input: CopilotInput, deps: CopilotDeps = {}): Promise<CopilotOutcome> {
  const { userDb, adminDb, accountId, userId, conversationId } = input
  const config = await loadCopilotConfig(adminDb, accountId)
  if (!config.enabled) return { ok: false, code: 'copilot_disabled' }

  // Escopo do envio no inbox: só quem enxerga a conversa (RLS, inclusive equipe) recebe sugestões para ela.
  const { data: conversation, error: convError } = await userDb
    .from('conversations')
    .select('id, contact:contacts(name)')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (convError) throw new Error(`copilot: leitura da conversa falhou (${convError.code ?? 'erro'})`)
  if (!conversation) return { ok: false, code: 'forbidden' }

  const { data: lastCustomer, error: lastError } = await userDb
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: false })
    .limit(1)
  if (lastError) throw new Error(`copilot: leitura das mensagens falhou (${lastError.code ?? 'erro'})`)
  const basedOnMessageId = (lastCustomer?.[0] as { id?: string } | undefined)?.id ?? null
  if (!basedOnMessageId) return { ok: true, suggestions: [], basedOnMessageId: null, cached: false }

  if (!input.force) {
    const { data: hit } = await adminDb
      .from('copilot_suggestions')
      .select('suggestions')
      .eq('account_id', accountId)
      .eq('conversation_id', conversationId)
      .eq('based_on_message_id', basedOnMessageId)
      .order('created_at', { ascending: false })
      .limit(1)
    const cachedList = (hit?.[0] as { suggestions?: unknown } | undefined)?.suggestions
    if (Array.isArray(cachedList) && cachedList.length > 0) {
      return { ok: true, suggestions: cachedList as CopilotSuggestion[], basedOnMessageId, cached: true }
    }
  }

  const key = await resolveAccountRewriteKey(adminDb, accountId)
  if (!key) return { ok: false, code: 'ai_not_configured' }

  const quota = await (deps.quota ?? consumeAiQuota)(adminDb, accountId, 'copilot')
  if (!quota.allowed) return { ok: false, code: 'quota_exceeded' }

  const [{ data: recent, error: recentError }, { data: replies }] = await Promise.all([
    userDb
      .from('messages')
      .select('sender_type, origin, content_type, content_text')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(COPILOT_HISTORY_LIMIT),
    userDb.from('quick_replies').select('title, content').eq('account_id', accountId).order('title', { ascending: true }).limit(COPILOT_MAX_QUICK_REPLIES),
  ])
  if (recentError) throw new Error(`copilot: leitura do histórico falhou (${recentError.code ?? 'erro'})`)

  const contact = (conversation as { contact?: { name?: string | null } | { name?: string | null }[] | null }).contact
  const contactName = Array.isArray(contact) ? contact[0]?.name : contact?.name
  const prompt = buildCopilotPrompt({
    guidance: config.guidance,
    contactName,
    messages: ((recent ?? []) as CopilotHistoryMessage[]).slice().reverse(),
    quickReplies: (replies ?? []) as CopilotQuickReply[],
  })

  let raw: string
  try {
    raw = await (deps.call ?? callLlmForAnalysis)(key.provider, key.apiKey, prompt, key.model, {
      maxTokens: COPILOT_MAX_OUTPUT_TOKENS,
      timeoutMs: COPILOT_TIMEOUT_MS,
      accountId,
      feature: 'copilot',
    })
  } catch (e) {
    // Só o nome/status do erro — nunca o histórico nem a resposta.
    console.error('[ai/copilot] falha na chamada ao provedor:', e instanceof Error ? e.message.slice(0, 120) : 'erro')
    return { ok: false, code: 'ai_failed' }
  }
  const texts = parseCopilotResponse(raw)
  if (texts.length === 0) return { ok: false, code: 'ai_bad_response' }

  const newId = deps.newId ?? randomUUID
  const suggestions: CopilotSuggestion[] = texts.map((text) => ({ id: newId(), text }))
  const { error: insertError } = await adminDb.from('copilot_suggestions').insert({
    account_id: accountId,
    conversation_id: conversationId,
    based_on_message_id: basedOnMessageId,
    suggestions,
    created_by: userId,
  })
  // Falha ao guardar só perde o cache e a validação do feedback; o atendente ainda recebe as sugestões.
  if (insertError) console.error('[ai/copilot] falha ao guardar o cache:', insertError.code ?? 'erro')
  else {
    const cutoff = new Date((deps.now?.() ?? Date.now()) - COPILOT_RETENTION_DAYS * 86_400_000).toISOString()
    await adminDb.from('copilot_suggestions').delete().eq('account_id', accountId).eq('conversation_id', conversationId).lt('created_at', cutoff)
  }
  return { ok: true, suggestions, basedOnMessageId, cached: false }
}
