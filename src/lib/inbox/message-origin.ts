// Origem da mensagem (item 21 fase 2 do PRD 23, migration 302 do Cinzel):
// messages.origin ∈ customer | operator | ai | flow | campaign | automation |
// api | NULL. NULL = bot/eco sem origem (histórico antigo, sem backfill) →
// tratado como "Automação" genérica.

export type MessageOrigin =
  | "customer"
  | "operator"
  | "ai"
  | "flow"
  | "campaign"
  | "automation"
  | "api";

export interface OriginAuthor {
  label: string;
  className: string;
  /** Mostra o ícone de robô (envio que não foi de uma pessoa). */
  bot: boolean;
}

// Cores fixas por origem, legíveis no claro e no escuro e distintas da
// paleta dos atendentes (sky/violet/emerald/rose/teal/amber).
const AUTOMATED: Record<Exclude<MessageOrigin, "customer" | "operator">, OriginAuthor> = {
  ai: { label: "IA", className: "text-fuchsia-700 dark:text-fuchsia-400", bot: true },
  flow: { label: "Fluxo", className: "text-indigo-700 dark:text-indigo-400", bot: true },
  campaign: { label: "Disparo", className: "text-orange-700 dark:text-orange-400", bot: true },
  automation: { label: "Automação", className: "text-muted-foreground", bot: true },
  api: { label: "API", className: "text-slate-600 dark:text-slate-300", bot: true },
};

export const GENERIC_AUTOMATION: OriginAuthor = AUTOMATED.automation;

/**
 * Rótulo de uma mensagem automática pela origem. Devolve null quando quem
 * define o rótulo é a pessoa (cliente ou operador): aí vale o nome/cor do
 * atendente. Mensagem de bot sem origem (NULL) vira "Automação".
 */
export function automatedAuthor(
  origin: string | null | undefined,
  senderType: string,
): OriginAuthor | null {
  if (origin && Object.hasOwn(AUTOMATED, origin)) return AUTOMATED[origin as keyof typeof AUTOMATED];
  if (origin === "customer" || origin === "operator") return null;
  // Origem desconhecida ou NULL: bot vira "Automação"; o resto segue a pessoa.
  return senderType === "bot" ? GENERIC_AUTOMATION : null;
}
