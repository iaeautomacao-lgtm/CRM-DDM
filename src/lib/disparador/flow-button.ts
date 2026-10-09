import "server-only";
// PRD 21, PR 21.3 — template com botão FLOW no Disparador.
//
//  • flow_token POR ENVIO (RF-04): `dq:<id do item da fila>`. É determinístico (reenviar o mesmo item repete o token), único por contato e
//    permite ao Data Exchange e ao nfm_reply (PR 21.4) achar o item → conta → contato sem tabela nova nem dado pessoal no token.
//  • FLOW-03: Flow que não está PUBLISHED na Meta faz a Meta recusar 100% dos envios (131009). A campanha só é aceita depois de confirmar
//    o status na Graph API; sem conseguir confirmar, falha FECHADO (a campanha não começa) — nunca "assume publicado".
//  • No envio, só o template COM botão FLOW passa pelo caminho completo (componentes do template + token); os demais seguem o caminho de
//    corpo de sempre, sem consulta extra (a linha do template fica em cache de 5 min).
// Nada aqui chama efetivação de acordo: a resposta do formulário vai para o fluxo como dado (decisão do dono).
import type { SupabaseClient } from "@supabase/supabase-js";

import { decryptStoredSecret } from "@/lib/whatsapp/encryption";
import { getFlowStatus } from "@/lib/whatsapp/meta-api";
import type { MessageTemplate, TemplateButton } from "@/types";

type Db = Pick<SupabaseClient, "from">;

export const FLOW_TOKEN_PREFIX = "dq:";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const flowTokenForQueueItem = (queueItemId: string): string => `${FLOW_TOKEN_PREFIX}${queueItemId}`;

/** Inverso: id do item da fila, ou null se o token não for deste formato (ex.: token do nó send_flow). */
export function queueItemIdFromFlowToken(token: unknown): string | null {
  if (typeof token !== "string" || !token.startsWith(FLOW_TOKEN_PREFIX)) return null;
  const id = token.slice(FLOW_TOKEN_PREFIX.length);
  return UUID_RE.test(id) ? id : null;
}

export type FlowButton = Extract<TemplateButton, { type: "FLOW" }>;

export function flowButtonsOf(buttons: ReadonlyArray<{ type?: unknown }> | null | undefined): FlowButton[] {
  return (buttons ?? []).filter((b): b is FlowButton => String(b?.type ?? "").toUpperCase() === "FLOW");
}

// ---- linha do template no envio ----------------------------------------------------------------------------------------------------
const TEMPLATE_TTL_MS = 5 * 60_000;
const CACHE_MAX = 200;
const templateCache = new Map<string, { at: number; row: MessageTemplate | null }>();

/** Só para testes. */
export function resetFlowButtonCaches(): void {
  templateCache.clear();
  statusCache.clear();
}

/**
 * Linha APPROVED do template (da WABA do canal) quando ele tem botão FLOW; null quando não tem (o envio segue o caminho de sempre).
 * Falha de leitura devolve null: o envio cai no caminho de corpo e a Meta recusa — nunca inventa um botão.
 */
export async function loadFlowTemplate(
  db: Db,
  accountId: string,
  wabaId: string | null | undefined,
  name: string,
  language: string,
  now = Date.now(),
): Promise<MessageTemplate | null> {
  const key = `${accountId}|${wabaId ?? ""}|${name}|${language}`;
  const hit = templateCache.get(key);
  if (hit && now - hit.at < TEMPLATE_TTL_MS) return hit.row;

  let row: MessageTemplate | null;
  try {
    let query = db.from("message_templates").select("*").eq("account_id", accountId).eq("name", name).eq("language", language).eq("status", "APPROVED");
    if (wabaId) query = query.eq("waba_id", wabaId);
    const { data, error } = await query.limit(5);
    if (error) return null; // não guarda em cache: tenta de novo no próximo envio
    row = ((data ?? []) as MessageTemplate[]).find((r) => flowButtonsOf(r.buttons).length > 0) ?? null;
  } catch {
    return null;
  }
  if (templateCache.size >= CACHE_MAX) templateCache.delete(templateCache.keys().next().value as string);
  templateCache.set(key, { at: now, row });
  return row;
}

// ---- Flow publicado? (FLOW-03) -----------------------------------------------------------------------------------------------------
const STATUS_TTL_MS = 60_000;
const statusCache = new Map<string, { at: number; status: string }>();

export interface FlowCheckDeps {
  getStatus?: (args: { flowId: string; accessToken: string }) => Promise<{ status: string }>;
  now?: () => number;
}

interface TemplateWithButtons {
  name: string;
  language?: string | null;
  status?: string | null;
  buttons?: ReadonlyArray<{ type?: unknown }> | null;
}

/**
 * Problemas (texto pt-BR) de campanha Meta cujos templates APROVADOS têm botão FLOW: Flow sem id, ou fora de PUBLISHED, ou status que não
 * deu para confirmar. Lista vazia = pode seguir. `channelIds` = canais Meta da campanha (o status é conferido com o token de cada um).
 */
export async function flowPublishProblems(
  db: Db,
  accountId: string,
  channelIds: readonly string[],
  rows: readonly TemplateWithButtons[],
  deps: FlowCheckDeps = {},
): Promise<string[]> {
  const withFlow = rows.filter((r) => (r.status ?? "").toUpperCase() === "APPROVED" && flowButtonsOf(r.buttons).length > 0);
  if (withFlow.length === 0 || channelIds.length === 0) return [];
  const getStatus = deps.getStatus ?? getFlowStatus;
  const now = deps.now ?? Date.now;

  const { data, error } = await db.from("whatsapp_config").select("id, access_token").eq("account_id", accountId).in("id", [...channelIds]);
  if (error) return ["Não foi possível ler os canais para conferir o Flow do template. Tente novamente."];
  const tokens = new Map<string, string>();
  for (const c of (data ?? []) as Array<{ id: string; access_token: string | null }>) {
    if (!c.access_token) continue;
    try {
      tokens.set(c.id, decryptStoredSecret(c.access_token, "token de acesso Meta"));
    } catch {
      /* canal sem token legível: cai no problema abaixo */
    }
  }

  const problems: string[] = [];
  const seen = new Set<string>();
  for (const row of withFlow) {
    for (const button of flowButtonsOf(row.buttons)) {
      const label = `Template "${row.name}" (${row.language ?? "pt_BR"})`;
      if (!button.flow_id) {
        problems.push(`${label} tem botão de Flow sem o id do Flow (só o nome). Sincronize os templates ou use um template com flow_id para o CRM conferir se o Flow está publicado.`);
        continue;
      }
      for (const channelId of channelIds) {
        const key = `${channelId}|${button.flow_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const token = tokens.get(channelId);
        if (!token) {
          problems.push(`${label}: canal sem token de acesso legível para conferir o Flow ${button.flow_id}. Reconecte o canal.`);
          continue;
        }
        let status = statusCache.get(key);
        if (!status || now() - status.at >= STATUS_TTL_MS) {
          try {
            status = { at: now(), status: (await getStatus({ flowId: button.flow_id, accessToken: token })).status.toUpperCase() };
            statusCache.set(key, status);
          } catch {
            problems.push(`${label}: não foi possível confirmar na Meta o status do Flow ${button.flow_id}. A campanha não começa sem essa confirmação; tente de novo em instantes.`);
            continue;
          }
        }
        if (status.status !== "PUBLISHED") {
          problems.push(`${label}: o Flow ${button.flow_id} está ${status.status || "sem status"} na Meta, não PUBLISHED — a Meta recusaria todos os envios (131009). Publique o Flow no WhatsApp Manager antes de iniciar.`);
        }
      }
    }
  }
  return problems;
}
