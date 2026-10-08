// Simulador de fluxo (PRD 05): roda o fluxo oficial no motor de verdade
// (dispatchInboundToFlows) com TODO efeito real "explodindo" se for
// chamado — Supabase, Meta, WAHA, Webchat/Instagram, system_logs e
// qualquer fetch que não seja o modelo da OpenAI (simulado aqui). Prova
// que a simulação não grava em tabela real, não envia nada e não chama
// a API de acordos.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const real = vi.hoisted(() => {
  const boom = (what: string) =>
    vi.fn(() => {
      throw new Error(`EFEITO REAL CHAMADO NA SIMULAÇÃO: ${what}`);
    });
  return {
    createClient: boom("supabase createClient"),
    supabaseAdmin: boom("flows supabaseAdmin"),
    engineSendText: boom("meta engineSendText"),
    engineSendMedia: boom("meta engineSendMedia"),
    engineSendInteractiveButtons: boom("meta engineSendInteractiveButtons"),
    engineSendInteractiveList: boom("meta engineSendInteractiveList"),
    engineSendCtaUrl: boom("meta engineSendCtaUrl"),
    engineMetaSendTemplate: boom("meta engineMetaSendTemplate"),
    engineWahaSendText: boom("waha engineWahaSendText"),
    engineWahaSendMedia: boom("waha engineWahaSendMedia"),
    engineWahaSendButtons: boom("waha engineWahaSendButtons"),
    engineWahaSendList: boom("waha engineWahaSendList"),
    sendTextMessage: boom("meta-api sendTextMessage"),
    sendMediaMessage: boom("meta-api sendMediaMessage"),
    sendWahaTextMessage: boom("waha-api sendWahaTextMessage"),
    sendWahaMediaMessage: boom("waha-api sendWahaMediaMessage"),
    sendWebchatMessage: boom("sendWebchatMessage"),
    getConversationChannel: boom("getConversationChannel"),
    sendSocialMessage: boom("sendSocialMessage"),
    createWebchatSession: boom("createWebchatSession"),
    hasActiveWebchatSession: boom("hasActiveWebchatSession"),
    sendWebchatInvite: boom("sendWebchatInvite"),
    writeLog: boom("writeLog"),
    handOffToTeamQueue: boom("handOffToTeamQueue"),
  };
});

vi.mock("@supabase/supabase-js", () => ({ createClient: real.createClient }));
vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: real.supabaseAdmin }));
vi.mock("@/lib/flows/meta-send", () => ({
  engineSendText: real.engineSendText,
  engineSendMedia: real.engineSendMedia,
  engineSendInteractiveButtons: real.engineSendInteractiveButtons,
  engineSendInteractiveList: real.engineSendInteractiveList,
  engineSendCtaUrl: real.engineSendCtaUrl,
  engineMetaSendTemplate: real.engineMetaSendTemplate,
}));
vi.mock("@/lib/flows/waha-send", () => ({
  engineWahaSendText: real.engineWahaSendText,
  engineWahaSendMedia: real.engineWahaSendMedia,
  engineWahaSendButtons: real.engineWahaSendButtons,
  engineWahaSendList: real.engineWahaSendList,
}));
vi.mock("@/lib/whatsapp/meta-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendTextMessage: real.sendTextMessage,
  sendMediaMessage: real.sendMediaMessage,
}));
vi.mock("@/lib/whatsapp/waha-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendWahaTextMessage: real.sendWahaTextMessage,
  sendWahaMediaMessage: real.sendWahaMediaMessage,
}));
vi.mock("@/lib/webchat/send", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendWebchatMessage: real.sendWebchatMessage,
  getConversationChannel: real.getConversationChannel,
}));
vi.mock("@/lib/webchat/sessions", () => ({
  createWebchatSession: real.createWebchatSession,
  hasActiveWebchatSession: real.hasActiveWebchatSession,
  sendWebchatInvite: real.sendWebchatInvite,
}));
vi.mock("@/lib/channels/social", () => ({ sendSocialMessage: real.sendSocialMessage }));
vi.mock("@/lib/logger", () => ({ writeLog: real.writeLog, maskPhone: (p: string) => p }));
vi.mock("@/lib/ai/team-handoff", () => ({ handOffToTeamQueue: real.handOffToTeamQueue }));

import { simulateTurn, type SimulationSeed } from "./run";
import { effectiveSimToolMode, type SimulateRequest, type SimState } from "./types";
import type { AiAgentTool } from "../types";
import { convertAiAgentNode } from "@/lib/ai/agents/convert";

// ------------------------------------------------------------
// Fixture: fluxo oficial (mesma forma do exit-tag-routing.test.ts),
// com as tools da API DDM no agente_ddm.
// ------------------------------------------------------------
const DDM = "https://ddmacordos.example.invalid";
const TOOLS: AiAgentTool[] = [
  {
    name: "localizar_devedor",
    description: "Localiza o devedor pelo CPF",
    parameters: { type: "object", properties: { cpf: { type: "string", description: "CPF" } }, required: ["cpf"] },
    http: { url: `${DDM}/localiza_dev.php?cpf={{cpf}}`, method: "GET" },
  },
  {
    name: "consultar_debitos",
    description: "Consulta os débitos",
    parameters: { type: "object", properties: { idDev: { type: "string", description: "id" } }, required: ["idDev"] },
    http: { url: `${DDM}/calc/?idDev={{idDev}}`, method: "GET" },
  },
  {
    name: "efetiva_acordo",
    description: "Formaliza o acordo",
    parameters: { type: "object", properties: { idDev: { type: "string", description: "id" } }, required: ["idDev"] },
    http: { url: `${DDM}/CalculaDebitos.php`, method: "POST", body: '{"idDev":"{{idDev}}"}' },
  },
];

function branch(tag: string, next: string) {
  return {
    id: `b-${tag}`,
    label: tag.replace("#", ""),
    combinator: "and",
    conditions: [{ subject: "var", subject_key: "ai_exit_code", operator: "equals", value: tag }],
    next_node_key: next,
  };
}

const handoff = (key: string, reason: string) => ({
  node_key: key,
  node_type: "handoff_team",
  config: { reason_code: reason, team_id: "team-cobranca" },
});

const OFFICIAL_NODES = [
  { node_key: "start", node_type: "start", config: { next_node_key: "agente_ddm" } },
  {
    node_key: "agente_ddm",
    node_type: "ai_agent",
    config: {
      mode: "loop",
      max_turns: 20,
      next_node_key: "switch_resultado",
      system_prompt_override: "RASCUNHO: você negocia dívidas do Grupo DDM. Quando formalizar, emita #ACORDOFORMALIZADO.",
      tools: TOOLS,
    },
  },
  {
    node_key: "switch_resultado",
    node_type: "switch",
    config: {
      default_next: "handoff_equipe",
      branches: [
        branch("#ACORDOFORMALIZADO", "fim"),
        branch("#CLIENTE_PEDIU_HUMANO", "handoff_pedido_humano"),
        branch("#RECUSA", "handoff_recusa"),
      ],
    },
  },
  handoff("handoff_equipe", "INDEFINIDO"),
  handoff("handoff_pedido_humano", "CLIENTE_PEDIU_HUMANO"),
  handoff("handoff_recusa", "RECUSA_OUTRO"),
  { node_key: "fim", node_type: "end", config: {} },
];

const SEED: SimulationSeed = {
  accountId: "acc-1",
  userId: "user-1",
  flowId: "flow-oficial",
  flowName: "Fluxo oficial DDM",
  aiConfig: {
    account_id: "acc-1",
    enabled: true,
    api_provider: "openai",
    api_key: "",
    api_model: "gpt-4o-mini",
    system_prompt: "PROMPT PUBLICADO DA CONTA",
  },
  knowledgeBase: [],
  teams: [{ id: "team-cobranca", name: "Cobrança" }],
};

function request(text: string, state: SimState | null, extra: Partial<SimulateRequest> = {}): SimulateRequest {
  return {
    draft: {
      entry_node_id: "start",
      trigger_type: "first_inbound_message",
      trigger_config: {},
      fallback_policy: null,
      nodes: OFFICIAL_NODES,
    },
    message: { kind: "text", text },
    state,
    contact: { name: "Maria Teste", phone: "5511999990000", vars: { nome: "Maria" } },
    provider: "meta",
    ignoreTrigger: true,
    toolMocks: {
      localizar_devedor: '[{"iddev":"777","sistema":"ddm","nome":"Maria"}]',
      consultar_debitos: '{"Calculos":[{"valor":"100,00"}]}',
      efetiva_acordo: '{"ok":true,"acordo":"SIM-1"}',
    },
    realReadOnlyTools: [],
    httpMocks: {},
    ...extra,
  };
}

type OpenAiStep = { content?: string | null; tool?: { name: string; args: Record<string, unknown> } };

/** OpenAI simulada: devolve os passos em ordem e guarda os system prompts recebidos. */
function stubOpenAi(steps: OpenAiStep[]) {
  const systemPrompts: string[] = [];
  const otherUrls: string[] = [];
  const toolsSent: string[][] = [];
  let i = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("https://api.openai.com/")) {
      otherUrls.push(url);
      throw new Error(`fetch real inesperado na simulação: ${url}`);
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      messages: Array<{ role: string; content: string }>;
      tools?: Array<{ function: { name: string } }>;
    };
    toolsSent.push((body.tools ?? []).map((t) => t.function.name));
    systemPrompts.push(body.messages.find((m) => m.role === "system")?.content ?? "");
    const step = steps[i++];
    if (!step) throw new Error("OpenAI chamada mais vezes que o roteiro");
    const message = step.tool
      ? {
          content: null,
          tool_calls: [{ id: `call_${i}`, type: "function", function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) } }],
        }
      : { content: step.content ?? "" };
    return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, systemPrompts, otherUrls, toolsSent, used: () => i };
}

function expectNoRealEffects() {
  for (const [name, spy] of Object.entries(real)) {
    expect(spy, name).not.toHaveBeenCalled();
  }
}

describe("simulador de fluxo — zero efeito real", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("fluxo oficial do início ao acordo, com tools mockadas e prompt do rascunho", async () => {
    const ai = stubOpenAi([
      { content: "Olá Maria! Me informe seu CPF, por favor." },
      { tool: { name: "localizar_devedor", args: { cpf: "529.982.247-25" } } },
      { tool: { name: "consultar_debitos", args: { idDev: "777" } } },
      { content: "Encontrei R$ 100,00 em aberto. Podemos fechar à vista?" },
      { tool: { name: "efetiva_acordo", args: { idDev: "inventado" } } },
      { content: "Acordo formalizado! Obrigado. #ACORDOFORMALIZADO" },
    ]);
    const realFetch = vi.fn(async () => {
      throw new Error("tool real chamada");
    });

    const t1 = await simulateTurn(request("Oi", null), SEED, { realFetch });
    expect(t1.dispatch).toEqual({ consumed: true, outcome: "started" });
    expect(t1.outbound.map((o) => o.text)).toEqual(["Olá Maria! Me informe seu CPF, por favor."]);
    expect(t1.run?.status).toBe("active");
    expect(t1.run?.current_node_key).toBe("agente_ddm");
    expect(t1.run?.vars.nome).toBe("Maria");
    expect(t1.path).toEqual(["start", "agente_ddm"]);

    const t2 = await simulateTurn(request("52998224725", t1.state), SEED, { realFetch });
    expect(t2.outbound.map((o) => o.text)).toEqual(["Encontrei R$ 100,00 em aberto. Podemos fechar à vista?"]);
    const toolCalls = t2.timeline.filter((e) => e.type === "tool_call").map((e) => e.label);
    expect(toolCalls).toEqual(["Tool chamada: localizar_devedor", "Tool chamada: consultar_debitos"]);
    expect(t2.timeline.some((e) => e.type === "tool_result" && String(e.detail).includes('"iddev":"777"'))).toBe(true);

    const t3 = await simulateTurn(request("Sim, pode fechar", t2.state), SEED, { realFetch });
    expect(t3.outbound.map((o) => o.text)).toEqual(["Acordo formalizado! Obrigado."]);
    // efetiva_acordo recebeu os dados do localizar_devedor (canonicalização do motor), mockado.
    const efetiva = t3.timeline.find((e) => e.label === "Tool chamada: efetiva_acordo");
    expect(efetiva?.detail).toMatchObject({ idDev: "777", cli: "ddm" });
    expect(t3.timeline.some((e) => e.label.includes("efetiva_acordo: resposta simulada"))).toBe(true);
    expect(t3.timeline.some((e) => e.type === "tag" && e.label === "Tag da IA: #ACORDOFORMALIZADO")).toBe(true);
    expect(t3.timeline.some((e) => e.type === "branch" && e.label.startsWith("Ramo: ACORDOFORMALIZADO → fim"))).toBe(true);
    expect(t3.run?.status).toBe("completed");

    // O rascunho do nó (não o prompt publicado da conta) chegou ao modelo.
    expect(ai.used()).toBe(6);
    expect(ai.systemPrompts.every((p) => p.startsWith("RASCUNHO:"))).toBe(true);
    expect(ai.otherUrls).toEqual([]);
    expect(realFetch).not.toHaveBeenCalled();
    expectNoRealEffects();
  });

  it("até um handoff: mostra a equipe e o motivo sem atribuir ninguém de verdade", async () => {
    const ai = stubOpenAi([{ content: "Oi! Qual o seu CPF?" }]);
    const t1 = await simulateTurn(request("Bom dia", null), SEED);
    const t2 = await simulateTurn(request("quero falar com um atendente humano", t1.state), SEED);

    expect(t2.run?.status).toBe("handed_off");
    const handoffEvent = t2.timeline.find((e) => e.type === "handoff");
    expect(handoffEvent?.label).toBe("Iria para a equipe Cobrança — motivo CLIENTE_PEDIU_HUMANO");
    expect(t2.timeline.some((e) => e.type === "tag" && e.label === "Tag da IA: #CLIENTE_PEDIU_HUMANO")).toBe(true);
    expect(ai.otherUrls).toEqual([]);
    expectNoRealEffects();
  });

  it("WAHA: botões viram texto numerado e o número escolhido segue o ramo", async () => {
    stubOpenAi([]);
    const nodes = [
      { node_key: "start", node_type: "start", config: { next_node_key: "menu" } },
      {
        node_key: "menu",
        node_type: "send_buttons",
        config: {
          text: "Olá {{vars.nome}}, escolha:",
          buttons: [
            { reply_id: "a", title: "Pagar", next_node_key: "fim" },
            { reply_id: "b", title: "Falar com alguém", next_node_key: "humano" },
          ],
        },
      },
      handoff("humano", "MENU"),
      { node_key: "fim", node_type: "end", config: {} },
    ];
    const draft = { entry_node_id: "start", trigger_type: "keyword", trigger_config: { keywords: ["x"] }, nodes };
    const t1 = await simulateTurn(request("oi", null, { draft, provider: "waha" }), SEED);
    expect(t1.outbound[0].provider).toBe("waha");
    expect(t1.outbound[0].text).toContain("1. Pagar\n2. Falar com alguém");
    const t2 = await simulateTurn(request("2", t1.state, { draft, provider: "waha" }), SEED);
    expect(t2.run?.status).toBe("handed_off");
    expect(t2.path).toEqual(["humano"]);
    expectNoRealEffects();
  });

  it("gatilho respeitado quando ignoreTrigger=false", async () => {
    stubOpenAi([]);
    const draft = {
      entry_node_id: "start",
      trigger_type: "keyword",
      trigger_config: { keywords: ["acordo"] },
      nodes: [
        { node_key: "start", node_type: "start", config: { next_node_key: "fim" } },
        { node_key: "fim", node_type: "end", config: {} },
      ],
    };
    const miss = await simulateTurn(request("oi", null, { draft, ignoreTrigger: false }), SEED);
    expect(miss.dispatch.consumed).toBe(false);
    expect(miss.run).toBeNull();
    const hit = await simulateTurn(request("quero um acordo", null, { draft, ignoreTrigger: false }), SEED);
    expect(hit.run?.status).toBe("completed");
    expectNoRealEffects();
  });

  it("o estado devolvido ao cliente não leva ai_config (chave da IA) nem dados da conta", async () => {
    stubOpenAi([{ content: "Oi!" }]);
    const t1 = await simulateTurn(request("Oi", null), {
      ...SEED,
      aiConfig: { ...SEED.aiConfig, api_key: "SEGREDO" },
    });
    const json = JSON.stringify(t1);
    expect(json).not.toContain("SEGREDO");
    expect(Object.keys(t1.state.tables)).not.toContain("ai_config");
  });
});

describe("effectiveSimToolMode", () => {
  it("só GET somente-leitura liberado vai de verdade", () => {
    expect(effectiveSimToolMode("localizar_devedor", "GET", ["localizar_devedor"])).toBe("real_readonly");
    expect(effectiveSimToolMode("consultar_debitos", "get", ["consultar_debitos"])).toBe("real_readonly");
  });
  it("padrão é mock", () => {
    expect(effectiveSimToolMode("localizar_devedor", "GET", [])).toBe("mock");
  });
  it("efetiva_acordo e métodos com efeito nunca vão de verdade", () => {
    expect(effectiveSimToolMode("efetiva_acordo", "GET", ["efetiva_acordo"])).toBe("mock");
    expect(effectiveSimToolMode("localizar_devedor", "POST", ["localizar_devedor"])).toBe("mock");
    expect(effectiveSimToolMode("localizar_devedor", undefined, ["localizar_devedor"])).toBe("mock");
    expect(effectiveSimToolMode("outra_tool", "GET", ["outra_tool"])).toBe("mock");
  });
});


// ---------------------------------------------------------------------------
// Catálogo de ferramentas (tool_refs) e credenciais no simulador.
// ---------------------------------------------------------------------------
describe("simulador de fluxo — catálogo de ferramentas e credenciais", () => {
  const CRED_VALUE = "SEGREDO-NUNCA-NA-SIMULACAO-123";
  const catalogTool = (id: string, name: string, enabled: boolean) => ({
    id,
    name,
    display_name: name,
    description: `d-${name}`,
    parameters: { type: "object", properties: { cpf: { type: "string", description: "cpf" } }, required: [] },
    http: {
      url: "https://api.exemplo.com/consulta?cpf={{cpf}}&k={{cred.API}}",
      method: "POST",
      headers: { Authorization: "Bearer {{cred.API}}", "X-Base": "{{var.BASE}}" },
      body: '{"token":"{{cred.API}}"}',
    },
    timeout_ms: 5000,
    enabled,
  });
  const seedWithCatalog: SimulationSeed = {
    ...SEED,
    aiTools: [catalogTool("tool-on", "consulta_cadastro", true), catalogTool("tool-off", "enviar_boleto", false)],
    accountSecrets: [
      { name: "API", kind: "credential", value_plain: null, allowed_hosts: ["exemplo.com"] },
      { name: "BASE", kind: "variable", value_plain: "valor-da-variavel", allowed_hosts: null },
    ],
  };
  const nodesWithRefs = [
    { node_key: "start", node_type: "start", config: { next_node_key: "ia" } },
    {
      node_key: "ia",
      node_type: "ai_agent",
      config: { mode: "takeover", system_prompt_override: "RASCUNHO", tool_refs: ["tool-on", "tool-off"] },
    },
  ];
  const draftRequest = (text: string, state: SimState | null) =>
    request(text, state, {
      draft: { entry_node_id: "start", trigger_type: "first_inbound_message", trigger_config: {}, fallback_policy: null, nodes: nodesWithRefs },
      toolMocks: { consulta_cadastro: '{"ok":true}' },
    });

  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    // Se o simulador tentasse ler credenciais reais do banco, explodiria aqui.
    real.supabaseAdmin.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("tool do catálogo com {{cred.X}}: o valor nunca aparece no resultado/log da simulação (vira ***), sem chamada real", async () => {
    const ai = stubOpenAi([
      { tool: { name: "consulta_cadastro", args: { cpf: "529.982.247-25" } } },
      { content: "Encontrei seu cadastro." },
    ]);
    const realFetch = vi.fn(async () => {
      throw new Error("chamada real na simulação");
    });
    const turn = await simulateTurn(draftRequest("Oi", null), seedWithCatalog, { realFetch });

    const dump = JSON.stringify(turn);
    expect(dump).not.toContain(CRED_VALUE);
    expect(dump).not.toContain("Bearer SEGREDO");
    // O log mostra a URL com *** no lugar da credencial e a variável (não secreta) resolvida.
    const note = turn.timeline.find((e) => e.label.includes("consulta_cadastro: resposta simulada"));
    expect(note).toBeTruthy();
    expect(JSON.stringify(note?.detail)).toContain("k=***");
    expect(JSON.stringify(note?.detail)).not.toContain("{{cred.API}}");
    expect(turn.outbound.map((o) => o.text)).toEqual(["Encontrei seu cadastro."]);
    // Mesma lista efetiva da produção: o catálogo ligado foi entregue ao modelo.
    expect(ai.toolsSent[0]).toEqual(["consulta_cadastro"]);
    expect(realFetch).not.toHaveBeenCalled();
    expect(ai.otherUrls).toEqual([]);
    // Nenhum acesso ao banco real para credenciais/catálogo.
    expect(real.supabaseAdmin).not.toHaveBeenCalled();
    expectNoRealEffects();
  });

  it("ferramenta DESLIGADA do catálogo não vai ao LLM simulado (só a ligada)", async () => {
    const ai = stubOpenAi([{ content: "Olá!" }]);
    await simulateTurn(draftRequest("Oi", null), seedWithCatalog);
    expect(ai.toolsSent).toHaveLength(1);
    expect(ai.toolsSent[0]).toContain("consulta_cadastro");
    expect(ai.toolsSent[0]).not.toContain("enviar_boleto");
  });
});

describe("simulador de fluxo — nós com agent_id", () => {
  const UUID = "11111111-1111-4111-8111-111111111111";
  const CRED_VALUE = "SEGREDO-DO-AGENTE-999";
  const agentConfig = () =>
    convertAiAgentNode(
      { mode: "takeover", system_prompt_override: "PROMPT DO AGENTE PUBLICADO" } as never,
      { account_id: UUID, enabled: true, api_provider: "openai", api_model: "gpt-4o-mini" },
      { node_key: "ia" },
    ).config;
  const agentSeed = (over: { enabled?: boolean; protections?: Record<string, unknown> } = {}): SimulationSeed => {
    const config = structuredClone(agentConfig()) as Record<string, unknown>;
    if (over.protections) config.protections = { ...(config.protections as object), ...over.protections };
    return {
      ...SEED,
      agents: {
        agents: [{ id: "ag1", name: "Agente Cobrança", enabled: over.enabled ?? true, published_version_id: "v3" }],
        versions: [
          { id: "v3", agent_id: "ag1", version: 3, config, prompt_content: "PROMPT DO AGENTE PUBLICADO", composition: "legacy_v1", config_hash: "h" },
        ],
        ruleVersions: [],
      },
    };
  };
  const nodes = (extra: Record<string, unknown> = {}) => [
    { node_key: "start", node_type: "start", config: { next_node_key: "ia" } },
    { node_key: "ia", node_type: "ai_agent", config: { agent_id: "ag1", system_prompt_override: "RASCUNHO IGNORADO", ...extra } },
    handoff("fila", "AGENTE_FORA"),
  ];
  const req = (text: string, ns: unknown[], state: SimState | null = null) =>
    request(text, state, {
      draft: { entry_node_id: "start", trigger_type: "first_inbound_message", trigger_config: {}, fallback_policy: null, nodes: ns as never },
    });

  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("usa o prompt composto do agente (versão publicada) e mostra o rótulo", async () => {
    const ai = stubOpenAi([{ content: "Olá!" }]);
    const turn = await simulateTurn(req("Oi", nodes()), agentSeed());
    expect(ai.systemPrompts[0]).toContain("PROMPT DO AGENTE PUBLICADO");
    expect(ai.systemPrompts[0]).not.toContain("RASCUNHO IGNORADO");
    expect(turn.timeline.some((e) => e.label.startsWith("Agente: Agente Cobrança v3"))).toBe(true);
    expect(turn.outbound.map((o) => o.text)).toEqual(["Olá!"]);
    expect(JSON.stringify(turn)).not.toContain(CRED_VALUE);
    expectNoRealEffects();
  });

  it("agente desligado segue pela saída de falha, sem chamar o modelo", async () => {
    const ai = stubOpenAi([]);
    const turn = await simulateTurn(req("Oi", nodes({ failure_next_node_key: "fila" })), agentSeed({ enabled: false }));
    expect(ai.used()).toBe(0);
    expect(turn.timeline.some((e) => e.type === "handoff")).toBe(true);
    expectNoRealEffects();
  });

  it("toggle de proteção do agente vale na simulação; opt-out continua sempre ligado", async () => {
    const off = { enabled: false };
    const seed = agentSeed({ protections: { pedido_humano_contestacao: off, pessoa_errada: off } });
    const ai = stubOpenAi([{ content: "Posso ajudar com isso mesmo." }]);
    const humano = await simulateTurn(req("quero falar com um atendente humano", nodes()), seed);
    expect(ai.used()).toBe(1); // o modelo respondeu: a trava de pedido de humano estava desligada
    expect(humano.timeline.some((e) => e.label.includes("CLIENTE_PEDIU_HUMANO"))).toBe(false);
    const optOut = await simulateTurn(req("não quero mais receber mensagens, pare", nodes()), seed);
    expect(optOut.timeline.some((e) => e.label.includes("blacklist"))).toBe(true);
  });

  it("agente que não existe nesta conta cai na saída de falha", async () => {
    stubOpenAi([]);
    const turn = await simulateTurn(req("Oi", nodes({ failure_next_node_key: "fila" })), { ...SEED });
    expect(turn.timeline.some((e) => e.type === "handoff")).toBe(true);
  });
});
