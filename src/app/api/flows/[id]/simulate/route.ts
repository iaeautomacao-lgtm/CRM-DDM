import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { can } from '@/lib/auth/permissions'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit } from '@/lib/rate-limit'
import { applyRealReadPolicy, parseSimulateRequest, SIM_MAX_BODY_CHARS } from '@/lib/flows/simulator/parse'
import { simulateTurn } from '@/lib/flows/simulator/run'
import { loadSimulationAccountData } from '@/lib/flows/simulator/seed'
import { SIM_RATE_LIMIT } from '@/lib/flows/simulator/types'

/**
 * POST /api/flows/[id]/simulate — painel "Testar fluxo" (PRD 05).
 *
 * Processa UMA mensagem do "cliente" no motor real, com o RASCUNHO do
 * editor (nós ainda não publicados) e os efeitos de simulação: nada é
 * enviado pelo WhatsApp, nada é gravado em tabela real, tools com mock.
 * Stateless — o cliente manda o estado da simulação e recebe o novo.
 *
 * Supervisor ou acima, e o fluxo tem que ser visível ao usuário (RLS,
 * mesma checagem do editor). Limite de custo: SIM_RATE_LIMIT por usuário
 * (cada mensagem pode chamar o modelo de IA).
 *
 * Leituras reais (só SELECT, fora do escopo da simulação): ai_config da
 * conta (fica no servidor — nunca volta na resposta), base de
 * conhecimento e nomes das equipes.
 */
export const maxDuration = 120

type Admin = ReturnType<typeof supabaseAdmin>

/** Leitura (só SELECT) dos agentes e da versão publicada usados pelo rascunho. Falha ⇒ sem agentes (o nó cai em "indisponível"). */
async function loadSimulationAgents(admin: Admin, accountId: string, agentIds: string[]) {
  const empty = { agents: [], versions: [], ruleVersions: [] }
  if (agentIds.length === 0) return empty
  const { data: agents, error } = await admin
    .from('ai_agents')
    .select('id, name, enabled, published_version_id')
    .eq('account_id', accountId)
    .in('id', agentIds)
  if (error || !agents?.length) return empty
  const versionIds = agents.map((a) => a.published_version_id as string | null).filter((v): v is string => !!v)
  if (versionIds.length === 0) return { ...empty, agents }
  const { data: versions } = await admin
    .from('ai_agent_versions')
    .select('id, agent_id, version, config, prompt_content, composition, config_hash')
    .eq('account_id', accountId)
    .in('id', versionIds)
  const ruleIds = new Set<string>()
  for (const v of versions ?? []) {
    const rules = (v.config as { rules?: Array<{ rule_version_id?: string }> } | null)?.rules ?? []
    for (const r of rules) if (r.rule_version_id) ruleIds.add(r.rule_version_id)
  }
  const { data: ruleVersions } = ruleIds.size
    ? await admin.from('ai_rule_versions').select('id, rule_id, version, content').eq('account_id', accountId).in('id', [...ruleIds])
    : { data: [] }
  return { agents, versions: versions ?? [], ruleVersions: ruleVersions ?? [] }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params

  let account
  try {
    account = await getCurrentAccount()
  } catch (err) {
    return toErrorResponse(err)
  }
  if (!can(account, 'flows.simulate')) {
    return NextResponse.json(
      { error: 'O simulador de fluxo é restrito a supervisor ou acima.' },
      { status: 403 },
    )
  }

  const { data: flow } = await account.supabase
    .from('flows')
    .select('id, account_id, name, user_id')
    .eq('id', id)
    .maybeSingle()
  if (!flow || flow.account_id !== account.accountId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const rawText = await request.text()
  if (rawText.length > SIM_MAX_BODY_CHARS) {
    return NextResponse.json(
      { error: 'Simulação longa demais — clique em Reiniciar.' },
      { status: 413 },
    )
  }
  let raw: unknown
  try {
    raw = JSON.parse(rawText)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const parsed = parseSimulateRequest(raw)
  if (typeof parsed === 'string') {
    return NextResponse.json({ error: parsed }, { status: 400 })
  }

  const limit = await checkRateLimit(`flows:simulate:${account.userId}`, SIM_RATE_LIMIT)
  if (!limit.success) {
    const minutes = Math.max(1, Math.ceil((limit.reset - Date.now()) / 60_000))
    return NextResponse.json(
      {
        error: `Limite do simulador atingido (${SIM_RATE_LIMIT.limit} mensagens a cada ${SIM_RATE_LIMIT.windowMs / 60_000} minutos). Tente de novo em ${minutes} min.`,
      },
      { status: 429, headers: { 'Retry-After': String(minutes * 60) } },
    )
  }

  const admin = supabaseAdmin()
  const accountData = await loadSimulationAccountData(admin, account.accountId)

  // Agentes dos nós do rascunho: só a versão PUBLICADA (o simulador não fixa versão por run).
  const agentIds = [
    ...new Set(
      parsed.draft.nodes
        .map((n) => (n.config as { agent_id?: unknown } | null)?.agent_id)
        .filter((v): v is string => typeof v === 'string' && v !== ''),
    ),
  ]
  const agents = await loadSimulationAgents(admin, account.accountId, agentIds)

  // Leitura REAL com credencial (consulta somente-leitura) é só para admin/owner: supervisor
  // continua simulando, mas tudo mockado (nunca usa credencial da conta nem da plataforma).
  const { request: simRequest, denied: realReadDenied } = applyRealReadPolicy(account, parsed)

  try {
    const result = await simulateTurn(simRequest, {
      accountId: account.accountId,
      userId: (flow.user_id as string | null) ?? account.userId,
      flowId: flow.id as string,
      flowName: (flow.name as string | null) ?? 'Fluxo',
      ...accountData,
      agents,
    })
    return NextResponse.json({ ...result, remaining: limit.remaining, ...(realReadDenied ? { real_read_denied: true } : {}) })
  } catch (err) {
    console.error('[flows simulate] falha na simulação:', err)
    return NextResponse.json(
      { error: 'Falha ao simular a mensagem. Veja os logs do servidor.' },
      { status: 500 },
    )
  }
}
