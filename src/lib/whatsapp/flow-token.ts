// PRD 21 — flow_token: correlação entre o envio de um WhatsApp Flow e o que a Meta devolve (Data Exchange e nfm_reply).
// O token é OPACO para a Meta e não leva dado pessoal: só um prefixo e o id interno.
//   fr:<id do flow_run>   nó `send_flow` (PR 21.4): uma execução do fluxo
//   dq:<id do item da fila>   botão FLOW de template do disparador (PR 21.3): um envio da campanha
// Quem o recebe valida SEMPRE a conta/canal do id contra a conta do canal que chamou (o token sozinho não autoriza nada).
export const RUN_FLOW_TOKEN_PREFIX = "fr:";
export const QUEUE_FLOW_TOKEN_PREFIX = "dq:";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ParsedFlowToken = { kind: "run"; id: string } | { kind: "queue"; id: string };

export const flowTokenForRun = (runId: string): string => `${RUN_FLOW_TOKEN_PREFIX}${runId}`;

export function parseFlowToken(token: unknown): ParsedFlowToken | null {
  if (typeof token !== "string") return null;
  for (const [prefix, kind] of [[RUN_FLOW_TOKEN_PREFIX, "run"], [QUEUE_FLOW_TOKEN_PREFIX, "queue"]] as const) {
    if (token.startsWith(prefix)) {
      const id = token.slice(prefix.length);
      return UUID_RE.test(id) ? { kind, id } : null;
    }
  }
  return null;
}
