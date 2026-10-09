// Validação no formulário da Régua (navegador), espelhando as regras que o servidor já aplica em
// src/lib/billing/ruler-api.ts (não importar aquele módulo aqui: é de servidor). O servidor continua sendo a
// fonte da verdade; isto só evita ir ao servidor com dado que ele vai recusar e dá o erro junto do campo.

export const OFFSET_MIN = -60;
export const OFFSET_MAX = 365;

/** Janela de envio ("HH:MM"): as duas pontas são obrigatórias e o fim vem depois do início. */
export function windowError(start: string, end: string): string | null {
  if (!start || !end) return "Informe o início e o fim da janela.";
  if (end <= start) return "O fim da janela deve ser depois do início.";
  return null;
}

/** Deslocamento em dias: vazio NÃO vale zero (Number('') é 0). Inteiro entre -60 e 365. */
export function offsetError(raw: string): string | null {
  const text = raw.trim();
  if (text === "") return "Informe os dias.";
  const n = Number(text);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return "Use um número inteiro de dias.";
  if (n < OFFSET_MIN || n > OFFSET_MAX) return `Os dias vão de ${OFFSET_MIN} a ${OFFSET_MAX}.`;
  return null;
}

export interface StepDraftLike {
  key: string;
  kind: "offset" | "status";
  offset: string;
  status_trigger: string;
}

export interface StepFieldErrors {
  offset?: string;
  status_trigger?: string;
}

/** Erros por etapa (chave do rascunho): dias inválidos, dia repetido (cada dia só pode ter uma etapa) e gatilho vazio. */
export function validateStepDrafts(drafts: readonly StepDraftLike[]): Map<string, StepFieldErrors> {
  const errors = new Map<string, StepFieldErrors>();
  const seen = new Map<number, string>();
  for (const d of drafts) {
    const e: StepFieldErrors = {};
    if (d.kind === "offset") {
      const own = offsetError(d.offset);
      if (own) e.offset = own;
      else {
        const n = Number(d.offset);
        const first = seen.get(n);
        if (first !== undefined) e.offset = "Já existe uma etapa neste dia.";
        else seen.set(n, d.key);
      }
    } else if (!d.status_trigger.trim()) {
      e.status_trigger = "Informe o status que dispara a etapa.";
    }
    if (e.offset || e.status_trigger) errors.set(d.key, e);
  }
  return errors;
}
