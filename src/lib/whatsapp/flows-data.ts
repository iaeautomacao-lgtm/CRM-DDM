// PRD 21, PR 21.2 — despacho das requisições JÁ DECIFRADAS do Data Exchange dos WhatsApp Flows.
//
// Ações da Meta: `ping` (verificação de saúde), `error_notification` (a Meta avisa de um erro na tela) e `INIT` / `data_exchange` / `BACK`
// (o conteúdo das telas). O CONTEÚDO das telas — nomes de tela e campos — é desenho da OPERAÇÃO no Flow Builder da Meta; por isso aqui
// ele é plugável: handlers registrados (PR 21.4: dados de acordo da DDM por flow_token) respondem; sem handler, a resposta é a de erro
// padrão da Meta (`error_message` na tela atual), nunca um valor inventado. Nenhuma efetivação de acordo é feita aqui (decisão do dono).
export interface FlowDataContext {
  accountId: string;
  channelId: string;
}

export type FlowRequestBody = Record<string, unknown>;
export type FlowResponseBody = Record<string, unknown>;
/** Devolve a resposta da tela, ou null/undefined quando a requisição não é deste handler. */
export type FlowDataHandler = (request: FlowRequestBody, ctx: FlowDataContext) => Promise<FlowResponseBody | null | undefined>;

const handlers: FlowDataHandler[] = [];

export function registerFlowDataHandler(handler: FlowDataHandler): () => void {
  handlers.push(handler);
  return () => {
    const i = handlers.indexOf(handler);
    if (i >= 0) handlers.splice(i, 1);
  };
}

export const FLOW_UNAVAILABLE_MESSAGE = "Formulário indisponível no momento. Tente novamente em instantes.";

export async function handleFlowData(request: FlowRequestBody, ctx: FlowDataContext): Promise<{ action: string; response: FlowResponseBody }> {
  const action = typeof request.action === "string" ? request.action.slice(0, 40) : "unknown";
  if (action === "ping") return { action, response: { data: { status: "active" } } };
  if (action === "error_notification") return { action, response: { data: { acknowledged: true } } };
  for (const handler of [...handlers]) {
    const out = await handler(request, ctx);
    if (out) return { action, response: out };
  }
  return { action, response: { screen: typeof request.screen === "string" ? request.screen : "", data: { error_message: FLOW_UNAVAILABLE_MESSAGE } } };
}
