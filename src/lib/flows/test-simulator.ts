/**
 * Side-effect-free flow preview for the editor's "Teste" tab.
 *
 * Deliberately does NOT import the production runner, Supabase client,
 * WhatsApp senders, AI providers or HTTP clients. It executes only the
 * in-memory graph supplied by the editor, including unsaved changes.
 * External actions must be simulated explicitly by the operator.
 */
export interface TestNode {
  node_key: string;
  node_type: string;
  config: Record<string, unknown>;
}

export interface TestContact {
  name: string;
  phone: string;
  email: string;
  company: string;
}

export interface TestMessage {
  role: "customer" | "flow" | "notice";
  text: string;
}

export interface TestTrace {
  node_key: string;
  node_type: string;
  detail: string;
}

export interface TestOption {
  id: string;
  label: string;
  next: string;
}

export type TestWait =
  | { kind: "choice"; node_key: string; options: TestOption[] }
  | { kind: "text"; node_key: string }
  | { kind: "attachment"; node_key: string; allowed: string[] }
  | { kind: "ai_response"; node_key: string }
  | { kind: "ai_customer"; node_key: string }
  | { kind: "http_response"; node_key: string };

export interface FlowTestSession {
  status: "waiting" | "finished" | "blocked";
  wait: TestWait | null;
  ending: string | null;
  currentNodeKey: string | null;
  contact: TestContact;
  vars: Record<string, unknown>;
  tags: string[];
  messages: TestMessage[];
  trace: TestTrace[];
  visits: number;
  aiTurns: Record<string, number>;
}

export type TestAction =
  | { kind: "choice"; id: string }
  | { kind: "text"; text: string }
  | { kind: "attachment"; mediaType: "image" | "video" | "audio" | "document" }
  | { kind: "ai_response"; text: string }
  | { kind: "http_response"; value: unknown };

export interface TestSetup {
  entryNodeId: string | null;
  nodes: readonly TestNode[];
  contact: TestContact;
  vars?: Record<string, unknown>;
  tags?: string[];
  initialMessage?: string;
}

const MAX_VISITS = 100;
const attachmentTypes = ["image", "video", "audio", "document"];

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function obj(value: unknown): Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((v) => !!v && typeof v === "object" && !Array.isArray(v)) : [];
}

function nextKey(value: unknown): string {
  return str(value).trim();
}

function interpolate(template: unknown, vars: Record<string, unknown>): string {
  return str(template).replace(/\{\{vars\.([A-Za-z0-9_]+)\}\}/g, (_whole, name: string) => {
    const value = vars[name];
    return value === undefined || value === null ? "" : String(value);
  });
}

function trace(session: FlowTestSession, node: TestNode, detail: string) {
  session.trace.push({ node_key: node.node_key, node_type: node.node_type, detail });
}

function message(session: FlowTestSession, role: TestMessage["role"], text: string) {
  if (text) session.messages.push({ role, text });
}

function finish(session: FlowTestSession, status: "finished" | "blocked", reason: string): FlowTestSession {
  session.status = status;
  session.wait = null;
  session.currentNodeKey = null;
  session.ending = reason;
  message(session, "notice", reason);
  return session;
}

function pause(session: FlowTestSession, wait: TestWait): FlowTestSession {
  session.wait = wait;
  session.status = "waiting";
  session.currentNodeKey = wait.node_key;
  return session;
}

function subject(session: FlowTestSession, config: Record<string, unknown>): string | undefined {
  const key = str(config.subject_key);
  switch (config.subject) {
    case "var": {
      const value = session.vars[key];
      return value === undefined || value === null ? undefined : String(value);
    }
    case "tag":
      return session.tags.includes(key) ? key : undefined;
    case "contact_field": {
      if (!["name", "email", "phone", "company"].includes(key)) return undefined;
      return session.contact[key as keyof TestContact] || undefined;
    }
    default:
      return undefined;
  }
}

/** Same case-sensitive predicate semantics as the production engine. */
function predicate(session: FlowTestSession, config: Record<string, unknown>): boolean {
  const value = subject(session, config);
  switch (config.operator) {
    case "present": return value !== undefined && value !== "";
    case "absent": return value === undefined || value === "";
    case "equals": return value !== undefined && value === str(config.value);
    case "contains": return value !== undefined && value.includes(str(config.value));
    default: return false;
  }
}

function optionsFor(node: TestNode): TestOption[] {
  if (node.node_type === "send_buttons") {
    return records(node.config.buttons).map((button) => ({
      id: str(button.reply_id),
      label: str(button.title) || str(button.reply_id),
      next: nextKey(button.next_node_key),
    })).filter((o) => !!o.id);
  }
  return records(node.config.sections).flatMap((section) =>
    records(section.rows).map((row) => ({
      id: str(row.reply_id),
      label: str(row.title) || str(row.reply_id),
      next: nextKey(row.next_node_key),
    }))
  ).filter((o) => !!o.id);
}

function walk(session: FlowTestSession, nodes: readonly TestNode[], startKey: string): FlowTestSession {
  const nodeByKey = new Map(nodes.map((node) => [node.node_key, node]));
  let key = startKey;
  session.wait = null;

  while (true) {
    if (!key) return finish(session, "blocked", "O nó anterior não possui uma saída configurada.");
    if (session.visits >= MAX_VISITS) {
      return finish(session, "blocked", "Limite de 100 etapas atingido: possível ciclo sem espera no fluxo.");
    }
    const node = nodeByKey.get(key);
    if (!node) return finish(session, "blocked", "Nó de destino não encontrado: " + key);

    session.visits += 1;
    session.currentNodeKey = node.node_key;
    const cfg = node.config;
    switch (node.node_type) {
      case "start":
      case "anchor":
        trace(session, node, "Seguiu para o próximo nó.");
        key = nextKey(cfg.next_node_key);
        continue;

      case "send_message":
        message(session, "flow", interpolate(cfg.text, session.vars));
        trace(session, node, "Mensagem simulada; nenhum WhatsApp enviado.");
        key = nextKey(cfg.next_node_key);
        continue;

      case "send_buttons":
      case "send_list": {
        message(session, "flow", interpolate(cfg.text, session.vars));
        const options = optionsFor(node);
        if (!options.length) return finish(session, "blocked", "Nó " + key + " sem opções configuradas.");
        trace(session, node, "Aguardando seleção simulada do cliente.");
        return pause(session, { kind: "choice", node_key: key, options });
      }

      case "collect_input":
        message(session, "flow", interpolate(cfg.prompt_text, session.vars));
        trace(session, node, "Aguardando texto do cliente para a variável " + str(cfg.var_key) + ".");
        return pause(session, { kind: "text", node_key: key });

      case "receive_attachment": {
        message(session, "flow", interpolate(cfg.prompt_text, session.vars));
        const allowed = Array.isArray(cfg.allowed_types)
          ? cfg.allowed_types.filter((t): t is string => typeof t === "string" && attachmentTypes.includes(t))
          : attachmentTypes;
        trace(session, node, "Aguardando anexo simulado; nenhum arquivo será carregado.");
        return pause(session, { kind: "attachment", node_key: key, allowed });
      }

      case "condition": {
        const passed = predicate(session, cfg);
        trace(session, node, "Condição: " + (passed ? "verdadeiro" : "falso") + ".");
        key = nextKey(passed ? cfg.true_next : cfg.false_next);
        continue;
      }

      case "switch": {
        const branch = records(cfg.branches).find((candidate) => {
          const conditions = records(candidate.conditions);
          if (!conditions.length) return false;
          return candidate.combinator === "or"
            ? conditions.some((condition) => predicate(session, condition))
            : conditions.every((condition) => predicate(session, condition));
        });
        trace(session, node, branch
          ? "Ramo escolhido: " + (str(branch.label) || "sem nome") + "."
          : "Nenhum ramo correspondeu; seguiu o padrão.");
        key = nextKey(branch ? branch.next_node_key : cfg.default_next);
        continue;
      }

      case "set_variable":
        for (const assignment of records(cfg.assignments)) {
          const name = str(assignment.variable).trim();
          if (name) session.vars[name] = interpolate(assignment.value, session.vars);
        }
        trace(session, node, "Variáveis atualizadas somente nesta simulação.");
        key = nextKey(cfg.next_node_key);
        continue;

      case "set_tag": {
        const tag = str(cfg.tag_id);
        if (tag) {
          session.tags = cfg.mode === "remove"
            ? session.tags.filter((item) => item !== tag)
            : [...new Set([...session.tags, tag])];
        }
        trace(session, node, "Tag " + (cfg.mode === "remove" ? "removida" : "adicionada") + " apenas na simulação.");
        key = nextKey(cfg.next_node_key);
        continue;
      }

      case "send_media":
        message(session, "flow", "[Mídia simulada: " + (str(cfg.media_type) || "arquivo") + "] " + interpolate(cfg.caption, session.vars));
        trace(session, node, "Envio de mídia não executado.");
        key = nextKey(cfg.next_node_key);
        continue;

      case "send_template":
        message(session, "flow", interpolate(cfg.fallback_text, session.vars) || "[Template simulado: " + str(cfg.template_name) + "]");
        trace(session, node, "Template Meta não enviado nem validado junto ao provedor.");
        key = nextKey(cfg.next_node_key);
        continue;

      case "send_webchat":
        message(session, "flow", interpolate(cfg.message_text, session.vars));
        trace(session, node, "Convite Webchat simulado; não foi criada sessão nem gerado link.");
        return finish(session, "finished", "Fim do trecho simulado: entrada no Webchat exige um fluxo real.");

      case "add_note":
        trace(session, node, "Nota interna simulada: " + interpolate(cfg.note_text, session.vars));
        key = nextKey(cfg.next_node_key);
        continue;

      case "smart_delay":
        message(session, "flow", interpolate(cfg.message, session.vars));
        trace(session, node, "Espera de " + String(cfg.delay_seconds ?? 0) + " s ignorada no teste.");
        key = nextKey(cfg.next_node_key);
        continue;

      case "go_to":
        trace(session, node, "Salto para " + str(cfg.target_node_key) + ".");
        key = nextKey(cfg.target_node_key);
        continue;

      case "http_fetch":
        trace(session, node, "HTTP externo NÃO executado. Informe um retorno simulado para continuar.");
        return pause(session, { kind: "http_response", node_key: key });

      case "ai_agent":
        trace(session, node, "IA e ferramentas NÃO executadas. Informe manualmente a resposta simulada.");
        return pause(session, { kind: "ai_response", node_key: key });

      case "go_to_flow":
        trace(session, node, "Outro fluxo não iniciado na simulação.");
        return finish(session, "finished", "Fim do trecho simulado: nó direciona para outro fluxo.");

      case "handoff":
      case "handoff_agent":
      case "handoff_team":
        trace(session, node, "Transferência simulada; nenhuma conversa ou equipe foi alterada.");
        return finish(session, "finished", "Fluxo encerrado em transferência simulada.");

      case "end":
        trace(session, node, "Fim do fluxo.");
        return finish(session, "finished", "Fluxo concluído no teste.");

      default:
        trace(session, node, "Tipo não implementado no simulador.");
        return finish(session, "blocked", "Não é possível simular o nó do tipo " + node.node_type + ".");
    }
  }
}

export function startFlowTest(setup: TestSetup): FlowTestSession {
  const session: FlowTestSession = {
    status: "waiting",
    wait: null,
    ending: null,
    currentNodeKey: null,
    contact: { ...setup.contact },
    vars: { ...(setup.vars ?? {}) },
    tags: [...new Set(setup.tags ?? [])],
    messages: [],
    trace: [],
    visits: 0,
    aiTurns: {},
  };
  if (setup.initialMessage?.trim()) {
    message(session, "customer", setup.initialMessage.trim());
  }
  if (!setup.entryNodeId) return finish(session, "blocked", "Defina um nó de entrada para iniciar o teste.");
  return walk(session, setup.nodes, setup.entryNodeId);
}

export function respondToFlowTest(
  original: FlowTestSession,
  nodes: readonly TestNode[],
  action: TestAction,
): FlowTestSession {
  if (original.status !== "waiting" || !original.wait) return original;
  const session: FlowTestSession = {
    ...original,
    contact: { ...original.contact },
    vars: { ...original.vars },
    tags: [...original.tags],
    messages: [...original.messages],
    trace: [...original.trace],
    aiTurns: { ...original.aiTurns },
  };
  const wait = session.wait;
  const node = nodes.find((item) => item.node_key === wait.node_key);
  if (!node) return finish(session, "blocked", "O nó em execução foi removido.");

  if (wait.kind === "choice" && action.kind === "choice") {
    const choice = wait.options.find((option) => option.id === action.id);
    if (!choice) return original;
    message(session, "customer", choice.label);
    trace(session, node, "Cliente escolheu: " + choice.label + ".");
    return walk(session, nodes, choice.next);
  }
  if (wait.kind === "text" && action.kind === "text") {
    if (!action.text.trim()) return original;
    message(session, "customer", action.text.trim());
    const varKey = str(node.config.var_key);
    if (varKey) session.vars[varKey] = action.text.trim();
    trace(session, node, "Texto capturado em " + varKey + ".");
    return walk(session, nodes, nextKey(node.config.next_node_key));
  }
  if (wait.kind === "attachment" && action.kind === "attachment") {
    if (!wait.allowed.includes(action.mediaType)) return original;
    message(session, "customer", "[Anexo simulado: " + action.mediaType + "]");
    const varName = str(node.config.var_name);
    if (varName) session.vars[varName] = "simulated://" + action.mediaType;
    trace(session, node, "Recebimento de " + action.mediaType + " simulado.");
    return walk(session, nodes, nextKey(node.config.next_node_key));
  }
  if (wait.kind === "http_response" && action.kind === "http_response") {
    const varName = str(node.config.response_var);
    if (varName) session.vars[varName] = action.value;
    trace(session, node, "Resposta HTTP fictícia aplicada à variável " + (varName || "(nenhuma)") + ".");
    return walk(session, nodes, nextKey(node.config.next_node_key));
  }
  if (wait.kind === "ai_customer" && action.kind === "text") {
    if (!action.text.trim()) return original;
    message(session, "customer", action.text.trim());
    trace(session, node, "Nova mensagem do cliente; aguardando resposta fictícia da IA.");
    return pause(session, { kind: "ai_response", node_key: node.node_key });
  }
  if (wait.kind === "ai_response" && action.kind === "ai_response") {
    if (!action.text.trim()) return original;
    message(session, "flow", action.text.trim());
    const turns = (session.aiTurns[node.node_key] ?? 0) + 1;
    session.aiTurns[node.node_key] = turns;
    trace(session, node, "Resposta fictícia da IA aplicada (turno " + turns + ").");
    const mode = str(node.config.mode);
    if (mode === "takeover") {
      return finish(session, "finished", "IA encerraria o fluxo em takeover; nenhuma transferência real.");
    }
    if (mode === "loop" && turns < (Number(node.config.max_turns) > 0 ? Number(node.config.max_turns) : 20)) {
      return pause(session, { kind: "ai_customer", node_key: node.node_key });
    }
    return walk(session, nodes, nextKey(node.config.next_node_key));
  }
  return original;
}
