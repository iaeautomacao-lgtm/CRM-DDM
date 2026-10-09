import "server-only";
// PRD 21, PR 21.4 — handler de dados DDM do Data Exchange dos WhatsApp Flows (plugado em flows-data.ts, PR 21.2).
//
// A Meta chama o endpoint do canal quando o cliente abre/avança o formulário (INIT / data_exchange / BACK), com o `flow_token` do envio:
//   fr:<run>  nó send_flow (21.4)         dq:<item da fila>  botão FLOW de template do disparador (21.3)
// O token só vale se a conta do run/item for a MESMA do canal que chamou (a URL do endpoint carrega o canal; o token sozinho não autoriza).
// Daí: contato → CPF → dívidas ativas na API DDM (consulta pontual `localiza_dev`, a mesma da régua e da IA) → `data` da tela.
//
// O QUE ESTE HANDLER NÃO FAZ (decisão do dono):
//   • não calcula proposta, desconto, número de parcelas ou entrada — regra de alçada é da OPERAÇÃO, e a tela/Flow JSON é desenhada por ela
//     na Meta. Aqui só vão dados neutros da DDM: `has_debt`, `debts_count` e `debts: [{ id, title }]` (formato de lista de seleção do Flow).
//   • não chama efetivação de acordo. A resposta do formulário vai ao fluxo como variáveis (PR 21.1) e a operação decide o que fazer.
// Sem CPF no contato ⇒ `has_debt: false` + `lookup: "no_document"`; falha da DDM ⇒ erro padrão da tela (nunca valor inventado).
// Nenhum log de CPF/valor: este módulo não loga.
import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizeDocument } from "@/lib/billing/debt-source";
import { ddmAllowance, listDdmDebts, type DdmDebtListItem } from "@/lib/billing/ddm-source";

import { parseFlowToken } from "./flow-token";
import { FLOW_UNAVAILABLE_MESSAGE, registerFlowDataHandler, type FlowDataHandler } from "./flows-data";

type Db = Pick<SupabaseClient, "from">;

export interface DdmFlowDeps {
  db: () => Db;
  /** Consulta das dívidas; padrão = API DDM com teto de consultas por conta. */
  listDebts?: (accountId: string, cpf: string) => Promise<DdmDebtListItem[]>;
  now?: () => number;
}

const CACHE_TTL_MS = 5 * 60_000; // FLOW-05: a Meta espera ≤ 3 s; telas seguintes do mesmo formulário não refazem a consulta
const CACHE_MAX = 500;
const ACTIONS = new Set(["INIT", "BACK", "data_exchange"]);

/** Resolve o token → { accountId, contactId, initScreen } SÓ se a conta bater com a do canal que chamou. */
async function resolveToken(db: Db, token: unknown, accountId: string): Promise<{ contactId: string; initScreen: string | null } | null> {
  const parsed = parseFlowToken(token);
  if (!parsed) return null;
  if (parsed.kind === "run") {
    const { data, error } = await db.from("flow_runs").select("account_id, contact_id, vars").eq("id", parsed.id).limit(1);
    const row = (data as Array<{ account_id: string; contact_id: string | null; vars: Record<string, unknown> | null }> | null)?.[0];
    if (error || !row || row.account_id !== accountId || !row.contact_id) return null;
    const screen = typeof row.vars?._flow_screen === "string" ? row.vars._flow_screen : null;
    return { contactId: row.contact_id, initScreen: screen };
  }
  const { data, error } = await db.from("disp_message_queue").select("account_id, contact_id").eq("id", parsed.id).limit(1);
  const row = (data as Array<{ account_id: string; contact_id: string | null }> | null)?.[0];
  if (error || !row || row.account_id !== accountId || !row.contact_id) return null;
  return { contactId: row.contact_id, initScreen: null };
}

export function createDdmFlowDataHandler(deps: DdmFlowDeps): FlowDataHandler {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { at: number; debts: DdmDebtListItem[] }>();
  const listDebts = deps.listDebts ?? ((accountId, cpf) => listDdmDebts(cpf, { allow: ddmAllowance(accountId) }));

  return async (request, ctx) => {
    const action = typeof request.action === "string" ? request.action : "";
    if (!ACTIONS.has(action)) return null;
    const db = deps.db();
    const resolved = await resolveToken(db, request.flow_token, ctx.accountId);
    if (!resolved) return null; // token que não é nosso (ou de outra conta): cai no erro padrão, sem dizer o porquê
    const screen = (typeof request.screen === "string" && request.screen) || resolved.initScreen;
    if (!screen) return null; // sem tela para responder (Flow sem tela inicial definida): erro padrão

    const { data: contacts, error } = await db.from("contacts").select("cpf").eq("id", resolved.contactId).eq("account_id", ctx.accountId).limit(1);
    if (error) return { screen, data: { error_message: FLOW_UNAVAILABLE_MESSAGE } };
    const cpf = normalizeDocument((contacts as Array<{ cpf: string | null }> | null)?.[0]?.cpf);
    if (!cpf) return { screen, data: { has_debt: false, debts_count: 0, debts: [], lookup: "no_document" } };

    const key = `${ctx.accountId}:${resolved.contactId}`;
    let debts = cache.get(key);
    if (!debts || now() - debts.at >= CACHE_TTL_MS) {
      try {
        debts = { at: now(), debts: await listDebts(ctx.accountId, cpf) };
      } catch {
        return { screen, data: { error_message: FLOW_UNAVAILABLE_MESSAGE } }; // DDM fora/limite: erro padrão da tela, nunca valor inventado
      }
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
      cache.set(key, debts);
    }
    return {
      screen,
      data: {
        has_debt: debts.debts.length > 0,
        debts_count: debts.debts.length,
        debts: debts.debts.map((d) => ({ id: d.external_ref, title: d.label || d.external_ref })),
      },
    };
  };
}

let registered = false;
/** Registra (uma vez por processo) o handler de dados DDM no despacho do Data Exchange. Chamado pela rota do endpoint. */
export function ensureDdmFlowDataHandler(db: () => Db): void {
  if (registered) return;
  registered = true;
  registerFlowDataHandler(createDdmFlowDataHandler({ db }));
}

/** Só para testes. */
export function resetDdmFlowDataRegistration(): void {
  registered = false;
}
