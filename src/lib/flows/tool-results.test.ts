// IA-11: o evento tool_result/tool_called não leva CPF nem corpo bruto da DDM; o bruto fica numa tabela fechada e o
// MOTOR lê de lá — a IA recebe EXATAMENTE o que recebia (prompt herdado e iddev/sistema para efetiva_acordo).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildToolResultPayload, loadRunToolResults, resetToolResultStoreState, summarizeToolResult } from "./tool-results";
import { canonicalizeAgreementToolArgs, pickRoundToolFailure, type HandoffContextEvent } from "./engine";
import { maskCpf, maskCpfInText, maskPiiArgs } from "@/lib/privacy/mask";
import { describeEvent } from "./run-log";

vi.mock("@/lib/logger", () => ({ writeLog: vi.fn() }));

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

/** Banco em memória com as duas tabelas; `tableMissing` simula a migration 212 ausente. */
function fakeDb(opts: { tableMissing?: boolean } = {}) {
  const tables: Record<string, Row[]> = { flow_run_events: [], flow_run_tool_results: [] };
  let clock = 0;
  const db = {
    from: (table: string) => {
      const filters: Array<[string, string, unknown]> = [];
      let order: { asc: boolean } | null = null;
      let limit = Infinity;
      let insertRow: Row | null = null;
      const b: any = {};
      b.select = () => b;
      b.eq = (c: string, v: unknown) => (filters.push(["eq", c, v]), b);
      b.neq = (c: string, v: unknown) => (filters.push(["neq", c, v]), b);
      b.order = (_c: string, o?: { ascending?: boolean }) => ((order = { asc: o?.ascending !== false }), b);
      b.limit = (n: number) => ((limit = n), b);
      b.insert = (row: Row) => ((insertRow = row), b);
      b.then = (resolve: (v: unknown) => void) => {
        if (table === "flow_run_tool_results" && opts.tableMissing) return resolve({ data: null, error: { code: "42P01", message: 'relation "wacrm.flow_run_tool_results" does not exist' } });
        if (insertRow) {
          tables[table].push({ created_at: new Date(Date.UTC(2026, 9, 8, 12, 0, ++clock)).toISOString(), ...insertRow });
          return resolve({ data: null, error: null });
        }
        let rows = (tables[table] ?? []).filter((r) =>
          filters.every(([op, c, v]) => (op === "eq" ? r[c] === v : r[c] !== null && r[c] !== undefined && r[c] !== v)),
        );
        rows = [...rows].sort((a, z) => (a.created_at < z.created_at ? -1 : 1) * (order?.asc === false ? -1 : 1));
        return resolve({ data: rows.slice(0, limit).map((r) => ({ ...r })), error: null });
      };
      return b;
    },
  };
  return { db, tables, tick: () => ++clock, at: (n: number) => new Date(Date.UTC(2026, 9, 8, 12, 0, n)).toISOString() };
}

const CPF = "12345678909";
const DEVEDOR = JSON.stringify([{ nome: "MARIA DA SILVA", cpf: CPF, iddev: "7788", sistema: "CLI9", saldo: 1234.56 }]);
const DEBITOS = JSON.stringify({ Calculos: [{ nominal: "100,00", PgtoAvista: "90,00" }], PercDesconto: 10 });
const BIG = JSON.stringify({ lista: "x".repeat(9000), cpf: CPF });
const ctx = (nodeKey: string) => ({ runId: "run-1", accountId: "acc-1", nodeKey });

beforeEach(() => resetToolResultStoreState());

describe("resumo do resultado (sem valores pessoais)", () => {
  it("tamanho, formato e chaves de primeiro nível — nunca conteúdo", () => {
    expect(summarizeToolResult(DEVEDOR)).toEqual({ chars: DEVEDOR.length, format: "json_array", array_length: 1, keys: ["nome", "cpf", "iddev", "sistema", "saldo"] });
    expect(summarizeToolResult(DEBITOS)).toMatchObject({ format: "json_object", keys: ["Calculos", "PercDesconto"] });
    expect(summarizeToolResult("Erro ao executar a query")).toEqual({ chars: 24, format: "text" });
    expect(summarizeToolResult("")).toEqual({ chars: 0, format: "empty" });
    const json = JSON.stringify(summarizeToolResult(DEVEDOR));
    expect(json).not.toContain(CPF);
    expect(json).not.toContain("MARIA");
  });
});

describe("evento sem CPF inteiro e sem corpo bruto", () => {
  it("o payload do tool_result tem só resumo; o bruto vai para a tabela fechada (truncado em 8000, como antes)", async () => {
    const { db, tables } = fakeDb();
    const payload = await buildToolResultPayload(db, ctx("agente_ddm"), "localizar_devedor", DEVEDOR, null, { attempts: 1, recovered: false, httpStatus: 200 });
    const json = JSON.stringify(payload);
    expect(json).not.toContain(CPF);
    expect(json).not.toContain("MARIA");
    expect(payload).not.toHaveProperty("result");
    expect(payload).toMatchObject({ tool_name: "localizar_devedor", tool_failure: null, attempts: 1, http_status: 200, result_summary: { format: "json_array" } });
    expect(tables.flow_run_tool_results).toHaveLength(1);
    expect(tables.flow_run_tool_results[0]).toMatchObject({ flow_run_id: "run-1", account_id: "acc-1", node_key: "agente_ddm", result: DEVEDOR });

    await buildToolResultPayload(db, ctx("agente_ddm"), "consultar_debitos", BIG, null);
    const stored = tables.flow_run_tool_results[1].result as string;
    expect(stored.length).toBe(8001);
    expect(stored.endsWith("…")).toBe(true);
  });

  it("falha da integração: a mensagem de falha (a mesma do error_message) vai no payload, sem o corpo", async () => {
    const { db } = fakeDb();
    const payload = await buildToolResultPayload(db, ctx("n"), "t", '{"error":"CPF não encontrado"}', "CPF não encontrado");
    expect(payload).toMatchObject({ tool_failure: "CPF não encontrado" });
    expect(payload).not.toHaveProperty("result");
  });

  it("migration 212 ausente: grava como sempre (payload.result truncado) e não perde nada", async () => {
    const { db, tables } = fakeDb({ tableMissing: true });
    const payload = await buildToolResultPayload(db, ctx("n"), "localizar_devedor", DEVEDOR, null);
    expect(payload).toMatchObject({ tool_name: "localizar_devedor", result: DEVEDOR });
    expect(tables.flow_run_tool_results).toHaveLength(0);
    // não insiste a cada chamada
    const spy = vi.spyOn(db, "from");
    await buildToolResultPayload(db, ctx("n"), "t", "x", null);
    expect(spy).not.toHaveBeenCalled();
  });

  it("args do tool_called: CPF mascarado (***.***.***-12); os args reais não mudam; ids de negócio ficam", () => {
    const args = { cpf: CPF, idDev: "7788", cli: "CLI9", obs: `cliente ${CPF} pediu 3x` };
    const masked = maskPiiArgs(args);
    expect(masked).toEqual({ cpf: "***.***.***-09", idDev: "7788", cli: "CLI9", obs: "cliente ***.***.***-09 pediu 3x" });
    expect(JSON.stringify(masked)).not.toContain(CPF);
    expect(args.cpf).toBe(CPF); // original intacto
    expect(maskPiiArgs({ cpf: "123.456.789-09", docs: [{ documento: 12345678909 }] })).toEqual({ cpf: "***.***.***-09", docs: [{ documento: "***.***.***-09" }] });
    expect(maskCpf("123.456.789-09")).toBe("***.***.***-09");
    expect(maskCpfInText("sem cpf 12345 e 98765432100.")).toBe("sem cpf 12345 e ***.***.***-00.");
  });
});

describe("o motor lê o bruto de lá — a IA recebe exatamente o mesmo", () => {
  /** O que a consulta ANTIGA devolvia: eventos tool_result com payload.result, para `herdar_contexto_anterior`. */
  const legacyInherited = (events: Row[], excludeNode: string) =>
    events
      .filter((e) => e.node_key && e.node_key !== excludeNode && e.payload?.tool_name && e.payload?.result)
      .sort((a, z) => (a.created_at < z.created_at ? -1 : 1))
      .map((e) => ({ tool_name: e.payload.tool_name, result: e.payload.result }));

  const calls: Array<[string, string, string]> = [
    ["agente_ben", "localizar_devedor", DEVEDOR],
    ["agente_ben", "consultar_debitos", DEBITOS],
    ["agente_ben", "consultar_debitos", BIG], // > 8000: truncado igual ao de antes
    ["agente_aleh", "consultar_debitos", DEBITOS],
  ];

  it("prompt herdado: mesmos resultados, mesma ordem, mesma truncagem (novo formato × formato antigo)", async () => {
    const oldWorld = fakeDb();
    const newWorld = fakeDb();
    for (const [node, tool, result] of calls) {
      const truncated = result.length > 8000 ? result.slice(0, 8000) + "…" : result;
      oldWorld.tables.flow_run_events.push({ flow_run_id: "run-1", event_type: "tool_result", node_key: node, created_at: oldWorld.at(oldWorld.tick()), payload: { tool_name: tool, result: truncated } });
      const payload = await buildToolResultPayload(newWorld.db, ctx(node), tool, result, null);
      newWorld.tables.flow_run_events.push({ flow_run_id: "run-1", event_type: "tool_result", node_key: node, created_at: newWorld.at(newWorld.tick()), payload });
    }
    const expected = legacyInherited(oldWorld.tables.flow_run_events, "agente_aleh");
    expect(expected).toHaveLength(3);

    const viaOld = await loadRunToolResults(oldWorld.db, "run-1", { excludeNodeKey: "agente_aleh" }); // eventos antigos → fallback
    const viaNew = await loadRunToolResults(newWorld.db, "run-1", { excludeNodeKey: "agente_aleh" }); // tabela fechada
    expect(viaOld.map((r) => r.payload)).toEqual(expected);
    expect(viaNew.map((r) => r.payload)).toEqual(expected);
    // e nenhum evento do mundo novo guarda o corpo
    expect(JSON.stringify(newWorld.tables.flow_run_events)).not.toContain(CPF);
  });

  it("run misto (eventos antigos + novos) devolve a união, em ordem", async () => {
    const w = fakeDb();
    w.tables.flow_run_events.push({ flow_run_id: "run-1", event_type: "tool_result", node_key: "agente_ben", created_at: "2026-10-08T11:00:00.000Z", payload: { tool_name: "localizar_devedor", result: DEVEDOR } });
    const payload = await buildToolResultPayload(w.db, ctx("agente_ben"), "consultar_debitos", DEBITOS, null);
    w.tables.flow_run_events.push({ flow_run_id: "run-1", event_type: "tool_result", node_key: "agente_ben", created_at: w.at(w.tick()), payload });
    const out = await loadRunToolResults(w.db, "run-1", { excludeNodeKey: "agente_aleh" });
    expect(out.map((r) => r.payload.tool_name)).toEqual(["localizar_devedor", "consultar_debitos"]);
  });

  it("iddev/sistema para efetiva_acordo: idêntico ao de antes (a partir do bruto da tabela)", async () => {
    const oldWorld = fakeDb();
    const newWorld = fakeDb();
    oldWorld.tables.flow_run_events.push({ flow_run_id: "run-1", event_type: "tool_result", node_key: "n", created_at: oldWorld.at(1), payload: { tool_name: "localizar_devedor", result: DEVEDOR } });
    await buildToolResultPayload(newWorld.db, ctx("n"), "localizar_devedor", DEVEDOR, null);
    const args = { idDev: "inventado", cli: "inventado", parcelas: 3 };
    const pick = async (w: ReturnType<typeof fakeDb>) => {
      for (const e of await loadRunToolResults(w.db, "run-1", { newestFirst: true, limit: 20 })) {
        if (e.payload.tool_name !== "localizar_devedor") continue;
        const normalized = canonicalizeAgreementToolArgs(args, e.payload.result);
        if (normalized !== args) return normalized;
      }
      return args;
    };
    const before = await pick(oldWorld);
    const after = await pick(newWorld);
    expect(before).toEqual({ idDev: "7788", cli: "CLI9", parcelas: 3 });
    expect(after).toEqual(before);
  });

  it("limit 20 mais novos (como o limit(20) de antes)", async () => {
    const w = fakeDb();
    for (let i = 0; i < 25; i++) await buildToolResultPayload(w.db, ctx("n"), "t" + i, "r" + i, null);
    const out = await loadRunToolResults(w.db, "run-1", { newestFirst: true, limit: 20 });
    expect(out).toHaveLength(20);
    expect(out[0].payload.tool_name).toBe("t24");
  });
});

describe("explicação do handoff e histórico com o evento novo", () => {
  const ev = (payload: Row, created_at: string, node_type = "ai_agent"): HandoffContextEvent => ({ node_key: "n", node_type, event_type: "tool_result", payload, created_at });

  it("pickRoundToolFailure: mesmo resultado com o formato novo (tool_failure) e com o antigo (result)", () => {
    const failureOld = ev({ tool_name: "consultar_debitos", result: '{"error":"database down"}' }, "2026-10-08T12:00:00Z");
    const failureNew = ev({ tool_name: "consultar_debitos", result_summary: { chars: 25 }, tool_failure: "database down" }, "2026-10-08T12:00:00Z");
    expect(pickRoundToolFailure([failureOld], null)).toEqual({ toolError: "database down", toolName: "consultar_debitos" });
    expect(pickRoundToolFailure([failureNew], null)).toEqual(pickRoundToolFailure([failureOld], null));
    const okNew = ev({ tool_name: "consultar_debitos", result_summary: { chars: 9 }, tool_failure: null }, "2026-10-08T12:01:00Z");
    expect(pickRoundToolFailure([okNew, failureNew], null)).toEqual({ toolError: null, toolName: null }); // sucesso posterior da mesma tool
  });

  it("linha do histórico mostra o resumo no lugar do corpo", () => {
    const text = describeEvent({ event_type: "tool_result", status: "success", duration_ms: 120, payload: { tool_name: "localizar_devedor", result_summary: { format: "json_array", chars: 321 } } } as never);
    expect(text).toContain("localizar_devedor respondeu");
    expect(text).toContain("json_array, 321 caracteres");
  });
});
