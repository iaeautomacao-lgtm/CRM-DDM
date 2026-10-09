// Menu "escolha seu atendente" (PRD 23, item 16) rodando no motor de verdade pelo simulador: lista só com operadores ONLINE da equipe,
// atribuição ao escolhido, ninguém online ⇒ fila normal. Mesmas travas de "zero efeito real" do simulador.
import { describe, expect, it, vi } from "vitest";

const real = vi.hoisted(() => {
  const boom = (what: string) =>
    vi.fn(() => {
      throw new Error(`EFEITO REAL CHAMADO NA SIMULAÇÃO: ${what}`);
    });
  return {
    createClient: boom("supabase createClient"),
    supabaseAdmin: boom("flows supabaseAdmin"),
    engineSendText: boom("meta engineSendText"),
    engineSendInteractiveList: boom("meta engineSendInteractiveList"),
    engineWahaSendList: boom("waha engineWahaSendList"),
    writeLog: boom("writeLog"),
    handOffToTeamQueue: boom("handOffToTeamQueue"),
  };
});

vi.mock("@supabase/supabase-js", () => ({ createClient: real.createClient }));
vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: real.supabaseAdmin }));
vi.mock("@/lib/flows/meta-send", () => ({
  engineSendText: real.engineSendText,
  engineSendInteractiveList: real.engineSendInteractiveList,
}));
vi.mock("@/lib/flows/waha-send", () => ({ engineWahaSendList: real.engineWahaSendList }));
vi.mock("@/lib/logger", () => ({ writeLog: real.writeLog, maskPhone: (p: string) => p }));
vi.mock("@/lib/ai/team-handoff", () => ({ handOffToTeamQueue: real.handOffToTeamQueue }));

import { simulateTurn, type SimulationSeed } from "./run";
import type { SimState, SimulateRequest } from "./types";

const NODES = [
  { node_key: "start", node_type: "start", config: { next_node_key: "menu" } },
  {
    node_key: "menu",
    node_type: "send_list",
    config: {
      text: "Com quem você quer falar?",
      button_label: "Escolher",
      sections: [
        {
          rows: [
            { reply_id: "modelo", title: "Atendente", next_node_key: "h_agente" },
            { reply_id: "__no_agent", title: "ninguém", next_node_key: "h_fila" },
          ],
        },
      ],
      agent_picker: { team_id: "t1" },
    },
  },
  { node_key: "h_agente", node_type: "handoff_agent", config: { reason_code: "CLIENTE_ESCOLHEU", assign_from_var: "chosen_agent_id" } },
  { node_key: "h_fila", node_type: "handoff_team", config: { reason_code: "FILA_NORMAL", team_id: "t1" } },
];

const seed = (operators: SimulationSeed["operators"]): SimulationSeed => ({
  accountId: "acc-1",
  userId: "user-1",
  flowId: "flow-x",
  flowName: "Menu de operadores",
  aiConfig: null,
  knowledgeBase: [],
  teams: [{ id: "t1", name: "Cobrança" }],
  operators,
});

function request(message: SimulateRequest["message"], state: SimState | null, provider: "meta" | "waha" = "meta"): SimulateRequest {
  return {
    draft: { entry_node_id: "start", trigger_type: "first_inbound_message", trigger_config: {}, fallback_policy: null, nodes: NODES },
    message,
    state,
    contact: { name: "Maria Teste", phone: "5511999990000", vars: {} },
    provider,
    ignoreTrigger: true,
    toolMocks: {},
    realReadOnlyTools: [],
    httpMocks: {},
  };
}

const OPERATORS: SimulationSeed["operators"] = [
  { user_id: "u1", name: "Ana", team_id: "t1", online: true },
  { user_id: "u2", name: "Bruno", team_id: "t1", online: true },
  { user_id: "u3", name: "Carla", team_id: "t1", away: true }, // ausente: fora do menu
  { user_id: "u4", name: "Davi", team_id: "t1" }, // offline
  { user_id: "u5", name: "Outra equipe", team_id: "t2", online: true },
];

const assigned = (state: SimState) => (state.tables.conversations as Array<{ assigned_agent_id?: string | null }>)?.[0]?.assigned_agent_id ?? null;

describe("menu de operadores online no fluxo", () => {
  it("monta a lista só com operadores ONLINE da equipe; a escolha do cliente atribui a conversa àquele operador", async () => {
    const t1 = await simulateTurn(request({ kind: "text", text: "oi" }, null), seed(OPERATORS));
    expect(t1.outbound).toHaveLength(1);
    expect(t1.outbound[0].kind).toBe("list");
    const menuText = JSON.stringify(t1.outbound[0]);
    expect(menuText).toContain("Ana");
    expect(menuText).toContain("Bruno");
    for (const fora of ["Carla", "Davi", "Outra equipe", "ninguém", "__no_agent"]) expect(menuText).not.toContain(fora);
    expect(t1.run?.current_node_key).toBe("menu");

    const t2 = await simulateTurn(request({ kind: "interactive_reply", reply_id: "agent:u2", reply_title: "Bruno" }, t1.state), seed(OPERATORS));
    expect(t2.path).toContain("h_agente");
    expect(t2.run?.status).toBe("handed_off");
    expect(assigned(t2.state)).toBe("u2");
    expect(t2.run?.vars.chosen_agent_id).toBe("u2");
  });

  it("reply_id que NÃO estava no menu (ou de operador offline) não atribui ninguém: cai no reenvio do menu", async () => {
    const t1 = await simulateTurn(request({ kind: "text", text: "oi" }, null), seed(OPERATORS));
    const t2 = await simulateTurn(request({ kind: "interactive_reply", reply_id: "agent:u4", reply_title: "Davi" }, t1.state), seed(OPERATORS));
    expect(t2.run?.status).toBe("active");
    expect(t2.path).not.toContain("h_agente");
    expect(assigned(t2.state)).toBeNull();
  });

  it("ninguém online: não envia menu e segue pela linha __no_agent (fila normal da equipe)", async () => {
    const offline = OPERATORS!.map((o) => ({ ...o, online: false, away: false }));
    const t1 = await simulateTurn(request({ kind: "text", text: "oi" }, null), seed(offline));
    expect(t1.outbound.filter((o) => o.kind === "list")).toHaveLength(0);
    expect(t1.path).toContain("h_fila");
    expect(t1.run?.status).toBe("handed_off");
  });

  it("sem a linha __no_agent configurada: handoff direto para a fila da equipe (sem travar o fluxo)", async () => {
    const nodes = NODES.map((n) => n.node_key === "menu"
      ? { ...n, config: { ...n.config, sections: [{ rows: [{ reply_id: "modelo", title: "Atendente", next_node_key: "h_agente" }] }] } }
      : n);
    const req = { ...request({ kind: "text", text: "oi" }, null), draft: { ...request({ kind: "text", text: "oi" }, null).draft, nodes } };
    const t1 = await simulateTurn(req, seed([]));
    expect(t1.run?.status).toBe("handed_off");
    expect(t1.outbound.filter((o) => o.kind === "list")).toHaveLength(0);
  });

  it("também funciona na linha WAHA (lista numerada em texto: o cliente responde o número)", async () => {
    const t1 = await simulateTurn(request({ kind: "text", text: "oi" }, null, "waha"), seed(OPERATORS));
    expect(JSON.stringify(t1.outbound)).toContain("Ana");
    const t2 = await simulateTurn(request({ kind: "text", text: "2" }, t1.state, "waha"), seed(OPERATORS));
    expect(assigned(t2.state)).toBe("u2");
  });
});
