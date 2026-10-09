import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { can } from '@/lib/auth/permissions'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit } from '@/lib/rate-limit'
import {
  AgentServiceError,
  buildSimulationAgent,
  SIM_NEW_AGENT_ID,
  validAgentId,
} from '@/lib/ai/agents/service'
import { buildAgentTestFlow, maskAgentTestRun, summarizeAgentTestTimeline } from '@/lib/flows/simulator/agent-test'
import { applyRealReadPolicy, parseSimulateRequest, SIM_MAX_BODY_CHARS } from '@/lib/flows/simulator/parse'
import { simulateTurn } from '@/lib/flows/simulator/run'
import { loadSimulationAccountData } from '@/lib/flows/simulator/seed'
import { SIM_RATE_LIMIT } from '@/lib/flows/simulator/types'

/**
 * POST /api/settings/agents/[id]/simulate — "Testar agente" no editor do agente (TASK1-C).
 * `[id]` = agente salvo, ou `new` para um agente ainda não criado.
 *
 * Reaproveita o simulador de fluxo (PRD 05): monta um fluxo SINTÉTICO de um nó ai_agent ligado ao
 * RASCUNHO do agente (corpo `agent`, o mesmo payload de "Publicar nova versão"; nada é salvo) e roda UMA
 * mensagem do "cliente" no motor real com o banco em memória. Mesmas garantias do "Testar fluxo": nada vai
 * para o WhatsApp, nada é gravado em conversa real, IA real com a chave DA CONTA (ai_config), ferramentas
 * com mock — consulta real só para as somente-leitura liberadas e só com secrets.write
 * (effectiveSimToolMode: efetiva_acordo, GET com efeito, nunca roda). Stateless: o cliente manda o estado.
 *
 * Permissão: ai.agents.view + flows.simulate (supervisor ou acima). Limite de custo compartilhado com o
 * simulador de fluxo (SIM_RATE_LIMIT por usuário). A resposta vem resumida e sem CPF.
 */
export const maxDuration = 120

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params

  let account
  try {
    account = await getCurrentAccount()
  } catch (err) {
    return toErrorResponse(err)
  }
  if (!can(account, 'ai.agents.view') || !can(account, 'flows.simulate')) {
    return NextResponse.json({ error: 'Testar o agente é restrito a supervisor ou acima.' }, { status: 403 })
  }
  const agentId = id === 'new' ? null : id
  if (agentId !== null && !validAgentId(agentId)) {
    return NextResponse.json({ error: 'Agente não encontrado.' }, { status: 404 })
  }

  const rawText = await request.text()
  if (rawText.length > SIM_MAX_BODY_CHARS) {
    return NextResponse.json({ error: 'Conversa de teste longa demais — clique em Reiniciar.' }, { status: 413 })
  }
  let raw: unknown
  try {
    raw = JSON.parse(rawText)
  } catch {
    return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 })
  }
  if (!isObject(raw) || !isObject(raw.agent)) {
    return NextResponse.json({ error: 'Rascunho do agente ausente.' }, { status: 400 })
  }
  // O fluxo é sempre o sintético (o cliente não manda nós) e começa em qualquer mensagem.
  const parsed = parseSimulateRequest({ ...raw, draft: buildAgentTestFlow(agentId ?? SIM_NEW_AGENT_ID), ignoreTrigger: true, httpMocks: {} })
  if (typeof parsed === 'string') {
    return NextResponse.json({ error: parsed }, { status: 400 })
  }

  let agent: Awaited<ReturnType<typeof buildSimulationAgent>>
  try {
    agent = await buildSimulationAgent(account.accountId, agentId, raw.agent)
  } catch (err) {
    if (err instanceof AgentServiceError) {
      return NextResponse.json({ error: err.message, ...(err.issues ? { issues: err.issues } : {}) }, { status: err.status })
    }
    console.error('[agents simulate] falha ao montar o rascunho:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Não foi possível preparar o teste do agente.' }, { status: 500 })
  }

  const limit = await checkRateLimit(`flows:simulate:${account.userId}`, SIM_RATE_LIMIT)
  if (!limit.success) {
    const minutes = Math.max(1, Math.ceil((limit.reset - Date.now()) / 60_000))
    return NextResponse.json(
      {
        error: `Limite de testes atingido (${SIM_RATE_LIMIT.limit} mensagens a cada ${SIM_RATE_LIMIT.windowMs / 60_000} minutos, somando o simulador de fluxo). Tente de novo em ${minutes} min.`,
      },
      { status: 429, headers: { 'Retry-After': String(minutes * 60) } },
    )
  }

  // Leitura REAL com credencial (consulta somente-leitura) é só para quem tem secrets.write.
  const { request: simRequest, denied: realReadDenied } = applyRealReadPolicy(account, parsed)
  const accountData = await loadSimulationAccountData(supabaseAdmin(), account.accountId)

  try {
    const result = await simulateTurn(simRequest, {
      accountId: account.accountId,
      userId: account.userId,
      flowId: agent.agentId,
      flowName: `Teste do agente ${agent.name}`,
      ...accountData,
      agents: agent.seed,
    })
    return NextResponse.json({
      state: result.state,
      outbound: result.outbound,
      timeline: summarizeAgentTestTimeline(result.timeline),
      run: maskAgentTestRun(result.run),
      path: result.path,
      dispatch: result.dispatch,
      remaining: limit.remaining,
      agent: { name: agent.name, version: agent.version, disabled: agent.disabled },
      ...(realReadDenied ? { real_read_denied: true } : {}),
    })
  } catch (err) {
    console.error('[agents simulate] falha na simulação:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Falha ao testar o agente. Veja os logs do servidor.' }, { status: 500 })
  }
}
