/**
 * Save-time validation for flows.
 *
 * Run before activation (not on every draft save) — drafts are
 * intentionally allowed to be incomplete so users can save progress
 * mid-build. The builder calls these from BOTH client (so the user
 * sees issues live) and server (so a broken POST/PUT can't slip in
 * via direct API call).
 *
 * Three rule categories:
 *   1. Trigger sanity — keyword flows need keywords, etc.
 *   2. Graph integrity — entry node exists, all next_node_key
 *      references resolve, no unreachable nodes, non-terminal nodes
 *      have an outgoing edge.
 *   3. Meta API limits — button title ≤20 chars, ≤3 buttons per
 *      send_buttons, ≤10 list rows total, ≤24 chars per list row
 *      title. Mirrors the runtime checks inside
 *      `src/lib/whatsapp/meta-api.ts` so save-time and send-time
 *      can never disagree.
 *
 * Issues carry enough field info that the builder can highlight the
 * exact input that triggered them. Node-scoped issues include
 * `node_key`; trigger-scoped use `scope: 'trigger'`.
 */

import { findInlineSecrets, isDdmUrl } from "@/lib/ai/tool-secrets";
import {
  aiProviderLabel,
  getProviderForModel,
  isModelCompatibleWithProvider,
} from "@/lib/ai/models";
// Módulo puro: validate.ts roda no navegador (não importar meta-api.ts, que puxa o undici).
import { INTERACTIVE_LIMITS } from "@/lib/whatsapp/interactive-limits";
import { WEBCHAT_BUTTON_TEXT_MAX } from "@/lib/flows/types";
import {
  extractPromptExitTags,
  findExitTagRouter,
  flowExitTagsFromNodes,
  LEGACY_EXIT_TAG_HINTS,
  routerHandlesTag,
  type ExitTagRouter,
} from "@/lib/flows/exit-tag-routing";
import { KNOWN_AI_EXIT_TAGS } from "@/lib/ai/exit-tags";

export interface ValidationIssue {
  severity: "error" | "warning";
  scope: "flow" | "trigger" | "node";
  /** Stable node_key the issue is attached to, when scope === 'node'. */
  node_key?: string;
  /** Dotted path to the bad field, e.g. 'buttons.0.title'. */
  field?: string;
  message: string;
}

interface FlowInput {
  name: string;
  trigger_type: "keyword" | "first_inbound_message" | "manual" | "called_by_flow";
  trigger_config: Record<string, unknown>;
  entry_node_id: string | null;
}

interface NodeInput {
  node_key: string;
  node_type: string;
  config: Record<string, unknown>;
}

export function validateFlowForActivation(
  flow: FlowInput,
  nodes: NodeInput[],
  context: { aiProvider?: string | null } = {},
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // ---- name ----
  if (!flow.name || !flow.name.trim()) {
    issues.push({
      severity: "error",
      scope: "flow",
      field: "name",
      message: "O nome do fluxo é obrigatório.",
    });
  }

  // ---- trigger ----
  issues.push(...validateTrigger(flow.trigger_type, flow.trigger_config));

  // ---- graph integrity ----
  if (!flow.entry_node_id) {
    issues.push({
      severity: "error",
      scope: "flow",
      field: "entry_node_id",
      message: "Escolha um nó de entrada antes de ativar.",
    });
  }

  const keys = new Set(nodes.map((n) => n.node_key));
  if (nodes.length === 0) {
    issues.push({
      severity: "error",
      scope: "flow",
      message: "Um fluxo precisa de pelo menos um nó antes de ativar.",
    });
  }

  if (flow.entry_node_id && !keys.has(flow.entry_node_id)) {
    issues.push({
      severity: "error",
      scope: "flow",
      field: "entry_node_id",
      message: `O nó de entrada "${flow.entry_node_id}" não existe.`,
    });
  }

  // Duplicate node_key (the DB UNIQUE constraint catches this on save
  // too, but surfacing it client-side gives a friendlier error path).
  const seen = new Set<string>();
  for (const n of nodes) {
    if (seen.has(n.node_key)) {
      issues.push({
        severity: "error",
        scope: "node",
        node_key: n.node_key,
        message: `Chave de nó duplicada "${n.node_key}".`,
      });
    }
    seen.add(n.node_key);
  }

  // Per-node rules (Meta limits + dead-end + edge resolution).
  for (const n of nodes) {
    issues.push(...validateNode(n, keys, context));
  }

  // Variáveis em textos que chegam ao cliente: só {{vars.nome}} é trocado
  // pelo motor; {{nome}}, {{1}} (padrão do Disparador) etc. iriam literais.
  for (const n of nodes) {
    issues.push(...validateVariableTokens(n));
  }

  // Tags que o prompt da IA manda emitir × ramos do switch seguinte.
  issues.push(...validateAiExitTagRouting(nodes));

  // Reachability — every non-orphan node must be reachable from the
  // entry. Done after per-node validation so we don't double-report
  // when a node has bad config AND is unreachable.
  if (flow.entry_node_id && keys.has(flow.entry_node_id)) {
    const reached = reachableFromEntry(flow.entry_node_id, nodes);
    for (const n of nodes) {
      if (!reached.has(n.node_key)) {
        issues.push({
          severity: "warning",
          scope: "node",
          node_key: n.node_key,
          message: `O nó "${n.node_key}" não é alcançável a partir do nó de entrada.`,
        });
      }
    }
  }

  return issues;
}

// ============================================================
// Trigger
// ============================================================

function validateTrigger(
  trigger_type: FlowInput["trigger_type"],
  trigger_config: Record<string, unknown>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (trigger_type === "keyword") {
    const keywords = Array.isArray(trigger_config.keywords)
      ? (trigger_config.keywords as unknown[])
      : null;
    if (!keywords || keywords.length === 0) {
      issues.push({
        severity: "error",
        scope: "trigger",
        field: "trigger_config.keywords",
        message: "Disparos por palavra-chave precisam de pelo menos uma palavra-chave.",
      });
    } else {
      // Empty / whitespace-only keywords are silent no-ops at match
      // time — call them out so the user doesn't think they configured
      // a keyword that never fires.
      const blanks = keywords.filter(
        (k) => typeof k !== "string" || !k.trim(),
      ).length;
      if (blanks > 0) {
        issues.push({
          severity: "warning",
          scope: "trigger",
          field: "trigger_config.keywords",
          message: `${blanks} palavra-chave${blanks === 1 ? "" : "s"} em branco — não ${blanks === 1 ? "vai corresponder" : "vão corresponder"} a nada.`,
        });
      }
    }
  }
  // first_inbound_message / manual have no config; nothing to validate.

  return issues;
}

// ============================================================
// Per-node
// ============================================================

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Shared next_node_key check for the 7 new auto-advancing/suspending
 * node types (http_fetch, set_variable, smart_delay, anchor,
 * send_template, add_note, receive_attachment) — same "missing or
 * dangling" rule the older node types each inline individually.
 */
function validateNextNodeKey(
  node: NodeInput,
  nextNodeKey: string | undefined,
  knownKeys: Set<string>,
  label: string,
): ValidationIssue[] {
  if (!nextNodeKey) {
    return [
      {
        severity: "error",
        scope: "node",
        node_key: node.node_key,
        field: "next_node_key",
        message: `${label} precisa apontar para um próximo nó.`,
      },
    ];
  }
  if (!knownKeys.has(nextNodeKey)) {
    return [
      {
        severity: "error",
        scope: "node",
        node_key: node.node_key,
        field: "next_node_key",
        message: `${label} aponta para um nó inexistente "${nextNodeKey}".`,
      },
    ];
  }
  return [];
}

function validateNode(
  node: NodeInput,
  knownKeys: Set<string>,
  context: { aiProvider?: string | null },
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  switch (node.node_type) {
    case "start": {
      const cfg = node.config as { next_node_key?: string };
      if (!cfg.next_node_key) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: "O nó de início precisa apontar para um próximo nó.",
        });
      } else if (!knownKeys.has(cfg.next_node_key)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: `O início aponta para um nó inexistente "${cfg.next_node_key}".`,
        });
      }
      break;
    }

    case "send_message": {
      const cfg = node.config as { text?: string; next_node_key?: string };
      if (!cfg.text?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "text",
          message: "O nó de enviar mensagem precisa de um texto.",
        });
      }
      if (!cfg.next_node_key) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: "O nó de enviar mensagem precisa apontar para um próximo nó.",
        });
      } else if (!knownKeys.has(cfg.next_node_key)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: `Enviar mensagem aponta para um nó inexistente "${cfg.next_node_key}".`,
        });
      }
      break;
    }

    case "send_media": {
      const cfg = node.config as {
        media_type?: "image" | "video" | "document";
        media_url?: string;
        caption?: string;
        next_node_key?: string;
      };
      if (
        !cfg.media_type ||
        !["image", "video", "document"].includes(cfg.media_type)
      ) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "media_type",
          message: "O nó de enviar mídia precisa de um tipo de mídia (imagem, vídeo ou documento).",
        });
      }
      if (!cfg.media_url?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "media_url",
          message: "O nó de enviar mídia precisa de um arquivo (envie um antes de ativar).",
        });
      }
      // Caption cap mirrors Meta's interactive body cap; documented as a
      // hard limit in the WhatsApp Cloud API media-message reference.
      if (cfg.caption && cfg.caption.length > INTERACTIVE_LIMITS.bodyMaxLength) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "caption",
          message: `A legenda excede ${INTERACTIVE_LIMITS.bodyMaxLength} caracteres (limite do WhatsApp).`,
        });
      }
      if (!cfg.next_node_key) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: "O nó de enviar mídia precisa apontar para um próximo nó.",
        });
      } else if (!knownKeys.has(cfg.next_node_key)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: `Enviar mídia aponta para um nó inexistente "${cfg.next_node_key}".`,
        });
      }
      break;
    }

    case "send_buttons": {
      const cfg = node.config as {
        text?: string;
        buttons?: Array<{
          reply_id?: string;
          title?: string;
          next_node_key?: string;
        }>;
      };
      if (!cfg.text?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "text",
          message: "O nó de enviar botões precisa de um texto.",
        });
      }
      const btns = cfg.buttons ?? [];
      if (btns.length < 1) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "buttons",
          message: "Enviar botões precisa de pelo menos um botão.",
        });
      }
      if (btns.length > INTERACTIVE_LIMITS.maxButtons) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "buttons",
          message: `O WhatsApp permite no máximo ${INTERACTIVE_LIMITS.maxButtons} botões por mensagem.`,
        });
      }
      const seenIds = new Set<string>();
      btns.forEach((b, i) => {
        const field = `buttons.${i}`;
        if (!b.reply_id?.trim()) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: `${field}.reply_id`,
            message: `O botão ${i + 1} precisa de um reply id.`,
          });
        } else if (seenIds.has(b.reply_id)) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: `${field}.reply_id`,
            message: `Reply id de botão duplicado "${b.reply_id}".`,
          });
        }
        if (b.reply_id) seenIds.add(b.reply_id);

        if (!b.title?.trim()) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: `${field}.title`,
            message: `O botão ${i + 1} precisa de um título.`,
          });
        } else if (b.title.length > INTERACTIVE_LIMITS.buttonTitleMaxLength) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: `${field}.title`,
            message: `O título do botão ${i + 1} passa de ${INTERACTIVE_LIMITS.buttonTitleMaxLength} caracteres (limite do WhatsApp).`,
          });
        }

        if (!b.next_node_key) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: `${field}.next_node_key`,
            message: `O botão ${i + 1} precisa de um próximo nó.`,
          });
        } else if (!knownKeys.has(b.next_node_key)) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: `${field}.next_node_key`,
            message: `O botão ${i + 1} aponta para um nó inexistente "${b.next_node_key}".`,
          });
        }
      });
      break;
    }

    case "send_list": {
      const cfg = node.config as {
        text?: string;
        button_label?: string;
        sections?: Array<{
          title?: string;
          rows?: Array<{
            reply_id?: string;
            title?: string;
            description?: string;
            next_node_key?: string;
          }>;
        }>;
      };
      if (!cfg.text?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "text",
          message: "O nó de enviar lista precisa de um texto.",
        });
      }
      if (!cfg.button_label?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "button_label",
          message: "Enviar lista precisa de um rótulo de botão (o texto para expandir).",
        });
      }
      const sections = cfg.sections ?? [];
      const totalRows = sections.reduce(
        (sum, s) => sum + (s.rows?.length ?? 0),
        0,
      );
      if (totalRows < 1) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "sections",
          message: "Enviar lista precisa de pelo menos uma linha.",
        });
      }
      if (totalRows > INTERACTIVE_LIMITS.maxListRowsTotal) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "sections",
          message: `Enviar lista permite no máximo ${INTERACTIVE_LIMITS.maxListRowsTotal} linhas no total entre as seções.`,
        });
      }
      const seenIds = new Set<string>();
      sections.forEach((section, si) => {
        const rows = section.rows ?? [];
        rows.forEach((row, ri) => {
          const field = `sections.${si}.rows.${ri}`;
          if (!row.reply_id?.trim()) {
            issues.push({
              severity: "error",
              scope: "node",
              node_key: node.node_key,
              field: `${field}.reply_id`,
              message: `A linha ${ri + 1} na seção ${si + 1} precisa de um reply id.`,
            });
          } else if (seenIds.has(row.reply_id)) {
            issues.push({
              severity: "error",
              scope: "node",
              node_key: node.node_key,
              field: `${field}.reply_id`,
              message: `ID de linha de lista duplicado "${row.reply_id}".`,
            });
          }
          if (row.reply_id) seenIds.add(row.reply_id);

          if (!row.title?.trim()) {
            issues.push({
              severity: "error",
              scope: "node",
              node_key: node.node_key,
              field: `${field}.title`,
              message: `A linha ${ri + 1} precisa de um título.`,
            });
          } else if (
            row.title.length > INTERACTIVE_LIMITS.listRowTitleMaxLength
          ) {
            issues.push({
              severity: "error",
              scope: "node",
              node_key: node.node_key,
              field: `${field}.title`,
              message: `O título da linha ${ri + 1} excede ${INTERACTIVE_LIMITS.listRowTitleMaxLength} caracteres.`,
            });
          }
          if (
            row.description &&
            row.description.length >
              INTERACTIVE_LIMITS.listRowDescriptionMaxLength
          ) {
            issues.push({
              severity: "error",
              scope: "node",
              node_key: node.node_key,
              field: `${field}.description`,
              message: `A descrição da linha ${ri + 1} excede ${INTERACTIVE_LIMITS.listRowDescriptionMaxLength} caracteres.`,
            });
          }
          if (!row.next_node_key) {
            issues.push({
              severity: "error",
              scope: "node",
              node_key: node.node_key,
              field: `${field}.next_node_key`,
              message: `A linha ${ri + 1} precisa de um próximo nó.`,
            });
          } else if (!knownKeys.has(row.next_node_key)) {
            issues.push({
              severity: "error",
              scope: "node",
              node_key: node.node_key,
              field: `${field}.next_node_key`,
              message: `A linha ${ri + 1} aponta para um nó inexistente "${row.next_node_key}".`,
            });
          }
        });
      });
      break;
    }

    case "collect_input": {
      const cfg = node.config as {
        prompt_text?: string;
        var_key?: string;
        next_node_key?: string;
      };
      if (!cfg.prompt_text?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "prompt_text",
          message: "Coletar resposta precisa de uma pergunta para enviar ao cliente.",
        });
      }
      if (!cfg.var_key?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "var_key",
          message: "Coletar resposta precisa de uma var_key para guardar a resposta.",
        });
      } else if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(cfg.var_key)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "var_key",
          message: `A var_key "${cfg.var_key}" deve conter apenas letras, números e underscore, e começar com letra ou underscore.`,
        });
      }
      if (!cfg.next_node_key) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: "Coletar resposta precisa apontar para um próximo nó.",
        });
      } else if (!knownKeys.has(cfg.next_node_key)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: `Coletar resposta aponta para um nó inexistente "${cfg.next_node_key}".`,
        });
      }
      break;
    }

    case "condition": {
      const cfg = node.config as {
        subject?: "var" | "tag" | "contact_field";
        subject_key?: string;
        operator?: "equals" | "contains" | "present" | "absent";
        value?: string;
        true_next?: string;
        false_next?: string;
      };
      if (!cfg.subject || !["var", "tag", "contact_field"].includes(cfg.subject)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "subject",
          message: "A condição precisa de um assunto (var / tag / contact_field).",
        });
      }
      if (!cfg.subject_key?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "subject_key",
          message: "A condição precisa de um subject_key (nome da var, id da tag ou nome do campo).",
        });
      }
      if (
        !cfg.operator ||
        !["equals", "contains", "present", "absent"].includes(cfg.operator)
      ) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "operator",
          message: "A condição precisa de um operador.",
        });
      } else if (
        (cfg.operator === "equals" || cfg.operator === "contains") &&
        (cfg.value === undefined || cfg.value === "")
      ) {
        issues.push({
          severity: "warning",
          scope: "node",
          node_key: node.node_key,
          field: "value",
          message: `O operador "${cfg.operator}" geralmente espera um valor de comparação — um valor vazio só vai corresponder a assuntos vazios.`,
        });
      }
      for (const branch of ["true_next", "false_next"] as const) {
        const key = cfg[branch];
        if (!key) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: branch,
            message: `A condição precisa de um nó para o ramo "${branch === "true_next" ? "verdadeiro" : "falso"}".`,
          });
        } else if (!knownKeys.has(key)) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: branch,
            message: `O "${branch}" da condição aponta para um nó inexistente "${key}".`,
          });
        }
      }
      break;
    }

    case "switch": {
      const cfg = node.config as {
        branches?: Array<{
          label?: string;
          conditions?: Array<{ subject_key?: string }>;
          next_node_key?: string;
        }>;
        default_next?: string;
      };
      const branches = cfg.branches ?? [];
      if (branches.length === 0) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "branches",
          message: "O switch precisa de pelo menos um ramo.",
        });
      }
      branches.forEach((branch, i) => {
        const field = `branches.${i}`;
        const label = branch.label?.trim() || `Ramo ${i + 1}`;
        const conditions = branch.conditions ?? [];
        if (!conditions.some((c) => c.subject_key?.trim())) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: `${field}.conditions`,
            message: `${label} precisa de pelo menos uma condição com um assunto preenchido.`,
          });
        }
        issues.push(
          ...validateNextNodeKey(node, branch.next_node_key, knownKeys, label),
        );
      });
      issues.push(
        ...validateNextNodeKey(
          node,
          cfg.default_next,
          knownKeys,
          'O ramo "Senão" do switch',
        ),
      );
      break;
    }

    case "set_tag": {
      const cfg = node.config as {
        mode?: "add" | "remove";
        tag_id?: string;
        next_node_key?: string;
      };
      if (!cfg.mode || !["add", "remove"].includes(cfg.mode)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "mode",
          message: "Marcar contato precisa de um modo (adicionar ou remover).",
        });
      }
      if (!cfg.tag_id) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "tag_id",
          message: "Marcar contato precisa de uma tag para aplicar.",
        });
      }
      if (!cfg.next_node_key) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: "Marcar contato precisa apontar para um próximo nó.",
        });
      } else if (!knownKeys.has(cfg.next_node_key)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: `Marcar contato aponta para um nó inexistente "${cfg.next_node_key}".`,
        });
      }
      break;
    }

    case "handoff":
    case "handoff_agent":
    case "handoff_team": {
      const cfg = node.config as { reason_code?: string };
      if (!cfg.reason_code?.trim()) {
        issues.push({
          severity: "warning",
          scope: "node",
          node_key: node.node_key,
          field: "reason_code",
          message:
            "Defina um motivo estruturado para o handoff. Sem isso, o encaminhamento cai como INDEFINIDO nos relatórios.",
        });
      }
      break;
    }

    case "end":
      // Terminal node with no outgoing edges.
      break;

    case "http_fetch": {
      const cfg = node.config as {
        url?: string;
        method?: string;
        next_node_key?: string;
      };
      if (!cfg.url?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "url",
          message: "A requisição HTTP precisa de uma URL.",
        });
      }
      if (!cfg.method || !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(cfg.method)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "method",
          message: "A requisição HTTP precisa de um método (GET, POST, PUT, PATCH ou DELETE).",
        });
      }
      issues.push(...validateNextNodeKey(node, cfg.next_node_key, knownKeys, "A requisição HTTP"));
      break;
    }

    case "set_variable": {
      const cfg = node.config as {
        assignments?: Array<{ variable?: string; value?: string }>;
        next_node_key?: string;
      };
      const assignments = cfg.assignments ?? [];
      if (!assignments.some((a) => a.variable?.trim())) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "assignments",
          message: "Definir variável precisa de pelo menos uma variável com nome preenchido.",
        });
      }
      issues.push(...validateNextNodeKey(node, cfg.next_node_key, knownKeys, "Definir variável"));
      break;
    }

    case "smart_delay": {
      const cfg = node.config as {
        delay_seconds?: number;
        next_node_key?: string;
      };
      if (
        typeof cfg.delay_seconds !== "number" ||
        cfg.delay_seconds < 1 ||
        cfg.delay_seconds > 86400
      ) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "delay_seconds",
          message: "Aguardar precisa de um tempo de espera entre 1 segundo e 24 horas (86400s).",
        });
      }
      issues.push(...validateNextNodeKey(node, cfg.next_node_key, knownKeys, "Aguardar"));
      break;
    }

    case "anchor": {
      const cfg = node.config as { label?: string; next_node_key?: string };
      if (!cfg.label?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "label",
          message: "A âncora precisa de um nome.",
        });
      }
      issues.push(...validateNextNodeKey(node, cfg.next_node_key, knownKeys, "A âncora"));
      break;
    }

    case "go_to": {
      const cfg = node.config as { target_node_key?: string };
      if (!cfg.target_node_key) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "target_node_key",
          message: '"Ir para" precisa de uma âncora de destino.',
        });
      } else if (!knownKeys.has(cfg.target_node_key)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "target_node_key",
          message: `"Ir para" aponta para um nó inexistente "${cfg.target_node_key}".`,
        });
      }
      break;
    }

    case "send_webchat": {
      const cfg = node.config as {
        message_text?: string;
        button_text?: string;
        next_node_key?: string;
      };
      if (!cfg.message_text?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "message_text",
          message: '"Enviar para Webchat" precisa do texto do convite.',
        });
      } else if (cfg.message_text.length > INTERACTIVE_LIMITS.bodyMaxLength) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "message_text",
          message: `O convite excede ${INTERACTIVE_LIMITS.bodyMaxLength} caracteres (limite do WhatsApp).`,
        });
      }
      // Limite da Meta para o rótulo de botão de URL (cta_url display_text).
      if (!cfg.button_text?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "button_text",
          message: '"Enviar para Webchat" precisa do texto do botão.',
        });
      } else if (cfg.button_text.length > WEBCHAT_BUTTON_TEXT_MAX) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "button_text",
          message: `O texto do botão aceita até ${WEBCHAT_BUTTON_TEXT_MAX} caracteres (limite do WhatsApp).`,
        });
      }
      if (!cfg.next_node_key) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: '"Enviar para Webchat" precisa do nó que continua dentro do Webchat.',
        });
      } else if (!knownKeys.has(cfg.next_node_key)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: `"Enviar para Webchat" aponta para um nó inexistente "${cfg.next_node_key}".`,
        });
      }
      break;
    }

    case "go_to_flow": {
      const cfg = node.config as { flow_id?: string; pass_vars?: boolean };
      if (!cfg.flow_id?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "flow_id",
          message: '"Ir para fluxo" precisa de um fluxo de destino.',
        });
      } else if (!UUID_RE.test(cfg.flow_id)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "flow_id",
          message: `"${cfg.flow_id}" não é um id de fluxo válido.`,
        });
      }
      break;
    }

    case "send_template": {
      const cfg = node.config as {
        template_name?: string;
        language_code?: string;
        next_node_key?: string;
      };
      if (!cfg.template_name?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "template_name",
          message: "Modelo de mensagem precisa do nome do template.",
        });
      }
      if (!cfg.language_code?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "language_code",
          message: "Modelo de mensagem precisa do código de idioma (ex.: pt_BR).",
        });
      }
      issues.push(...validateNextNodeKey(node, cfg.next_node_key, knownKeys, "Modelo de mensagem"));
      break;
    }

    case "add_note": {
      const cfg = node.config as { note_text?: string; next_node_key?: string };
      if (!cfg.note_text?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "note_text",
          message: "Nota de atendimento precisa de um texto.",
        });
      }
      issues.push(...validateNextNodeKey(node, cfg.next_node_key, knownKeys, "Nota de atendimento"));
      break;
    }

    case "receive_attachment": {
      const cfg = node.config as {
        var_name?: string;
        next_node_key?: string;
      };
      if (!cfg.var_name?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "var_name",
          message: "Receber anexo precisa de um nome de variável para guardar o arquivo.",
        });
      } else if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(cfg.var_name)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "var_name",
          message: `O nome de variável "${cfg.var_name}" deve conter apenas letras, números e underscore, e começar com letra ou underscore.`,
        });
      }
      issues.push(...validateNextNodeKey(node, cfg.next_node_key, knownKeys, "Receber anexo"));
      break;
    }

    case "ai_agent": {
      const cfg = node.config as {
        mode?: "once" | "loop" | "takeover";
        model?: string | null;
        next_node_key?: string;
        max_turns?: number;
      };
      if (!cfg.mode || !["once", "loop", "takeover"].includes(cfg.mode)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "mode",
          message: "O agente de IA precisa de um modo (responder uma vez, loop ou assumir conversa).",
        });
      }
      if (cfg.model?.trim()) {
        const modelProvider = getProviderForModel(cfg.model);
        if (!modelProvider) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: "model",
            message: `O modelo "${cfg.model}" não está no registry de modelos suportados.`,
          });
        } else if (
          context.aiProvider &&
          !isModelCompatibleWithProvider(cfg.model, context.aiProvider)
        ) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: "model",
            message: `O modelo "${cfg.model}" pertence a ${aiProviderLabel(modelProvider)}, mas a conta está configurada com ${aiProviderLabel(context.aiProvider)}.`,
          });
        }
      }
      if (cfg.mode === "once" || cfg.mode === "loop") {
        issues.push(
          ...validateNextNodeKey(node, cfg.next_node_key, knownKeys, "O agente de IA"),
        );
      }
      if (
        cfg.mode === "loop" &&
        cfg.max_turns !== undefined &&
        (typeof cfg.max_turns !== "number" || cfg.max_turns < 1)
      ) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "max_turns",
          message: "O limite de turnos do loop precisa ser um número maior que zero.",
        });
      }
      // Token em texto na URL de uma ferramenta: fica gravado no banco e
      // visível no editor — usar o marcador resolvido no servidor.
      const tools = Array.isArray((node.config as { tools?: unknown }).tools)
        ? (node.config as { tools: Array<{ name?: string; http?: { url?: string } }> }).tools
        : [];
      for (const tool of tools) {
        const inline = findInlineSecrets(tool.http?.url ?? "");
        if (inline.length > 0) {
          // A DDM tem marcador próprio ({{secret.DDM_TOKEN}}): token em texto bloqueia a ativação.
          // Outros domínios não têm marcador → continua aviso.
          issues.push({
            severity: isDdmUrl(tool.http?.url ?? "") ? "error" : "warning",
            scope: "node",
            node_key: node.node_key,
            field: "tools",
            message: `A ferramenta "${tool.name ?? "sem nome"}" tem um token em texto na URL (${inline.join(", ")}=…). Troque o valor por {{secret.DDM_TOKEN}} — o token fica só no servidor.`,
          });
        }
      }
      break;
    }

    default:
      issues.push({
        severity: "error",
        scope: "node",
        node_key: node.node_key,
        message: `Tipo de nó desconhecido "${node.node_type}".`,
      });
  }

  return issues;
}

// ============================================================
// Reachability — BFS from the entry, follow outgoing edges per node
// ============================================================

export function reachableFromEntry(
  entryKey: string,
  nodes: NodeInput[],
): Set<string> {
  const byKey = new Map<string, NodeInput>();
  for (const n of nodes) byKey.set(n.node_key, n);

  const visited = new Set<string>();
  const queue: string[] = [entryKey];
  while (queue.length > 0) {
    const key = queue.shift() as string;
    if (visited.has(key)) continue;
    visited.add(key);
    const node = byKey.get(key);
    if (!node) continue;
    for (const next of outgoingEdges(node)) {
      if (!visited.has(next)) queue.push(next);
    }
  }
  return visited;
}

function outgoingEdges(node: NodeInput): string[] {
  switch (node.node_type) {
    case "start":
    case "send_message":
    case "send_media":
    case "collect_input":
    case "set_tag":
    case "http_fetch":
    case "set_variable":
    case "smart_delay":
    case "anchor":
    case "send_template":
    case "add_note":
    case "receive_attachment":
    case "send_webchat": {
      const cfg = node.config as { next_node_key?: string };
      return cfg.next_node_key ? [cfg.next_node_key] : [];
    }
    case "go_to": {
      const cfg = node.config as { target_node_key?: string };
      return cfg.target_node_key ? [cfg.target_node_key] : [];
    }
    case "condition": {
      const cfg = node.config as {
        true_next?: string;
        false_next?: string;
      };
      const out: string[] = [];
      if (cfg.true_next) out.push(cfg.true_next);
      if (cfg.false_next) out.push(cfg.false_next);
      return out;
    }
    case "switch": {
      const cfg = node.config as {
        branches?: Array<{ next_node_key?: string }>;
        default_next?: string;
      };
      const out = (cfg.branches ?? [])
        .map((b) => b.next_node_key)
        .filter((k): k is string => !!k);
      if (cfg.default_next) out.push(cfg.default_next);
      return out;
    }
    case "send_buttons": {
      const cfg = node.config as {
        buttons?: Array<{ next_node_key?: string }>;
      };
      return (cfg.buttons ?? [])
        .map((b) => b.next_node_key)
        .filter((k): k is string => !!k);
    }
    case "send_list": {
      const cfg = node.config as {
        sections?: Array<{ rows?: Array<{ next_node_key?: string }> }>;
      };
      const out: string[] = [];
      for (const s of cfg.sections ?? []) {
        for (const r of s.rows ?? []) {
          if (r.next_node_key) out.push(r.next_node_key);
        }
      }
      return out;
    }
    case "ai_agent": {
      const cfg = node.config as { mode?: string; next_node_key?: string };
      if (cfg.mode === "takeover") return [];
      return cfg.next_node_key ? [cfg.next_node_key] : [];
    }
    case "handoff":
    case "handoff_agent":
    case "handoff_team":
    case "end":
    default:
      return [];
  }
}

// Campos interpolados pelo motor (interpolateVars em engine.ts). O prompt
// da IA fica de fora: chaves ali podem ser texto legítimo.
const INTERPOLATED_FIELDS = [
  "text",
  "caption",
  "prompt_text",
  "url",
  "body_template",
  "message",
  "message_text",
  "fallback_text",
  "note_text",
  "header_text",
  "footer_text",
] as const;

const VALID_VAR_TOKEN = /^{{vars.[a-zA-Z0-9_]+}}$/;

/** Avisos para {{…}} fora do formato {{vars.nome}} (iriam literais ao cliente). */
export function validateVariableTokens(node: NodeInput): ValidationIssue[] {
  const texts: string[] = [];
  for (const f of INTERPOLATED_FIELDS) {
    const v = node.config[f];
    if (typeof v === "string") texts.push(v);
  }
  if (node.node_type === "set_variable" && Array.isArray(node.config.assignments)) {
    for (const a of node.config.assignments as Array<{ value?: unknown }>) {
      if (typeof a?.value === "string") texts.push(a.value);
    }
  }
  const bad = new Set<string>();
  for (const t of texts) {
    for (const m of t.matchAll(/{{[^{}]*}}/g)) {
      if (!VALID_VAR_TOKEN.test(m[0])) bad.add(m[0]);
    }
  }
  if (bad.size === 0) return [];
  return [
    {
      severity: "warning",
      scope: "node",
      node_key: node.node_key,
      message: `Variável fora do padrão em "${node.node_key}": ${[...bad].join(", ")} vai literal ao cliente — use {{vars.nome}} (ex.: a variável gravada por "Coletar resposta").`,
    },
  ];
}

// ============================================================
// Tags de saída da IA × ramos do switch seguinte
// ============================================================

function routerLabel(router: ExitTagRouter): string {
  return router.kind === "switch"
    ? `o switch "${router.node_key}"`
    : `a condição "${router.node_key}"`;
}

/**
 * Avisos (nunca erros) quando o prompt de um nó de IA cita uma #TAG sem
 * ramo no switch seguinte — a tag cai no padrão, que costuma ser humano —
 * e o inverso: ramo para tag que nenhum prompt cita. Nós de IA sem
 * instruções próprias ficam de fora: o prompt vem da configuração da
 * conta e não é visível aqui.
 */
export function validateAiExitTagRouting(nodes: NodeInput[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byKey = new Map(nodes.map((n) => [n.node_key, n]));
  const flowTags = new Set(flowExitTagsFromNodes(nodes));
  const knownTags = new Set(KNOWN_AI_EXIT_TAGS);
  // Por roteador: tags citadas pelos nós de IA que chegam nele.
  const feeders = new Map<
    string,
    { router: ExitTagRouter; mentioned: Set<string>; blind: boolean; aiKeys: string[] }
  >();

  for (const n of nodes) {
    if (n.node_type !== "ai_agent") continue;
    const cfg = n.config as { mode?: string; system_prompt_override?: unknown };
    const prompt =
      typeof cfg.system_prompt_override === "string"
        ? cfg.system_prompt_override.trim()
        : "";
    // "Assumir conversa" encerra o fluxo: a tag não passa por switch.
    const router = cfg.mode === "takeover" ? null : findExitTagRouter(n, byKey);
    const mentions = prompt ? extractPromptExitTags(prompt) : null;

    if (router) {
      const entry = feeders.get(router.node_key) ?? {
        router,
        mentioned: new Set<string>(),
        blind: false,
        aiKeys: [],
      };
      entry.aiKeys.push(n.node_key);
      if (!mentions) entry.blind = true;
      else for (const t of mentions.mentioned) entry.mentioned.add(t);
      feeders.set(router.node_key, entry);
    }
    if (!mentions) continue;

    for (const tag of mentions.emitted) {
      if (tag in LEGACY_EXIT_TAG_HINTS) {
        const hint = LEGACY_EXIT_TAG_HINTS[tag];
        issues.push({
          severity: "warning",
          scope: "node",
          node_key: n.node_key,
          field: "system_prompt_override",
          message: hint
            ? `Sugestão: as instruções de "${n.node_key}" usam a tag legada ${tag}. Prefira ${hint}.`
            : `Sugestão: as instruções de "${n.node_key}" usam a tag legada ${tag}. Confira se ainda faz sentido ou se há uma tag mais específica.`,
        });
      }
      if (!router || routerHandlesTag(router, tag)) continue;
      const literal = !knownTags.has(tag) && !flowTags.has(tag);
      issues.push({
        severity: "warning",
        scope: "node",
        node_key: n.node_key,
        field: "system_prompt_override",
        message: literal
          ? `A IA pode emitir ${tag}, mas essa tag não é conhecida nem tem ramo em nenhum switch do fluxo — ela iria como texto para o cliente e a conversa não sairia do nó.`
          : `A IA pode emitir ${tag}, mas ${routerLabel(router)} não tem ramo para essa tag — cai no padrão (${router.default_next ?? "nenhum nó configurado"}).`,
      });
    }
  }

  // Inverso (mais brando): ramo para tag que nenhum prompt cita. Pode ser
  // legítimo — o código força algumas tags (travas automáticas).
  for (const { router, mentioned, blind, aiKeys } of feeders.values()) {
    if (blind) continue;
    const label = routerLabel(router);
    for (const tag of router.equalsTags) {
      if (mentioned.has(tag)) continue;
      issues.push({
        severity: "warning",
        scope: "node",
        node_key: router.node_key,
        message: `Sugestão: ${label} tem ramo para ${tag}, mas as instruções de ${aiKeys.map((k) => `"${k}"`).join(", ")} não citam essa tag. O ramo só será usado se o sistema forçar a tag — confira se não falta a instrução no prompt.`,
      });
    }
  }

  return issues;
}
