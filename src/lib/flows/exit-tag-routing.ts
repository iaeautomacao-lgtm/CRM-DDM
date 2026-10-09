/**
 * Roteamento de tags de saída da IA (#RECUSA, #CPF_NAO_LOCALIZADO…) no
 * grafo do fluxo — lógica PURA, sem imports de servidor, usada pelo
 * validador do editor (validate.ts roda no cliente e no servidor).
 *
 * `flowExitTagsFromNodes` vive aqui (o engine é server-side e não pode
 * entrar no bundle do editor) e o engine importa daqui.
 */

import { KNOWN_AI_EXIT_TAGS, normalizeExitTag } from "@/lib/ai/exit-tags";

export interface RoutingNode {
  node_key: string;
  node_type: string;
  config: Record<string, unknown>;
}

interface RawCondition {
  subject?: unknown;
  subject_key?: unknown;
  operator?: unknown;
  value?: unknown;
}

const AI_EXIT_SUBJECT = "ai_exit_code";

/** Tags de saída usadas nos ramos do fluxo (switch/condição em ai_exit_code). */
export function flowExitTagsFromNodes(
  nodes: Iterable<Pick<RoutingNode, "node_type" | "config">>,
): string[] {
  const tags = new Set<string>();
  const collect = (cond: RawCondition) => {
    if (cond.subject_key !== AI_EXIT_SUBJECT) return;
    const tag = normalizeExitTag(cond.value);
    if (tag) tags.add(tag);
  };
  for (const node of nodes) {
    const cfg = (node.config ?? {}) as Record<string, unknown>;
    if (node.node_type === "switch" && Array.isArray(cfg.branches)) {
      for (const branch of cfg.branches as Array<{ conditions?: unknown }>) {
        if (!Array.isArray(branch?.conditions)) continue;
        for (const cond of branch.conditions) collect(cond ?? {});
      }
    } else if (node.node_type === "condition") {
      collect(cfg);
    }
  }
  return [...tags];
}

// ============================================================
// Tags citadas no prompt
// ============================================================

const KNOWN_TAG_SET = new Set(KNOWN_AI_EXIT_TAGS);
const TAG_TOKEN = /#[A-Z][A-Z0-9_]*/g;
// Linha que manda emitir algo ("Emita: #X", "emita #X", "emitir #X").
const EMIT_LINE = /\bemit/i;
// Linha que PROÍBE emitir ("NUNCA emita #RECUSA…", "Não emita código…").
const NEGATED_EMIT_LINE = /\b(nunca|n[ãa]o)\s+(emita|emitir|emite|use|retorne)\b/i;

export interface PromptTagMentions {
  /** Tags que a IA pode emitir (linhas que não proíbem a tag). */
  emitted: Set<string>;
  /** Toda tag citada, inclusive em proibições ("NUNCA emita #X"). */
  mentioned: Set<string>;
}

/**
 * Tags de saída citadas nas instruções do nó. Conta como tag: as tags
 * conhecidas (exit-tags.ts) em qualquer linha, e qualquer #MAIUSCULA numa
 * linha com "emita"/"emitir". Evita falso positivo com "#DDM", "#2" etc.
 */
export function extractPromptExitTags(prompt: string): PromptTagMentions {
  const emitted = new Set<string>();
  const mentioned = new Set<string>();
  for (const line of prompt.split(/\r?\n/)) {
    const emitLine = EMIT_LINE.test(line);
    const negated = NEGATED_EMIT_LINE.test(line);
    for (const m of line.matchAll(TAG_TOKEN)) {
      const tag = m[0];
      if (!KNOWN_TAG_SET.has(tag) && !emitLine) continue;
      mentioned.add(tag);
      if (!negated) emitted.add(tag);
    }
  }
  return { emitted, mentioned };
}

// ============================================================
// Roteador logo depois do nó de IA
// ============================================================

export interface ExitTagRouter {
  /** Nó que decide pela tag (switch ou 1ª condição da cadeia). */
  node_key: string;
  kind: "switch" | "condition";
  /** Tags com ramo próprio (comparação "igual a"). */
  equalsTags: Set<string>;
  /** Valores de "contém" (comparação crua, como no engine). */
  containsValues: string[];
  /** Algum ramo aceita qualquer tag ("está preenchido"). */
  matchesAny: boolean;
  /** Para onde vai uma tag sem ramo. */
  default_next: string | null;
}

// Nós que avançam sozinhos e não mudam `ai_exit_code`.
const PASSTHROUGH_TYPES = new Set([
  "set_variable",
  "set_tag",
  "add_note",
  "anchor",
  "http_fetch",
  "smart_delay",
  "send_message",
  "send_media",
  "send_template",
  "send_flow",
]);

function assignsExitCode(node: RoutingNode): boolean {
  if (node.node_type !== "set_variable") return false;
  const assignments = node.config.assignments;
  return (
    Array.isArray(assignments) &&
    assignments.some(
      (a) => (a as { variable?: unknown })?.variable === AI_EXIT_SUBJECT,
    )
  );
}

function addCondition(router: ExitTagRouter, cond: RawCondition): void {
  if (cond.subject_key !== AI_EXIT_SUBJECT) return;
  if (cond.operator === "present") {
    router.matchesAny = true;
  } else if (cond.operator === "contains") {
    if (typeof cond.value === "string" && cond.value !== "") {
      router.containsValues.push(cond.value);
    } else {
      router.matchesAny = true;
    }
  } else if (cond.operator === "equals") {
    const tag = normalizeExitTag(cond.value);
    if (tag) router.equalsTags.add(tag);
  }
}

/**
 * Segue o `next_node_key` do nó de IA (atravessando nós que só avançam,
 * como "Definir variável") até o switch — ou cadeia de condições — que
 * decide por `ai_exit_code`. Devolve null quando não há roteador visível.
 */
export function findExitTagRouter(
  aiNode: RoutingNode,
  byKey: Map<string, RoutingNode>,
): ExitTagRouter | null {
  let key = aiNode.config.next_node_key;
  let chain: ExitTagRouter | null = null;
  const visited = new Set<string>();

  while (typeof key === "string" && key && !visited.has(key)) {
    visited.add(key);
    const node = byKey.get(key);
    if (!node) break;
    const cfg = node.config;

    if (node.node_type === "condition") {
      if (cfg.subject_key !== AI_EXIT_SUBJECT) break;
      chain ??= {
        node_key: node.node_key,
        kind: "condition",
        equalsTags: new Set(),
        containsValues: [],
        matchesAny: false,
        default_next: null,
      };
      addCondition(chain, cfg as RawCondition);
      const falseNext = typeof cfg.false_next === "string" ? cfg.false_next : null;
      chain.default_next = falseNext;
      key = falseNext ?? undefined;
      continue;
    }
    if (chain) break;

    if (node.node_type === "switch") {
      const branches = Array.isArray(cfg.branches)
        ? (cfg.branches as Array<{ conditions?: unknown }>)
        : [];
      const router: ExitTagRouter = {
        node_key: node.node_key,
        kind: "switch",
        equalsTags: new Set(),
        containsValues: [],
        matchesAny: false,
        default_next: typeof cfg.default_next === "string" ? cfg.default_next : null,
      };
      let usesExitCode = false;
      for (const branch of branches) {
        if (!Array.isArray(branch?.conditions)) continue;
        for (const cond of branch.conditions as RawCondition[]) {
          if (cond?.subject_key === AI_EXIT_SUBJECT) usesExitCode = true;
          addCondition(router, cond ?? {});
        }
      }
      return usesExitCode ? router : null;
    }

    if (node.node_type === "go_to") {
      key = cfg.target_node_key;
      continue;
    }
    if (PASSTHROUGH_TYPES.has(node.node_type) && !assignsExitCode(node)) {
      key = cfg.next_node_key;
      continue;
    }
    break;
  }
  return chain;
}

/** A tag tem ramo próprio no roteador (não cai no padrão)? */
export function routerHandlesTag(router: ExitTagRouter, tag: string): boolean {
  if (router.matchesAny || router.equalsTags.has(tag)) return true;
  return router.containsValues.some((v) => tag.includes(v));
}

// ============================================================
// Tags legadas
// ============================================================

/** Tags legadas e a sugestão de troca (null = sem troca óbvia). */
export const LEGACY_EXIT_TAG_HINTS: Readonly<Record<string, string | null>> = {
  "#EQUIPEHUMANA":
    "uma tag com o motivo específico (#CLIENTE_PEDIU_HUMANO, #CONTESTACAO_DIVIDA, #ERRO_EFETIVACAO, #FALLBACK_EXAURIDO…)",
  "#NAOLOCALIZADO": "#CPF_NAO_LOCALIZADO",
  "#NEGOCIACAO": null,
  "#ANIMA": null,
};
