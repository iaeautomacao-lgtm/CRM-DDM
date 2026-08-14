/**
 * Shared editor primitives used by both the linear-list and canvas
 * views of a flow.
 *
 * What lives here vs in flow-builder.tsx / flow-canvas.tsx:
 *   - Types and metadata that BOTH views need to render a node
 *     consistently (icon, label, color, 1-line summary).
 *   - Editing-only helpers (defaultConfigFor, slugify, uniqueNodeKey,
 *     BuilderState) stay in flow-builder.tsx until the canvas grows
 *     editing affordances — pulled across in the PR that adds them.
 *
 * Why .tsx and not .ts: NODE_META holds lucide icon components, which
 * are typed as React components; importing them from a .ts module
 * works at runtime but trips TypeScript's
 * `verbatimModuleSyntax`-related linting in some setups. Keeping the
 * file .tsx future-proofs it for inline JSX in node-card renderers.
 */

import {
  Anchor as AnchorIcon,
  Bot,
  Clock,
  CornerDownRight,
  FileDown,
  FileText,
  Flag,
  GitBranch,
  GitFork,
  Globe,
  Inbox,
  ListChecks,
  ListPlus,
  MessageCircle,
  Paperclip,
  PlayCircle,
  StickyNote,
  Tag,
  UserPlus,
  Variable,
  Workflow,
} from 'lucide-react';

import { cn } from '@/lib/utils';

// ============================================================
// Node-type union — single source of truth for every place the UI
// enumerates types (add menu, type pickers, switch statements). Kept
// in lockstep with `FlowNodeType` in src/lib/flows/types.ts (which
// drives the engine's exhaustiveness check); a divergence between the
// two is always a bug.
// ============================================================

export type NodeType =
  | 'start'
  | 'send_message'
  | 'send_buttons'
  | 'send_list'
  | 'send_media'
  | 'collect_input'
  | 'condition'
  | 'set_tag'
  | 'handoff'
  | 'end'
  | 'http_fetch'
  | 'set_variable'
  | 'smart_delay'
  | 'anchor'
  | 'go_to'
  | 'go_to_flow'
  | 'send_template'
  | 'add_note'
  | 'receive_attachment'
  | 'ai_agent';

export interface BuilderNode {
  node_key: string;
  node_type: NodeType;
  config: Record<string, unknown>;
  /** Optional in v1 — defaults to 0 in the DB. Canvas view reads it
   *  to position nodes; list view ignores it. */
  position_x?: number;
  position_y?: number;
}

// ============================================================
// Per-node-type metadata used to render icons + labels everywhere
// the user sees a node summary.
// ============================================================

// ------------------------------------------------------------
// Node categories — buckets the add-step menu groups types under so
// the picker stays scannable as the type list grows, and so a fork
// adding its own node types has an obvious place to slot them.
//
// Note there's no "Events / Triggers" category: in wacrm a flow is
// triggered by flow-level config (`trigger_type`), not by a node on
// the canvas, so `start` is just the entry point under Flow control.
// ------------------------------------------------------------

export type NodeCategory = 'messaging' | 'logic' | 'flow';

/** Category labels + the order they render in the add-step menu. */
export const NODE_CATEGORIES: { id: NodeCategory; label: string }[] = [
  { id: 'messaging', label: 'Mensagens' },
  { id: 'logic', label: 'Lógica e dados' },
  { id: 'flow', label: 'Controle de fluxo' },
];

export const NODE_META: Record<
  NodeType,
  {
    label: string;
    icon: typeof Workflow;
    color: string;
    blurb: string;
    category: NodeCategory;
  }
> = {
  start: {
    label: 'Início',
    icon: PlayCircle,
    color: 'text-emerald-400',
    blurb: 'Ponto de entrada do fluxo',
    category: 'flow',
  },
  send_message: {
    label: 'Enviar mensagem',
    icon: MessageCircle,
    color: 'text-sky-400',
    blurb: 'Envia uma mensagem de texto no WhatsApp',
    category: 'messaging',
  },
  send_buttons: {
    label: 'Enviar botões',
    icon: ListChecks,
    color: 'text-primary',
    blurb: 'Envia botões de resposta rápida',
    category: 'messaging',
  },
  send_list: {
    label: 'Enviar lista',
    icon: ListPlus,
    color: 'text-indigo-400',
    blurb: 'Envia uma lista de opções para o cliente tocar',
    category: 'messaging',
  },
  send_media: {
    label: 'Enviar mídia',
    icon: Paperclip,
    color: 'text-cyan-400',
    blurb: 'Envia uma imagem, vídeo ou documento',
    category: 'messaging',
  },
  collect_input: {
    label: 'Coletar resposta',
    icon: Inbox,
    color: 'text-teal-400',
    blurb: 'Faz uma pergunta e salva a resposta',
    category: 'logic',
  },
  condition: {
    label: 'Se / senão',
    icon: GitFork,
    color: 'text-fuchsia-400',
    blurb: 'Ramifica com base em uma regra',
    category: 'logic',
  },
  set_tag: {
    label: 'Marcar contato',
    icon: Tag,
    color: 'text-pink-400',
    blurb: 'Adiciona ou remove uma tag do contato',
    category: 'logic',
  },
  handoff: {
    label: 'Transferir para agente',
    icon: UserPlus,
    color: 'text-amber-400',
    blurb: 'Transfere a conversa para um humano',
    category: 'flow',
  },
  end: {
    label: 'Fim',
    icon: Flag,
    color: 'text-muted-foreground',
    blurb: 'Encerra o fluxo',
    category: 'flow',
  },
  http_fetch: {
    label: 'Requisição HTTP',
    icon: Globe,
    color: 'text-amber-400',
    blurb: 'Chama uma API externa e opcionalmente guarda a resposta',
    category: 'logic',
  },
  set_variable: {
    label: 'Definir variável',
    icon: Variable,
    color: 'text-purple-400',
    blurb: 'Grava um ou mais valores em flow_runs.vars',
    category: 'logic',
  },
  smart_delay: {
    label: 'Aguardar',
    icon: Clock,
    color: 'text-slate-400',
    blurb: 'Pausa o fluxo por um tempo antes de continuar',
    category: 'flow',
  },
  anchor: {
    label: 'Âncora',
    icon: AnchorIcon,
    color: 'text-lime-400',
    blurb: 'Ponto de referência nomeado para o nó "Ir para"',
    category: 'flow',
  },
  go_to: {
    label: 'Ir para',
    icon: CornerDownRight,
    color: 'text-green-400',
    blurb: 'Salta para uma âncora do mesmo fluxo',
    category: 'flow',
  },
  go_to_flow: {
    label: 'Ir para fluxo',
    icon: GitBranch,
    color: 'text-blue-400',
    blurb: 'Transfere a conversa para outro fluxo',
    category: 'flow',
  },
  send_template: {
    label: 'Modelo de mensagem',
    icon: FileText,
    color: 'text-emerald-500',
    blurb: 'Envia um template aprovado pela Meta (HSM)',
    category: 'messaging',
  },
  add_note: {
    label: 'Nota de atendimento',
    icon: StickyNote,
    color: 'text-orange-400',
    blurb: 'Registra uma nota interna no contato',
    category: 'logic',
  },
  receive_attachment: {
    label: 'Receber anexo',
    icon: FileDown,
    color: 'text-fuchsia-400',
    blurb: 'Espera o cliente enviar uma imagem, vídeo, áudio ou documento',
    category: 'messaging',
  },
  ai_agent: {
    label: 'Agente de IA',
    icon: Bot,
    // DDM brand orange (#FF5706).
    color: 'text-orange-500',
    blurb: 'Aciona o agente de IA para responder ao cliente',
    category: 'messaging',
  },
};

/**
 * Bucket an ordered list of node types by category, preserving both
 * the category order (NODE_CATEGORIES) and the within-category order
 * of the input list. Empty categories are dropped. Used by both the
 * canvas and list add-step menus so they stay in lockstep.
 */
export function groupNodeTypesByCategory(
  types: NodeType[]
): { id: NodeCategory; label: string; types: NodeType[] }[] {
  return NODE_CATEGORIES.map(({ id, label }) => ({
    id,
    label,
    types: types.filter((t) => NODE_META[t].category === id),
  })).filter((group) => group.types.length > 0);
}

// ============================================================
// Per-node-type color system.
//
// Each node type gets its own hue so the canvas reads at a glance —
// what KIND of step is this. Kept as raw oklch (not Tailwind classes)
// so a node card can tint its icon chip, type label, selection ring,
// and edge ports from one source, the way the Flow Builder design
// handoff does. Hues sit in the same oklch family as the app tokens
// in globals.css; they don't replace --primary (the accent), they
// complement it. `nodeColors()` derives the soft/ring/text variants.
// ============================================================

const NODE_HUE: Record<NodeType, { l: number; c: number; h: number }> = {
  start: { l: 0.62, c: 0.13, h: 162 }, // emerald — the start, echoes WhatsApp green
  send_message: { l: 0.6, c: 0.18, h: 293 }, // violet — the workhorse
  send_buttons: { l: 0.62, c: 0.16, h: 254 }, // cobalt
  send_list: { l: 0.62, c: 0.15, h: 277 }, // indigo
  send_media: { l: 0.65, c: 0.12, h: 210 }, // sky
  collect_input: { l: 0.65, c: 0.1, h: 185 }, // teal — capture
  condition: { l: 0.72, c: 0.15, h: 65 }, // amber — a fork in the road
  set_tag: { l: 0.65, c: 0.15, h: 350 }, // pink
  handoff: { l: 0.65, c: 0.17, h: 16 }, // rose — hands off
  end: { l: 0.55, c: 0.01, h: 260 }, // neutral grey — terminal
  http_fetch: { l: 0.68, c: 0.15, h: 50 }, // amber-gold — external call
  set_variable: { l: 0.62, c: 0.16, h: 305 }, // purple — data write
  smart_delay: { l: 0.55, c: 0.04, h: 240 }, // muted blue-grey — a pause, not a color
  anchor: { l: 0.68, c: 0.13, h: 100 }, // yellow-green — a landing spot
  go_to: { l: 0.65, c: 0.14, h: 125 }, // green — jumps to an anchor
  go_to_flow: { l: 0.62, c: 0.15, h: 232 }, // blue — leaves to another flow
  send_template: { l: 0.65, c: 0.14, h: 148 }, // green-emerald — an approved send
  add_note: { l: 0.68, c: 0.16, h: 38 }, // orange — a flag for humans
  receive_attachment: { l: 0.65, c: 0.17, h: 335 }, // magenta-pink — inbound media
  ai_agent: { l: 0.65, c: 0.2, h: 32 }, // DDM brand orange (#FF5706) — the AI speaks
};

export interface NodeColors {
  /** Full-strength hue — icon glyph, selection ring, port fill. */
  solid: string;
  /** ~14% tint — icon chip background, soft fills. */
  soft: string;
  /** ~45% tint — hover border / focus ring. */
  ring: string;
  /** Hue for the uppercase type label, kept readable in BOTH modes. */
  text: string;
}

export function nodeColors(type: NodeType): NodeColors {
  const t = NODE_HUE[type];
  const solid = `oklch(${t.l} ${t.c} ${t.h})`;
  return {
    solid,
    soft: `oklch(${t.l} ${t.c} ${t.h} / 0.14)`,
    ring: `oklch(${t.l} ${t.c} ${t.h} / 0.45)`,
    // Blend the hue toward the live --foreground token so the label
    // holds contrast in BOTH modes: in dark mode --foreground is
    // near-white (the label lightens to read on the dark card), in
    // light mode it's near-black (the label darkens to read on the
    // white card). The old fixed-light value only worked on dark.
    text: `color-mix(in oklch, ${solid}, var(--foreground) 38%)`,
  };
}

// ============================================================
// Shared node icon chip — the per-type colored glyph badge used in
// the canvas node card, list-view card, inspector header, and the
// add-step menu. One component so a styling change (radius, contrast,
// hover) lands in every place at once and the `nodeColors()` lookup
// lives in exactly one spot.
// ============================================================

export function NodeIconChip({
  type,
  size = 24,
  iconSize = 14,
  className,
}: {
  type: NodeType;
  /** Chip side length in px. */
  size?: number;
  /** Glyph side length in px. */
  iconSize?: number;
  className?: string;
}) {
  const meta = NODE_META[type];
  const c = nodeColors(type);
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-lg',
        className
      )}
      style={{ width: size, height: size, background: c.soft, color: c.solid }}
    >
      <Icon size={iconSize} />
    </span>
  );
}

// ============================================================
// Pure editing helpers — used by forms in both views.
// ============================================================

/**
 * Coerce an arbitrary string into a stable identifier (node_key,
 * reply_id, etc.). Lowercases, collapses non-alphanumerics into
 * single underscores, and trims leading/trailing underscores. Falls
 * back to `fallback` for inputs that reduce to an empty string.
 */
export function slugify(s: string, fallback: string): string {
  const cleaned = s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

// ============================================================
// Summary helpers — short, single-line content previews used in
// collapsed node cards (list view) and node tiles (canvas view).
// Returns null when there's nothing meaningful to show (start/end,
// or a freshly-added node with no fields filled in).
// ============================================================

export function truncate(s: string, max = 80): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1) + '…';
}

export function summarizeNode(node: BuilderNode): string | null {
  const cfg = node.config;
  switch (node.node_type) {
    case 'start':
    case 'end':
      return null;
    case 'send_message': {
      const text = typeof cfg.text === 'string' ? cfg.text : '';
      return text.length > 0 ? truncate(text) : null;
    }
    case 'send_buttons': {
      const text = typeof cfg.text === 'string' ? cfg.text : '';
      const buttons = Array.isArray(cfg.buttons)
        ? (cfg.buttons as Array<Record<string, unknown>>)
        : [];
      const titles = buttons
        .map((b) => (typeof b.title === 'string' ? b.title : ''))
        .filter(Boolean)
        .join(' / ');
      if (text.length > 0) {
        return titles
          ? `${truncate(text, 40)} · ${truncate(titles, 35)}`
          : truncate(text);
      }
      return titles || null;
    }
    case 'send_list': {
      const text = typeof cfg.text === 'string' ? cfg.text : '';
      const sections = Array.isArray(cfg.sections)
        ? (cfg.sections as Array<Record<string, unknown>>)
        : [];
      const rowCount = sections.reduce<number>((sum, s) => {
        const rows = Array.isArray(s.rows) ? s.rows : [];
        return sum + rows.length;
      }, 0);
      if (text.length > 0) {
        return rowCount > 0
          ? `${truncate(text, 50)} · ${rowCount} ${rowCount === 1 ? 'opção' : 'opções'}`
          : truncate(text);
      }
      return rowCount > 0
        ? `${rowCount} ${rowCount === 1 ? 'opção' : 'opções'} em ${sections.length} ${sections.length === 1 ? 'seção' : 'seções'}`
        : null;
    }
    case 'send_media': {
      const mediaType =
        typeof cfg.media_type === 'string' ? cfg.media_type : '';
      const filename = typeof cfg.filename === 'string' ? cfg.filename : '';
      const url = typeof cfg.media_url === 'string' ? cfg.media_url : '';
      const caption = typeof cfg.caption === 'string' ? cfg.caption : '';
      const MEDIA_TYPE_LABEL: Record<string, string> = {
        image: 'Imagem',
        video: 'Vídeo',
        document: 'Documento',
      };
      const label = mediaType ? MEDIA_TYPE_LABEL[mediaType] ?? 'Mídia' : 'Mídia';
      if (!url) return `${label} (nenhum arquivo enviado)`;
      const name = filename || url.split('/').pop() || 'arquivo';
      return caption
        ? `${label}: ${truncate(name, 30)} · ${truncate(caption, 40)}`
        : `${label}: ${truncate(name, 60)}`;
    }
    case 'collect_input': {
      const prompt = typeof cfg.prompt_text === 'string' ? cfg.prompt_text : '';
      const varKey = typeof cfg.var_key === 'string' ? cfg.var_key : '';
      if (prompt.length > 0) {
        return varKey
          ? `${truncate(prompt, 50)} → vars.${varKey}`
          : truncate(prompt);
      }
      return varKey ? `→ vars.${varKey}` : null;
    }
    case 'condition': {
      const subjectKey =
        typeof cfg.subject_key === 'string' ? cfg.subject_key : '';
      if (!subjectKey) return null;
      const subject =
        cfg.subject === 'tag'
          ? 'tag'
          : cfg.subject === 'contact_field'
            ? 'field'
            : 'var';
      const subjectStr =
        subject === 'tag'
          ? `tem a tag ${truncate(subjectKey, 24)}`
          : `${subject}.${subjectKey}`;
      const op =
        cfg.operator === 'equals'
          ? '=='
          : cfg.operator === 'contains'
            ? 'contém'
            : cfg.operator === 'present'
              ? 'existe'
              : cfg.operator === 'absent'
                ? 'ausente'
                : '';
      const value = typeof cfg.value === 'string' ? cfg.value : '';
      const valStr =
        (cfg.operator === 'equals' || cfg.operator === 'contains') && value
          ? ` "${truncate(value, 20)}"`
          : '';
      return subject === 'tag' ? subjectStr : `${subjectStr} ${op}${valStr}`;
    }
    case 'set_tag': {
      const mode = cfg.mode === 'remove' ? 'Remover' : 'Adicionar';
      const tagId = typeof cfg.tag_id === 'string' ? cfg.tag_id : '';
      // No tag name available without an async lookup here; show a
      // short prefix of the UUID so users can disambiguate between
      // multiple set_tag nodes at a glance.
      return tagId
        ? `${mode} tag ${tagId.slice(0, 8)}…`
        : `${mode} tag (nenhuma selecionada)`;
    }
    case 'handoff': {
      const note = typeof cfg.note === 'string' ? cfg.note : '';
      const assignTo = typeof cfg.assign_to === 'string' ? cfg.assign_to : '';
      const teamId = typeof cfg.team_id === 'string' ? cfg.team_id : '';
      // No agent/team name available without an async lookup here —
      // same tradeoff as set_tag above — so show a short id prefix.
      const target = [
        teamId ? `equipe ${teamId.slice(0, 8)}…` : '',
        assignTo ? `agente ${assignTo.slice(0, 8)}…` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      if (note.length > 0) return target ? `${truncate(note, 40)} (${target})` : truncate(note);
      return target || null;
    }
    case 'http_fetch': {
      const method = typeof cfg.method === 'string' ? cfg.method : '';
      const url = typeof cfg.url === 'string' ? cfg.url : '';
      if (!url) return null;
      return method ? `${method} ${truncate(url, 60)}` : truncate(url);
    }
    case 'set_variable': {
      const assignments = Array.isArray(cfg.assignments)
        ? (cfg.assignments as Array<Record<string, unknown>>)
        : [];
      const names = assignments
        .map((a) => (typeof a.variable === 'string' ? a.variable : ''))
        .filter(Boolean);
      return names.length > 0 ? truncate(names.join(', ')) : null;
    }
    case 'smart_delay': {
      const seconds =
        typeof cfg.delay_seconds === 'number' ? cfg.delay_seconds : null;
      if (seconds === null) return null;
      return seconds % 60 === 0
        ? `Aguarda ${seconds / 60} min`
        : `Aguarda ${seconds}s`;
    }
    case 'anchor': {
      const label = typeof cfg.label === 'string' ? cfg.label : '';
      return label.length > 0 ? truncate(label) : null;
    }
    case 'go_to': {
      const target =
        typeof cfg.target_node_key === 'string' ? cfg.target_node_key : '';
      return target ? `→ ${truncate(target, 40)}` : null;
    }
    case 'go_to_flow': {
      const flowId = typeof cfg.flow_id === 'string' ? cfg.flow_id : '';
      return flowId ? `Transfere para fluxo ${flowId.slice(0, 8)}…` : null;
    }
    case 'send_template': {
      const name = typeof cfg.template_name === 'string' ? cfg.template_name : '';
      return name.length > 0 ? truncate(name) : null;
    }
    case 'add_note': {
      const text = typeof cfg.note_text === 'string' ? cfg.note_text : '';
      return text.length > 0 ? truncate(text) : null;
    }
    case 'receive_attachment': {
      const varName = typeof cfg.var_name === 'string' ? cfg.var_name : '';
      return varName ? `→ vars.${varName}` : null;
    }
    case 'ai_agent': {
      const mode = typeof cfg.mode === 'string' ? cfg.mode : '';
      const MODE_LABEL: Record<string, string> = {
        once: 'Responde uma vez',
        loop: 'Loop até',
        takeover: 'Assume a conversa',
      };
      const label = MODE_LABEL[mode] ?? 'Agente de IA';
      if (mode === 'loop') {
        const maxTurns =
          typeof cfg.max_turns === 'number' ? cfg.max_turns : 20;
        return `${label} ${maxTurns} turnos`;
      }
      return label;
    }
  }
}
