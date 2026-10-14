// Sanitização do histórico do chat do Acordito (o `sanitize_history` do pacote de 14/10). O histórico que vem do cliente (ou do armazenamento)
// nunca vai cru ao modelo: só `user`/`assistant`, só texto, os últimos N turnos, com teto de caracteres, começando por `user` e sem papéis repetidos.

export interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
}

export interface HistoryLimits {
  /** Caracteres por mensagem. */
  maxMessageChars: number;
  /** Trocas (pergunta + resposta) enviadas ao modelo. */
  maxHistoryTurns: number;
  /** Caracteres no total (prioriza o mais recente). */
  maxHistoryChars: number;
}

export const ACORDITO_HISTORY_LIMITS: HistoryLimits = { maxMessageChars: 2000, maxHistoryTurns: 10, maxHistoryChars: 8000 };

export function sanitizeHistory(history: unknown, limits: Partial<HistoryLimits> = {}): HistoryTurn[] {
  const cfg = { ...ACORDITO_HISTORY_LIMITS, ...limits };
  let msgs: HistoryTurn[] = [];
  if (Array.isArray(history)) {
    for (const m of history) {
      if (!m || typeof m !== "object" || Array.isArray(m)) continue;
      const { role, content } = m as { role?: unknown; content?: unknown };
      if ((role === "user" || role === "assistant") && typeof content === "string" && content.trim()) {
        msgs.push({ role, content: content.trim().slice(0, cfg.maxMessageChars) });
      }
    }
  }

  msgs = msgs.slice(-cfg.maxHistoryTurns * 2);

  // Prioriza o mais recente dentro do teto de caracteres.
  let total = 0;
  const keep: HistoryTurn[] = [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    total += msgs[i].content.length;
    if (total > cfg.maxHistoryChars) break;
    keep.push(msgs[i]);
  }
  msgs = keep.reverse();

  // Alguns provedores exigem começar por `user`.
  while (msgs.length > 0 && msgs[0].role !== "user") msgs.shift();

  // Remove turnos repetidos do mesmo papel (fica o mais recente).
  const fixed: HistoryTurn[] = [];
  for (const m of msgs) {
    if (fixed.length > 0 && fixed[fixed.length - 1].role === m.role) fixed[fixed.length - 1] = m;
    else fixed.push(m);
  }
  return fixed;
}
