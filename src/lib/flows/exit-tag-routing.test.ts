import { describe, it, expect } from "vitest";
import {
  extractPromptExitTags,
  findExitTagRouter,
  flowExitTagsFromNodes,
  routerHandlesTag,
  type RoutingNode,
} from "./exit-tag-routing";
import { validateAiExitTagRouting, validateFlowForActivation } from "./validate";

// ------------------------------------------------------------
// Fixture: fluxo oficial 66a59213… (switch_resultado montado a partir
// das migrations 134/137/138/147; os ramos anteriores à 134 — RECUSA,
// AGENDAMENTO, NAOENVIACPF, INSTABILIDADE, ACORDOFORMALIZADO — foram
// inferidos dos nós handoff_* que a 134 atualiza).
// ------------------------------------------------------------

function branch(id: string, tag: string, next: string) {
  return {
    id,
    label: tag.replace("#", ""),
    combinator: "and",
    conditions: [
      { subject: "var", subject_key: "ai_exit_code", operator: "equals", value: tag },
    ],
    next_node_key: next,
  };
}

const AGENTE_DDM_PROMPT = `Você é a assistente de negociação do Grupo DDM.

PRIORIDADES:
- Se o cliente pedir para parar mensagens, sair da lista ou não receber novos contatos: confirme uma única vez e emita #OPT_OUT. NÃO peça CPF.
- Se disser que não é a pessoa citada, que o número está errado ou que a mensagem foi para outra pessoa: peça desculpas, NÃO peça CPF e emita #CONTATO_DIVERGENTE.
- Se disser que já pagou, já resolveu, já negociou, não reconhece a dívida, cancelou/trancou antes ou questiona o valor: NÃO negocie; emita #CONTESTACAO_DIVIDA.
- Se pedir atendente/humano/equipe explicitamente: emita #CLIENTE_PEDIU_HUMANO.

SE tentativas_cpf_invalido >= 2:
  Envie: "Infelizmente não consegui localizar seu cadastro com nenhum dos CPFs informados. Vou passar seu caso para nossa equipe analisar. Um momento!"
  Emita: #CPF_NAO_LOCALIZADO
SE o cliente enviar dois CPFs inválidos: Emita: #CPF_INVALIDO
SE o cliente se recusar a enviar o CPF duas vezes: Emita: #NAOENVIACPF
SE houver acordo ativo:
Envie: "Encontrei um acordo ativo no seu cadastro! 📋 Vou encaminhar para nossa equipe verificar os detalhes com você. Um momento!"
Emita: #ACORDO_EXISTENTE
SE a consulta falhar após a nova tentativa:
  Emita: #INSTABILIDADE
SE o cliente informar uma data futura para pagar: Emita: #AGENDAMENTO
SE o cliente recusar todas as opções: Emita: #RECUSA
Envie: "Tive um problema técnico para finalizar aqui. 😕 Vou encaminhar para nossa equipe concluir o acordo com você!"
Emita: #ERRO_EFETIVACAO
Envie: "Entendo sua situação e vou garantir que a equipe certa analise seu caso. 👍 Vou encaminhar agora!"
Emita: #CONTESTACAO_DIVIDA
NUNCA emita #RECUSA para contestações.
Envie: "Estou com dificuldades para continuar por aqui. 😕 Vou chamar nossa equipe para te ajudar!"
Emita: #FALLBACK_EXAURIDO
Quando o acordo for formalizado, emita #ACORDOFORMALIZADO.
Nunca use #DDM nem "opção #2" como tag.`;

const RECOVERY_PROMPT = `Você é o classificador de recuperação de recusa do Grupo DDM.

SAÍDAS:

#RECUPERADO
Use quando o cliente demonstrar abertura para continuar negociando.

#RECUSA_CONFIRMADA
Use quando o cliente confirmar claramente que não quer seguir.

#CLIENTE_PEDIU_HUMANO
Use se o cliente pedir explicitamente atendente, pessoa, humano ou equipe.

#CONTESTACAO_DIVIDA
Use se o cliente disser que a dívida não é dele.

#FALLBACK_EXAURIDO
Use somente se ainda não for possível classificar com segurança.

Não emita código nessa primeira pergunta ambígua.`;

function officialFlowNodes(overrides: {
  agentePrompt?: string;
  recoveryPrompt?: string;
} = {}): RoutingNode[] {
  const handoff = (key: string, reason: string): RoutingNode => ({
    node_key: key,
    node_type: "handoff_team",
    config: { reason_code: reason },
  });
  return [
    { node_key: "start", node_type: "start", config: { next_node_key: "agente_ddm" } },
    {
      node_key: "agente_ddm",
      node_type: "ai_agent",
      config: {
        mode: "loop",
        max_turns: 20,
        next_node_key: "switch_resultado",
        system_prompt_override: overrides.agentePrompt ?? AGENTE_DDM_PROMPT,
      },
    },
    {
      node_key: "switch_resultado",
      node_type: "switch",
      config: {
        default_next: "handoff_equipe",
        branches: [
          branch("branch-acordo-formalizado", "#ACORDOFORMALIZADO", "fim"),
          branch("branch-recusa", "#RECUSA", "recovery_recusa"),
          branch("branch-agendamento", "#AGENDAMENTO", "handoff_agendamento"),
          branch("branch-naoenviacpf", "#NAOENVIACPF", "handoff_naoenviacpf"),
          branch("branch-instabilidade", "#INSTABILIDADE", "handoff_instabilidade"),
          // 134
          branch("branch-cliente-pediu-humano", "#CLIENTE_PEDIU_HUMANO", "handoff_pedido_humano"),
          branch("branch-cpf-nao-localizado", "#CPF_NAO_LOCALIZADO", "handoff_cpf_nao_localizado"),
          branch("branch-acordo-existente", "#ACORDO_EXISTENTE", "handoff_acordo_existente"),
          branch("branch-erro-efetivacao", "#ERRO_EFETIVACAO", "handoff_erro_efetivacao"),
          branch("branch-contestacao-divida", "#CONTESTACAO_DIVIDA", "handoff_contestacao"),
          branch("branch-fallback-exaurido", "#FALLBACK_EXAURIDO", "handoff_fallback"),
          // 137
          branch("branch-cpf-invalido", "#CPF_INVALIDO", "handoff_cpf_invalido"),
          // 147
          branch("branch-opt-out", "#OPT_OUT", "fim"),
          branch("branch-contato-divergente", "#CONTATO_DIVERGENTE", "handoff_contato_divergente"),
        ],
      },
    },
    // 138
    {
      node_key: "recovery_recusa",
      node_type: "ai_agent",
      config: {
        mode: "loop",
        max_turns: 2,
        next_node_key: "switch_recovery_recusa",
        herdar_contexto_anterior: true,
        tools: [],
        system_prompt_override: overrides.recoveryPrompt ?? RECOVERY_PROMPT,
      },
    },
    {
      node_key: "switch_recovery_recusa",
      node_type: "switch",
      config: {
        default_next: "handoff_fallback",
        branches: [
          branch("recovery-recuperado", "#RECUPERADO", "agente_ddm"),
          branch("recovery-recusa-confirmada", "#RECUSA_CONFIRMADA", "handoff_recusa"),
          branch("recovery-pedido-humano", "#CLIENTE_PEDIU_HUMANO", "handoff_pedido_humano"),
          branch("recovery-contestacao", "#CONTESTACAO_DIVIDA", "handoff_contestacao"),
          branch("recovery-fallback", "#FALLBACK_EXAURIDO", "handoff_fallback"),
        ],
      },
    },
    handoff("handoff_equipe", "INDEFINIDO"),
    handoff("handoff_recusa", "RECUSA_OUTRO"),
    handoff("handoff_agendamento", "AGENDAMENTO"),
    handoff("handoff_naoenviacpf", "CPF_NAO_INFORMADO"),
    handoff("handoff_instabilidade", "TOOL_ERROR"),
    handoff("handoff_pedido_humano", "CLIENTE_PEDIU_HUMANO"),
    handoff("handoff_cpf_nao_localizado", "CPF_NAO_LOCALIZADO"),
    handoff("handoff_cpf_invalido", "CPF_INVALIDO"),
    handoff("handoff_acordo_existente", "ACORDO_EXISTENTE"),
    handoff("handoff_erro_efetivacao", "ERRO_EFETIVACAO"),
    handoff("handoff_contestacao", "CONTESTACAO_DIVIDA"),
    handoff("handoff_fallback", "FALLBACK_EXAURIDO"),
    handoff("handoff_contato_divergente", "CONTATO_DIVERGENTE"),
    { node_key: "fim", node_type: "end", config: {} },
  ];
}

const flow = {
  name: "Fluxo oficial DDM",
  trigger_type: "first_inbound_message" as const,
  trigger_config: {},
  entry_node_id: "start",
};

describe("extractPromptExitTags", () => {
  it("pega tags conhecidas e tags novas só em linha de 'emita'", () => {
    const { emitted, mentioned } = extractPromptExitTags(
      "Emita: #NOVA_TAG\nfale de #OUTRA solta\nopção #2 e #DDM\n#RECUSA",
    );
    expect([...emitted]).toEqual(["#NOVA_TAG", "#RECUSA"]);
    expect(mentioned.has("#OUTRA")).toBe(false);
    expect(mentioned.has("#DDM")).toBe(false);
  });

  it("linha que proíbe a tag conta como citação, não como emissão", () => {
    const { emitted, mentioned } = extractPromptExitTags(
      "NUNCA emita #RECUSA para contestações.",
    );
    expect(emitted.has("#RECUSA")).toBe(false);
    expect(mentioned.has("#RECUSA")).toBe(true);
  });
});

describe("findExitTagRouter", () => {
  it("acha o switch_resultado logo depois do agente_ddm", () => {
    const nodes = officialFlowNodes();
    const byKey = new Map(nodes.map((n) => [n.node_key, n]));
    const router = findExitTagRouter(byKey.get("agente_ddm")!, byKey);
    expect(router?.node_key).toBe("switch_resultado");
    expect(router?.default_next).toBe("handoff_equipe");
    expect(router && routerHandlesTag(router, "#OPT_OUT")).toBe(true);
    expect(router && routerHandlesTag(router, "#EQUIPEHUMANA")).toBe(false);
  });

  it("atravessa 'Definir variável' e segue cadeia de condições", () => {
    const nodes: RoutingNode[] = [
      { node_key: "ia", node_type: "ai_agent", config: { mode: "once", next_node_key: "sv" } },
      {
        node_key: "sv",
        node_type: "set_variable",
        config: { assignments: [{ variable: "x", value: "1" }], next_node_key: "c1" },
      },
      {
        node_key: "c1",
        node_type: "condition",
        config: { subject: "var", subject_key: "ai_exit_code", operator: "equals", value: "RECUSA", true_next: "h", false_next: "c2" },
      },
      {
        node_key: "c2",
        node_type: "condition",
        config: { subject: "var", subject_key: "ai_exit_code", operator: "contains", value: "CPF", true_next: "h", false_next: "h2" },
      },
      { node_key: "h", node_type: "end", config: {} },
      { node_key: "h2", node_type: "end", config: {} },
    ];
    const byKey = new Map(nodes.map((n) => [n.node_key, n]));
    const router = findExitTagRouter(byKey.get("ia")!, byKey)!;
    expect(router.kind).toBe("condition");
    expect(router.node_key).toBe("c1");
    expect(router.default_next).toBe("h2");
    expect(routerHandlesTag(router, "#RECUSA")).toBe(true);
    expect(routerHandlesTag(router, "#CPF_INVALIDO")).toBe(true);
    expect(routerHandlesTag(router, "#AGENDAMENTO")).toBe(false);
  });

  it("não segue switch que decide por outra variável", () => {
    const nodes: RoutingNode[] = [
      { node_key: "ia", node_type: "ai_agent", config: { mode: "once", next_node_key: "sw" } },
      {
        node_key: "sw",
        node_type: "switch",
        config: {
          default_next: "fim",
          branches: [{ conditions: [{ subject: "var", subject_key: "plano", operator: "equals", value: "a" }], next_node_key: "fim" }],
        },
      },
      { node_key: "fim", node_type: "end", config: {} },
    ];
    const byKey = new Map(nodes.map((n) => [n.node_key, n]));
    expect(findExitTagRouter(byKey.get("ia")!, byKey)).toBeNull();
  });
});

describe("flowExitTagsFromNodes (usada pelo engine)", () => {
  it("lista as tags dos ramos do fluxo oficial", () => {
    const tags = flowExitTagsFromNodes(officialFlowNodes());
    expect(tags).toEqual(expect.arrayContaining(["#OPT_OUT", "#RECUPERADO", "#CPF_INVALIDO"]));
  });
});

describe("validateAiExitTagRouting — fluxo oficial", () => {
  it("fluxo oficial atual: sem avisos de tag", () => {
    expect(validateAiExitTagRouting(officialFlowNodes())).toEqual([]);
  });

  it("não mistura com os demais avisos do validador", () => {
    const issues = validateFlowForActivation(flow, officialFlowNodes());
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(issues.some((i) => i.message.includes("#"))).toBe(false);
  });

  it("tag legada #EQUIPEHUMANA: sem ramo (cai no padrão) + sugestão", () => {
    const prompt = AGENTE_DDM_PROMPT.replace(
      "Emita: #FALLBACK_EXAURIDO",
      "Emita: #FALLBACK_EXAURIDO\nSE travar: Emita: #EQUIPEHUMANA",
    );
    const issues = validateAiExitTagRouting(officialFlowNodes({ agentePrompt: prompt }));
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "warning",
          node_key: "agente_ddm",
          field: "system_prompt_override",
          message:
            'A IA pode emitir #EQUIPEHUMANA, mas o switch "switch_resultado" não tem ramo para essa tag — cai no padrão (handoff_equipe).',
        }),
        expect.objectContaining({
          node_key: "agente_ddm",
          message: expect.stringContaining("tag legada #EQUIPEHUMANA"),
        }),
      ]),
    );
    expect(issues).toHaveLength(2);
  });

  it("#NAOLOCALIZADO sugere #CPF_NAO_LOCALIZADO", () => {
    const prompt = AGENTE_DDM_PROMPT.replace(
      "Emita: #CPF_NAO_LOCALIZADO",
      "Emita: #NAOLOCALIZADO",
    );
    const issues = validateAiExitTagRouting(officialFlowNodes({ agentePrompt: prompt }));
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("Prefira #CPF_NAO_LOCALIZADO"),
        }),
        // o ramo #CPF_NAO_LOCALIZADO ficou sem citação no prompt
        expect.objectContaining({
          node_key: "switch_resultado",
          message: expect.stringContaining("tem ramo para #CPF_NAO_LOCALIZADO"),
        }),
      ]),
    );
  });

  it("tag nova sem ramo em lugar nenhum: avisa que iria como texto", () => {
    const prompt = `${RECOVERY_PROMPT}\nSe o cliente quiser parcelar, emita #QUER_PARCELAR.`;
    const issues = validateAiExitTagRouting(officialFlowNodes({ recoveryPrompt: prompt }));
    expect(issues).toEqual([
      expect.objectContaining({
        node_key: "recovery_recusa",
        message: expect.stringContaining("iria como texto para o cliente"),
      }),
    ]);
  });

  it("tag conhecida de outro switch: cai no padrão do switch seguinte", () => {
    const prompt = `${RECOVERY_PROMPT}\nSe o cliente informar uma data futura, emita #AGENDAMENTO.`;
    const issues = validateAiExitTagRouting(officialFlowNodes({ recoveryPrompt: prompt }));
    expect(issues).toEqual([
      expect.objectContaining({
        message:
          'A IA pode emitir #AGENDAMENTO, mas o switch "switch_recovery_recusa" não tem ramo para essa tag — cai no padrão (handoff_fallback).',
      }),
    ]);
  });

  it("inverso: ramo para tag que o prompt não cita (aviso brando, no switch)", () => {
    const prompt = AGENTE_DDM_PROMPT.replace(/.*#OPT_OUT.*\n/, "");
    const issues = validateAiExitTagRouting(officialFlowNodes({ agentePrompt: prompt }));
    expect(issues).toEqual([
      expect.objectContaining({
        severity: "warning",
        node_key: "switch_resultado",
        message: expect.stringMatching(/^Sugestão: o switch "switch_resultado" tem ramo para #OPT_OUT/),
      }),
    ]);
  });

  it("nó de IA sem instruções próprias: não avisa nada (prompt da conta)", () => {
    const issues = validateAiExitTagRouting(
      officialFlowNodes({ agentePrompt: "", recoveryPrompt: "   " }),
    );
    expect(issues).toEqual([]);
  });
});
