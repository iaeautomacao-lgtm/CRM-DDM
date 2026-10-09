// PRD 17, PR 17.2 — fonte plugável do status de uma dívida (DebtSource).
//
// Decisão do dono (09/10): fonte B = a carteira entra por importação COM o vencimento e, ANTES de cada cobrança, o sistema consulta o CPF
// na API da DDM para não cobrar quem já pagou ou fez acordo. Cobmais entra depois como OUTRA implementação desta interface, sem refazer o
// motor. Regra de ouro: na dúvida NÃO se cobra — `unknown` (API fora do ar, resposta estranha) adia a etapa; nunca "envia por precaução".

export type DebtState = "open" | "paid" | "agreement" | "cancelled" | "unknown";

/** Motivos de parada que a régua entende (subconjunto do enum de billing_enrollments.stop_reason). */
export type DebtStopReason = "paid" | "agreement" | "cancelled";

export interface DebtStatus {
  state: DebtState;
  /** Dado que a fonte confirmou, quando houver (não obrigatório). */
  amountCents?: number | null;
  /** Sinais crus que a fonte devolveu e que o motor pode usar depois (sem PII). */
  flags?: Record<string, boolean>;
}

export interface DebtLookup {
  /** CPF só dígitos. Nunca é logado nem persistido pela régua. */
  cpf: string;
  /** Referência externa da dívida (ex.: "<iddev>:<sistema>"), quando conhecida. */
  externalRef?: string | null;
}

export interface DebtSource {
  /** Nome estável gravado em billing_debts.source. */
  readonly name: string;
  getStatus(lookup: DebtLookup): Promise<DebtStatus>;
}

/** Falha da fonte (rede, 5xx, limite). Mensagem curta, SEM URL, token ou CPF. */
export class DebtSourceError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = true) {
    super(message);
    this.name = "DebtSourceError";
    this.retryable = retryable;
  }
}

export function stopReasonFor(state: DebtState): DebtStopReason | null {
  switch (state) {
    case "paid":
      return "paid";
    case "agreement":
      return "agreement";
    case "cancelled":
      return "cancelled";
    default:
      return null;
  }
}

/** "1.234,56" / "1234.56" / 1234.56 → centavos (inteiro); null se não for um valor monetário. */
export function parseMoneyToCents(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : null;
  if (typeof value !== "string") return null;
  const text = value.replace(/[^\d.,-]/g, "");
  if (!text || text === "-") return null;
  const normalized = text.includes(",") ? text.replace(/\./g, "").replace(",", ".") : text;
  const n = Number(normalized);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

/** Só dígitos; exige 11 (CPF) ou 14 (CNPJ). */
export function normalizeDocument(raw: unknown): string | null {
  const digits = String(raw ?? "").replace(/\D/g, "");
  return digits.length === 11 || digits.length === 14 ? digits : null;
}
