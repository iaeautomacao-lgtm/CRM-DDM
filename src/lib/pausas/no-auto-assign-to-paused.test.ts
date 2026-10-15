// Decisão do dono (15/10): pausa é do SISTEMA e "pausado não recebe conversa nova" vale para TODA atribuição automática, sem chave e sem fluxo.
// Este teste prova isso de duas formas:
//   1. comportamento: cada via de auto-atribuição (seleção da equipe/conta — usada pela fila, retry, round-robin, handoff_team do motor,
//      transbordo e handoff da IA —, menu "escolha seu atendente" e handoff da IA) nunca devolve quem está em pausa, mesmo no fallback de "ausente";
//      sem conseguir ler as pausas, ninguém é atribuído (fail-closed); sem a migration 370 não há pausa nenhuma;
//   2. cobertura: TODO arquivo do código que grava assigned_agent_id está numa lista fechada (automático × manual/próprio). Rota ou ponto
//      novo de atribuição automática que não passe pelo critério único (src/lib/pausas/availability.ts) quebra aqui.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { createMemoryDb, type SimTables } from "@/lib/flows/simulator/memory-db";
import { selectAgentForTeam, selectAnyAgentForAccount } from "@/lib/flows/engine";
import { listOnlineAgents } from "@/lib/flows/agent-picker";
import { handOffToTeamQueue } from "@/lib/ai/team-handoff";
import { filterAvailableAgents, isAgentPaused, pausedAgentIds } from "./availability";

const ACC = "acc-1";
const fresh = () => new Date(Date.now() - 5_000).toISOString();

function tables(over: Partial<SimTables> = {}): SimTables {
  return {
    teams: [{ id: "t1", account_id: ACC, overflow_team_id: "t2" }, { id: "t2", account_id: ACC, overflow_team_id: null }],
    team_members: [
      { team_id: "t1", user_id: "u1", created_at: "2026-01-01T00:00:00Z" },
      { team_id: "t1", user_id: "u2", created_at: "2026-01-02T00:00:00Z" },
      { team_id: "t1", user_id: "u3", created_at: "2026-01-03T00:00:00Z" },
      { team_id: "t2", user_id: "u9", created_at: "2026-01-04T00:00:00Z" },
    ],
    profiles: ["u1", "u2", "u3", "u9"].map((u, i) => ({ user_id: u, account_id: ACC, account_role: "agent", full_name: `Agente ${u}`, max_simultaneous_chats: null, created_at: `2026-01-0${i + 1}T00:00:00Z`, deactivated_at: null })),
    member_presence: [
      { user_id: "u1", status: "online", last_seen_at: fresh() },
      { user_id: "u2", status: "online", last_seen_at: fresh() },
      { user_id: "u3", status: "away", last_seen_at: fresh() },
      { user_id: "u9", status: "online", last_seen_at: fresh() },
    ],
    conversations: [{ id: "c-t1", account_id: ACC, team_id: "t1", assigned_agent_id: null, status: "pending" }],
    agent_pauses: [],
    ...over,
  };
}
const pause = (user: string, ended: string | null = null) => ({ id: `p-${user}`, user_id: user, account_id: ACC, reason_name: "Almoço", started_at: fresh(), ended_at: ended });
const dbOf = (t: SimTables) => createMemoryDb({ tables: t, clock: { last: 0 } }) as never;

/** Banco cujas leituras de agent_pauses falham com o erro dado. */
function dbWithBrokenPauses(t: SimTables, error: { code?: string; message: string }) {
  const real = createMemoryDb({ tables: t, clock: { last: 0 } }) as unknown as { from: (table: string) => unknown };
  return {
    ...real,
    from: (table: string) => {
      if (table !== "agent_pauses") return real.from(table);
      const b: Record<string, unknown> = {};
      for (const m of ["select", "in", "is", "eq"]) b[m] = () => b;
      b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error }).then(ok);
      return b;
    },
  } as never;
}

describe("selectAgentForTeam / selectAnyAgentForAccount (fila, retry, round-robin, handoff_team, transbordo, IA)", () => {
  it("equipe: pula o pausado e escolhe o próximo online", async () => {
    expect(await selectAgentForTeam(dbOf(tables()), "t1", ACC)).toBe("u1"); // sem pausa: o mais antigo
    expect(await selectAgentForTeam(dbOf(tables({ agent_pauses: [pause("u1")] })), "t1", ACC)).toBe("u2");
  });

  it("equipe: todos os online pausados cai no 'ausente' NÃO pausado — nunca no pausado", async () => {
    const got = await selectAgentForTeam(dbOf(tables({ agent_pauses: [pause("u1"), pause("u2")] })), "t1", ACC);
    expect(got).toBe("u3");
    const none = await selectAgentForTeam(dbOf(tables({ agent_pauses: [pause("u1"), pause("u2"), pause("u3")] })), "t1", ACC);
    expect(["u1", "u2", "u3"]).not.toContain(none); // vai ao transbordo (u9) ou fica sem dono, nunca a um pausado da equipe
    expect(none).toBe("u9");
  });

  it("transbordo: se o atendente do transbordo também está pausado, ninguém recebe (fica na fila)", async () => {
    const got = await selectAgentForTeam(dbOf(tables({ agent_pauses: [pause("u1"), pause("u2"), pause("u3"), pause("u9")] })), "t1", ACC);
    expect(got).toBeNull();
  });

  it("conta toda (conversa sem equipe): o mesmo critério", async () => {
    expect(await selectAnyAgentForAccount(dbOf(tables({ agent_pauses: [pause("u1")] })), ACC)).toBe("u2");
    expect(await selectAnyAgentForAccount(dbOf(tables({ agent_pauses: [pause("u1"), pause("u2"), pause("u9")] })), ACC)).toBe("u3"); // away não pausado
    expect(await selectAnyAgentForAccount(dbOf(tables({ agent_pauses: ["u1", "u2", "u3", "u9"].map((u) => pause(u)) })), ACC)).toBeNull();
  });

  it("pausa encerrada não conta; a de outra pessoa não afeta", async () => {
    expect(await selectAgentForTeam(dbOf(tables({ agent_pauses: [pause("u1", new Date().toISOString())] })), "t1", ACC)).toBe("u1");
  });

  it("FAIL-CLOSED: sem conseguir ler as pausas ninguém é atribuído (a conversa espera o retry)", async () => {
    const broken = dbWithBrokenPauses(tables(), { code: "XX000", message: "boom" });
    expect(await selectAgentForTeam(broken, "t1", ACC)).toBeNull();
    expect(await selectAnyAgentForAccount(broken, ACC)).toBeNull();
  });

  it("sem a migration 370 (tabela inexistente) não há pausa nenhuma: segue como antes", async () => {
    const missing = dbWithBrokenPauses(tables(), { code: "42P01", message: "relation does not exist" });
    expect(await selectAgentForTeam(missing, "t1", ACC)).toBe("u1");
    expect(await selectAnyAgentForAccount(missing, ACC)).toBe("u1");
  });
});

describe("menu 'escolha seu atendente' (listOnlineAgents)", () => {
  it("o pausado não aparece", async () => {
    const t = tables({ agent_pauses: [pause("u1")] });
    const agents = await listOnlineAgents(dbOf(t), ACC, "t1");
    expect(agents.map((a) => a.user_id)).toEqual(["u2"]);
  });
  it("sem equipe: também filtra", async () => {
    const agents = await listOnlineAgents(dbOf(tables({ agent_pauses: [pause("u1"), pause("u9")] })), ACC, undefined);
    expect(agents.map((a) => a.user_id)).toEqual(["u2"]);
  });
});

describe("handoff da IA para a fila da equipe (handOffToTeamQueue)", () => {
  it("atribui a quem não está em pausa", async () => {
    const t = tables({ agent_pauses: [pause("u1")] });
    const out = await handOffToTeamQueue(dbOf(t), ACC, "c-t1", "[teste]");
    expect(out).toMatchObject({ ok: true, assignedTo: "u2" });
    expect(t.conversations![0].assigned_agent_id).toBe("u2");
  });
  it("todos pausados: a conversa fica pendente, sem dono", async () => {
    const t = tables({ agent_pauses: ["u1", "u2", "u3", "u9"].map((u) => pause(u)) });
    const out = await handOffToTeamQueue(dbOf(t), ACC, "c-t1", "[teste]");
    expect(out).toMatchObject({ ok: true, assignedTo: null });
    expect(t.conversations![0].assigned_agent_id).toBeNull();
  });
});

describe("critério único (availability)", () => {
  it("filterAvailableAgents mantém a ordem; isAgentPaused", async () => {
    const db = dbOf(tables({ agent_pauses: [pause("u2")] }));
    expect(await filterAvailableAgents(db, ["u1", "u2", "u3"])).toEqual(["u1", "u3"]);
    expect(await isAgentPaused(db, "u2")).toBe(true);
    expect(await isAgentPaused(db, "u1")).toBe(false);
    expect(await filterAvailableAgents(db, [])).toEqual([]);
    expect([...(await pausedAgentIds(db, ["u1", "u2"]))]).toEqual(["u2"]);
  });
});

// ── cobertura: todo ponto que grava assigned_agent_id ───────────────────────────────────────────────────────────────────
const SRC = resolve(process.cwd(), "src");
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !name.endsWith(".sql.test.ts")) out.push(p);
  }
  return out;
}
const WRITE = /\.update\(\s*\{[^}]*?assigned_agent_id\s*:|\.assigned_agent_id\s*=[^=]/;

/** Atribuição AUTOMÁTICA: precisa do critério único (availability) ou dos seletores que o aplicam. */
const AUTOMATIC: Record<string, RegExp> = {
  "lib/flows/engine.ts": /from "@\/lib\/pausas\/availability"/, // seletores de equipe/conta, handoff fixo e escolhido no menu
  "lib/ai/responder.ts": /from "@\/lib\/pausas\/availability"/, // handoff da IA para o dono da linha
  "lib/ai/team-handoff.ts": /selectAgentForTeam[\s\S]*selectAnyAgentForAccount/, // via seletores do engine
  "app/api/conversations/retry-assignment/route.ts": /selectAgentForTeam[\s\S]*selectAnyAgentForAccount/, // fila/retry via seletores
};
/** Atribuição MANUAL ou a si mesmo (o servidor pede confirmação ao atribuir a pausado, ou é o próprio usuário). */
const MANUAL: Record<string, string> = {
  "app/api/conversations/[id]/transfer/route.ts": "confirmação no servidor (agent_paused → 409 / confirm_paused)",
  "app/api/conversations/[id]/assign-self/route.ts": "o próprio atendente assume",
  "app/api/whatsapp/send/route.ts": "quem responde assume a conversa",
  "lib/conversations/batch.ts": "transferir para mim (lote)",
  "lib/conversations/outcome.ts": "quem tabula assume",
  "lib/api/v1/conversations-control.ts": "API pública (transferir/atribuir): confirmação no servidor (agent_paused → 409 / confirm_paused)",
};

describe("cobertura: toda atribuição de conversa está classificada", () => {
  const writers = walk(SRC)
    .filter((f) => WRITE.test(readFileSync(f, "utf8")))
    .map((f) => relative(SRC, f).split("\\").join("/"));

  it("só existem os pontos conhecidos (ponto novo = decidir: automático passa por availability; manual tem confirmação)", () => {
    const known = new Set([...Object.keys(AUTOMATIC), ...Object.keys(MANUAL)]);
    const unknown = writers.filter((w) => !known.has(w));
    expect(unknown, `pontos novos que gravam assigned_agent_id: ${unknown.join(", ")}`).toEqual([]);
    for (const k of known) expect(writers, `${k} deixou de gravar assigned_agent_id? remova da lista`).toContain(k);
  });

  it.each(Object.entries(AUTOMATIC))("automático %s usa o critério único de pausa", (file, needs) => {
    expect(readFileSync(join(SRC, file), "utf8")).toMatch(needs);
  });

  it("a rota de transferência pede a confirmação de pausado e a trava do banco existe", () => {
    const transfer = readFileSync(join(SRC, "app/api/conversations/[id]/transfer/route.ts"), "utf8");
    expect(transfer).toMatch(/agent_paused/);
    expect(transfer).toMatch(/confirm_paused/);
    const mig = readFileSync(resolve(process.cwd(), "supabase/migrations/371_pausas_distribuicao.sql"), "utf8");
    expect(mig).toMatch(/trg_guard_paused_assignment/);
  });

  it("os atendentes fixos/escolhidos do motor passam pela checagem de pausa", () => {
    const engine = readFileSync(join(SRC, "lib/flows/engine.ts"), "utf8");
    expect(engine).toMatch(/cfg\.assign_to && !\(await isAgentPaused\(db, cfg\.assign_to\)\)/);
    expect(engine).toMatch(/assignTo && !\(await isAgentPaused\(db, assignTo\)\)/);
    expect((engine.match(/filterAvailableAgents\(db, eligibleIds\)/g) ?? []).length).toBe(4); // online e away, equipe e conta
  });
});
