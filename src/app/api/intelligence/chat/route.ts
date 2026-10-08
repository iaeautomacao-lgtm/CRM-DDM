import { NextResponse } from 'next/server'
import { resolveActiveApiKey } from '@/lib/ai/llm-shared'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { createToolExecutor } from '@/lib/intelligence/chat/execute'
import type { ChatStreamEvent } from '@/lib/intelligence/chat/labels'
import { runChatLoop } from '@/lib/intelligence/chat/loop'
import { createOpenAiChatClient, intelligenceModel } from '@/lib/intelligence/chat/openai-client'
import { buildSystemPrompt, chatToolDefinitions, scopeLabel } from '@/lib/intelligence/chat/prompt'
import {
  chatTitleFrom,
  countAccountQuestionsToday,
  createChat,
  DAILY_LIMIT_MESSAGE,
  dailyMessageLimit,
  getOwnedChat,
  insertChatMessage,
  loadHistoryForModel,
  touchChat,
} from '@/lib/intelligence/chat/store'
import type { ChatHistoryMessage } from '@/lib/intelligence/chat/types'
import { BadRequestError } from '@/lib/intelligence/errors'
import { currentIntelligenceScope, intelligenceErrorResponse } from '@/lib/intelligence/http'
import type { IntelligenceScope } from '@/lib/intelligence/scope'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'

// POST /api/intelligence/chat — chat do DDM Intelligence (PRD-04, Fase 2).
// Owner/admin/supervisor (mesma autenticação de /api/intelligence/tools).
// Corpo: { message: string, chat_id?: uuid }.
//
// Resposta em streaming NDJSON (uma linha JSON por evento — ver
// ChatStreamEvent em lib/intelligence/chat/labels.ts). Cada chamada de
// ferramenta do modelo passa por createToolExecutor: mesmo executeTool,
// escopo da sessão, limite por usuário e auditoria da rota de ferramentas.
// Pergunta e resposta ficam em intelligence_chats/_messages (migration 150).

const MAX_MESSAGE_CHARS = 2_000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Perguntas por minuto por usuário (cada uma pode gerar até 6 rodadas de ferramenta).
const CHAT_RATE = { limit: 10, windowMs: 60_000 }

const GENERIC_FAILURE = 'Não consegui concluir a análise agora. Tente de novo em instantes.'

function parseBody(raw: string): { message: string; chatId: string | null } {
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    throw new BadRequestError('Corpo deve ser JSON válido')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestError('Corpo inválido')
  const { message, chat_id } = body as Record<string, unknown>
  if (typeof message !== 'string' || !message.trim()) throw new BadRequestError('Escreva uma pergunta')
  if (message.length > MAX_MESSAGE_CHARS) {
    throw new BadRequestError(`A pergunta pode ter no máximo ${MAX_MESSAGE_CHARS} caracteres`)
  }
  if (chat_id !== undefined && chat_id !== null && (typeof chat_id !== 'string' || !UUID_RE.test(chat_id))) {
    throw new BadRequestError('chat_id inválido')
  }
  return { message: message.trim(), chatId: typeof chat_id === 'string' ? chat_id.toLowerCase() : null }
}

/** Chave da OpenAI: env OPENAI_API_KEY; senão a chave OpenAI da conta (ai_config). */
async function resolveOpenAiKey(accountId: string): Promise<string | null> {
  const envKey = process.env.OPENAI_API_KEY?.trim()
  if (envKey) return envKey
  const active = await resolveActiveApiKey(supabaseAdmin(), accountId)
  return active?.provider === 'openai' ? active.apiKey : null
}

async function teamNames(scope: IntelligenceScope): Promise<string[]> {
  if (scope.teamIds === null) return []
  const { data } = await supabaseAdmin()
    .from('teams')
    .select('name')
    .eq('account_id', scope.accountId)
    .in('id', scope.teamIds)
    .order('name')
    .range(0, 49)
  return ((data as Array<{ name: string | null }> | null) ?? []).map((t) => t.name ?? '').filter(Boolean)
}

export async function POST(request: Request) {
  let scope: IntelligenceScope
  let input: { message: string; chatId: string | null }
  try {
    scope = await currentIntelligenceScope()
    input = parseBody(await request.text())
  } catch (err) {
    return intelligenceErrorResponse(err)
  }

  const limit = await checkRateLimit(`intelligence-chat:${scope.userId}`, CHAT_RATE)
  if (!limit.success) return rateLimitResponse(limit)

  const db = supabaseAdmin()
  let chat: { id: string; title: string }
  let history: ChatHistoryMessage[]
  let apiKey: string | null
  let names: string[]
  try {
    const used = await countAccountQuestionsToday(db, scope.accountId)
    if (used >= dailyMessageLimit()) {
      return NextResponse.json({ error: DAILY_LIMIT_MESSAGE, code: 'daily_limit' }, { status: 429 })
    }

    apiKey = await resolveOpenAiKey(scope.accountId)
    if (!apiKey) {
      return NextResponse.json(
        { error: 'O DDM Intelligence ainda não está configurado (chave da OpenAI ausente). Fale com o administrador.' },
        { status: 503 },
      )
    }

    if (input.chatId) {
      const owned = await getOwnedChat(db, scope, input.chatId)
      if (!owned) return NextResponse.json({ error: 'Conversa não encontrada' }, { status: 404 })
      chat = owned
      history = await loadHistoryForModel(db, owned.id)
    } else {
      chat = await createChat(db, scope, chatTitleFrom(input.message))
      history = []
    }
    names = await teamNames(scope)
    await insertChatMessage(db, scope, chat.id, { role: 'user', content: input.message })
  } catch (err) {
    return intelligenceErrorResponse(err)
  }

  const llm = createOpenAiChatClient({ apiKey, model: intelligenceModel() })
  const encoder = new TextEncoder()
  const chatId = chat.id

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true
      const send = (event: ChatStreamEvent) => {
        if (!open) return
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
        } catch {
          // Cliente desconectou: o laço continua e a resposta fica salva no histórico.
          open = false
        }
      }

      send({ type: 'meta', chat_id: chatId, title: chat.title })
      try {
        const result = await runChatLoop({
          llm,
          systemPrompt: buildSystemPrompt({ scopeLabel: scopeLabel(scope, names) }),
          history,
          userMessage: input.message,
          tools: chatToolDefinitions(),
          execute: createToolExecutor(scope),
          onEvent: (e) => send(e),
        })
        const messageId = await insertChatMessage(db, scope, chatId, {
          role: 'assistant',
          content: result.answer,
          tool_calls: result.toolCalls,
        }).catch((err: unknown) => {
          console.error('[intelligence/chat] falha ao salvar a resposta:', err)
          return null
        })
        await touchChat(db, chatId)
        send({ type: 'done', message_id: messageId })
      } catch (err) {
        console.error('[intelligence/chat] laço falhou:', err)
        await insertChatMessage(db, scope, chatId, { role: 'assistant', content: GENERIC_FAILURE }).catch(() => null)
        await touchChat(db, chatId)
        send({ type: 'error', message: GENERIC_FAILURE })
      } finally {
        if (open) {
          try {
            controller.close()
          } catch {
            // já fechado
          }
        }
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      // Evita buffering em proxies (nginx/Passenger) para o streaming chegar em tempo real.
      'X-Accel-Buffering': 'no',
    },
  })
}
