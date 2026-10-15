// Atualização em lote do quadro do Monitoramento.
//
// Cada evento de conversa em tempo real criava um Map novo e refazia filtros e
// agrupamentos da tela inteira. Em horário de pico chegam vários por segundo.
// Aqui os eventos entram numa fila e são aplicados de uma vez a cada intervalo:
// uma renderização por lote, não por evento. O resultado final é o mesmo (vale
// o último evento de cada conversa).

import type { MonitorConversation } from "./queries";

export type ConversationPatch =
  | { kind: "drop" }
  | { kind: "update"; fields: Pick<MonitorConversation, "status" | "assigned_agent_id" | "team_id" | "updated_at"> };

/** Fila de mudanças por conversa: a última de cada id vence. */
export class PatchQueue {
  private pending = new Map<string, ConversationPatch>();

  push(id: string, patch: ConversationPatch): void {
    // Uma vez descartada no lote, uma atualização posterior não a ressuscita (a conversa some do quadro).
    if (this.pending.get(id)?.kind === "drop" && patch.kind === "update") return;
    this.pending.set(id, patch);
  }

  get size(): number {
    return this.pending.size;
  }

  /** Esvazia a fila e devolve o que havia. */
  drain(): Map<string, ConversationPatch> {
    const out = this.pending;
    this.pending = new Map();
    return out;
  }
}

/**
 * Aplica o lote ao quadro. Devolve o MESMO Map quando nada mudou (a tela não renderiza);
 * senão, um Map novo. Atualização de conversa que o quadro não conhece é ignorada.
 */
export function applyPatches(
  board: Map<string, MonitorConversation>,
  patches: Map<string, ConversationPatch>,
): Map<string, MonitorConversation> {
  let next: Map<string, MonitorConversation> | null = null;
  for (const [id, patch] of patches) {
    const current = (next ?? board).get(id);
    if (!current) continue;
    if (!next) next = new Map(board);
    if (patch.kind === "drop") next.delete(id);
    else next.set(id, { ...current, ...patch.fields });
  }
  return next ?? board;
}
