// Conexões HTTP reaproveitadas SÓ para a Meta (P1-3a): a 80 envios/s por número, abrir TCP+TLS a cada envio é desperdício.
// Um Agent do undici com keep-alive e até 128 conexões simultâneas, criado uma vez por processo e passado como `dispatcher`
// ao fetch em meta-api.ts. Nenhum outro destino (WAHA, OpenAI, webhooks…) usa este Agent.
import "server-only";
import { Agent } from 'undici'

export const META_AGENT_OPTIONS = { connections: 128, keepAliveTimeout: 30_000, pipelining: 1 } as const

let agent: Agent | null = null

/** Agent único da Meta (criado no primeiro uso). */
export function getMetaDispatcher(): Agent {
  agent ??= new Agent({ ...META_AGENT_OPTIONS })
  return agent
}
