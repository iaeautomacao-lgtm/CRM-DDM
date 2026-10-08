/* eslint-disable @typescript-eslint/no-explicit-any -- cliente admin com schema wacrm */
// Resultado das tools da IA: BRUTO numa tabela fechada, RESUMO no evento (PRD 13, IA-11 / migration 212).
//
// Antes, flow_run_events.payload.result guardava até 8.000 caracteres do corpo da DDM (CPF, nomes, valores) e esse
// evento é exibido na API/export/histórico de runs. Mas o próprio motor relê esse texto:
//   - herdar_contexto_anterior (prompt do próximo nó de IA);
//   - canonicalizeAgreementArgsFromRun (iddev/sistema do localizar_devedor para efetiva_acordo).
// Então o bruto passa a ficar em wacrm.flow_run_tool_results (RLS fechada, só service_role, fora da API de runs) e o
// motor lê DALI, com fallback ao payload.result antigo (eventos anteriores à migration, ou tabela ausente).
// A IA recebe EXATAMENTE o mesmo texto de antes (o que é gravado/lido continua truncado em 8.000, como sempre).

type Db = any;

export const TOOL_RESULT_STORE_MAX_CHARS = 8000;

export interface ToolResultMeta {
  attempts?: number;
  recovered?: boolean;
  failureCode?: string | null;
  httpStatus?: number | null;
}

/** Resumo SEM valores pessoais: tamanho, formato e chaves de primeiro nível (nomes de campo, nunca conteúdo). */
export function summarizeToolResult(result: string): Record<string, unknown> {
  const trimmed = result.trim();
  const base = { chars: result.length };
  if (!trimmed) return { ...base, format: "empty" };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      const first = parsed[0];
      return {
        ...base,
        format: "json_array",
        array_length: parsed.length,
        keys: first && typeof first === "object" && !Array.isArray(first) ? Object.keys(first as object).slice(0, 30) : [],
      };
    }
    if (parsed && typeof parsed === "object") return { ...base, format: "json_object", keys: Object.keys(parsed as object).slice(0, 30) };
    return { ...base, format: "json_scalar" };
  } catch {
    return { ...base, format: "text" };
  }
}

// Migration 212 ausente: não insiste a cada chamada; confere de novo depois de 60 s.
const MISSING_RECHECK_MS = 60_000;
let storeMissingUntil = 0;

/** Só para testes. */
export function resetToolResultStoreState(): void {
  storeMissingUntil = 0;
}

function isMissingTable(error: { code?: string; message?: string } | null | undefined): boolean {
  return error?.code === "42P01" || error?.code === "PGRST205" || /does not exist|schema cache|relation .* not found/i.test(error?.message ?? "");
}

/**
 * Guarda o bruto na tabela fechada e devolve o payload do EVENTO tool_result (só resumo). Sem a tabela (migration 212
 * ausente) ou com falha ao gravar, devolve o payload de sempre (com `result` truncado) — nunca perde o resultado.
 */
export async function buildToolResultPayload(
  db: Db,
  ctx: { runId: string; accountId: string; nodeKey: string | null },
  toolName: string,
  result: string,
  failure: string | null,
  meta?: ToolResultMeta,
  now: number = Date.now(),
): Promise<Record<string, unknown>> {
  const truncated = result.length > TOOL_RESULT_STORE_MAX_CHARS ? result.slice(0, TOOL_RESULT_STORE_MAX_CHARS) + "…" : result;
  const common = {
    tool_name: toolName,
    attempts: meta?.attempts ?? 1,
    recovered: meta?.recovered ?? false,
    failure_code: meta?.failureCode ?? null,
    http_status: meta?.httpStatus ?? null,
  };
  const legacy = { ...common, result: truncated };
  if (now < storeMissingUntil) return legacy;
  try {
    const { error } = await db.from("flow_run_tool_results").insert({
      flow_run_id: ctx.runId,
      account_id: ctx.accountId,
      node_key: ctx.nodeKey,
      tool_name: toolName,
      result: truncated,
    });
    if (error) {
      if (isMissingTable(error)) storeMissingUntil = now + MISSING_RECHECK_MS;
      else console.error("[flows] falha ao guardar o resultado bruto da tool:", error.message);
      return legacy;
    }
  } catch (err) {
    console.error("[flows] falha ao guardar o resultado bruto da tool:", err instanceof Error ? err.message : err);
    return legacy;
  }
  return { ...common, result_summary: summarizeToolResult(result), tool_failure: failure };
}

export interface StoredToolResult {
  payload: { tool_name: string; result: string };
  node_key: string | null;
  created_at: string;
}

export interface LoadToolResultsOptions {
  /** Só resultados de OUTROS nós (como o `.neq("node_key")` de antes: node_key nulo também fica de fora). */
  excludeNodeKey?: string;
  /** Mais novos primeiro (padrão: do mais antigo para o mais novo). */
  newestFirst?: boolean;
  /** Teto sobre o conjunto unido (a consulta antiga usava limit(20) nos eventos mais novos). */
  limit?: number;
}

/**
 * Resultados brutos das tools de um run, de onde estiverem: tabela fechada (migration 212) + eventos antigos que ainda
 * têm `payload.result`. Cada resultado vive em UM só lugar, então a união é o mesmo conjunto que a consulta antiga via.
 */
export async function loadRunToolResults(db: Db, runId: string, options: LoadToolResultsOptions = {}): Promise<StoredToolResult[]> {
  const ascending = !options.newestFirst;
  const rows: Array<StoredToolResult & { order: number }> = [];

  // 1) eventos (formato antigo): só os que carregam o resultado.
  {
    let query = db.from("flow_run_events").select("payload, node_key, created_at").eq("flow_run_id", runId).eq("event_type", "tool_result");
    if (options.excludeNodeKey !== undefined) query = query.neq("node_key", options.excludeNodeKey);
    query = query.order("created_at", { ascending });
    if (options.limit && !ascending) query = query.limit(options.limit * 2);
    const { data } = await query;
    for (const event of (data ?? []) as Array<{ payload: any; node_key: string | null; created_at: string }>) {
      const p = event.payload as { tool_name?: string; result?: unknown } | null;
      // Evento novo (só resumo) não tem `result`: o bruto está na tabela.
      if (!p || typeof p.result !== "string" || !p.tool_name) continue;
      rows.push({ payload: { tool_name: p.tool_name, result: p.result }, node_key: event.node_key, created_at: event.created_at, order: 0 });
    }
  }

  // 2) tabela fechada (migration 212). Ausente = só o formato antigo.
  if (Date.now() >= storeMissingUntil) {
    let query = db.from("flow_run_tool_results").select("tool_name, result, node_key, created_at").eq("flow_run_id", runId);
    if (options.excludeNodeKey !== undefined) query = query.neq("node_key", options.excludeNodeKey);
    query = query.order("created_at", { ascending });
    if (options.limit && !ascending) query = query.limit(options.limit);
    const { data, error } = await query;
    if (error) {
      if (isMissingTable(error)) storeMissingUntil = Date.now() + MISSING_RECHECK_MS;
      else console.error("[flows] falha ao ler os resultados brutos das tools:", error.message);
    } else {
      for (const r of (data ?? []) as Array<{ tool_name: string; result: string; node_key: string | null; created_at: string }>) {
        rows.push({ payload: { tool_name: r.tool_name, result: r.result }, node_key: r.node_key, created_at: r.created_at, order: 1 });
      }
    }
  }

  rows.sort((a, b) => {
    const diff = Date.parse(a.created_at) - Date.parse(b.created_at);
    return (ascending ? diff : -diff) || (ascending ? a.order - b.order : b.order - a.order);
  });
  const limited = options.limit ? rows.slice(0, options.limit) : rows;
  return limited.map(({ order: _order, ...rest }) => rest);
}
