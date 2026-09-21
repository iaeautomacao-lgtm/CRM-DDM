import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Lazy, shared service-role client — mesmo padrão de
// src/lib/disparador/admin-client.ts e src/lib/flows/admin-client.ts.
// Client próprio (não reaproveita os dois acima) porque logger.ts é
// importado de módulos que não têm relação com disparador/flows (ex:
// webhook/route.ts) — importar o admin-client de um módulo de domínio
// só para logar seria acoplamento incorreto.
let _adminClient: SupabaseClient | null = null

function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || '',
      process.env.SUPABASE_SERVICE_ROLE_KEY || '',
      {
        db: {
          schema: 'wacrm',
        },
      }
    ) as any
  }
  return _adminClient!
}

// Derivados dos CHECKs de wacrm.system_logs (migration 082) — mudar a
// migration sem atualizar aqui quebra o insert em runtime (o CHECK do
// banco rejeita silenciosamente valores fora da lista, ver writeLog).
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'critical'
export type LogSource =
  | 'disparador'
  | 'webhook_meta'
  | 'webhook_waha'
  | 'flows'
  | 'ai_agent'
  | 'automations'
  | 'import'
  | 'system'
  | 'frontend'
  | 'api_v1'
  | 'feedback'

export interface WriteLogParams {
  account_id?: string | null
  level: LogLevel
  source: LogSource
  event: string
  message: string
  payload?: object
}

// Mascara telefone pros últimos 4 dígitos (ex: "+5511999998888" ->
// "****8888") — nunca logar o número completo em payload. Aceita
// qualquer formato de entrada (com/sem +, espaços, etc.), extrai só
// dígitos antes de mascarar.
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null
  const digits = phone.replace(/\D/g, '')
  if (digits.length <= 4) return '****'
  return `****${digits.slice(-4)}`
}

// Grava uma linha em wacrm.system_logs. NUNCA lança — todo call site é
// fire-and-forget por natureza (log que falha não pode derrubar o
// processo/request que está tentando logar um erro). Chame sem await
// onde o chamador já não espera nada (dentro de um .catch de promise
// solta); pode ser await'd em blocos async já existentes sem custo real
// de latência perceptível — mas nunca deve fazer o caller propagar erro.
export async function writeLog(params: WriteLogParams): Promise<void> {
  try {
    const { error } = await supabaseAdmin()
      .from('system_logs')
      .insert({
        account_id: params.account_id ?? null,
        level: params.level,
        source: params.source,
        event: params.event,
        message: params.message,
        payload: params.payload ?? null,
      })
    if (error) {
      console.error('[logger] writeLog: falha ao inserir em system_logs:', error.message)
    }
  } catch (err) {
    console.error('[logger] writeLog: exceção inesperada:', err)
  }
}
