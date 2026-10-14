// Mapeamento ÚNICO de `situacao_acordo` (API DDM localiza_dev) → etapa do funil. É a única fonte do que significa cada texto: quem precisar de
// "quitado", "acordo em andamento" ou "sem acordo" chama `classifySituacao` — nada de regex solta pelo código.
//
// Valores REAIS conhecidos (achados no código existente; `acordos[].status` da API de cálculo da DDM, citados em legacy-compose.ts e no prompt do agente):
//     "Quitado"            ⇒ paid       (pago/quitado)
//     "Acordo na DDM"      ⇒ agreement  (acordo formalizado)
//     "Aguardando Pgto"    ⇒ agreement  (acordo formalizado, aguardando pagamento)
// Sem acordo (none): vazio, "Em aberto", "Aberto", "Inadimplente", "Sem acordo", "Nenhum", "Não possui…".
// O campo `situacao_acordo` do localiza_dev é o equivalente por devedor; ainda não há amostra real dele no repositório, então o mapeamento
// também aceita as variações óbvias (acordo vigente/ativo/pendente/formalizado, em andamento, pago, liquidado, sem acordo). Valor DESCONHECIDO
// = `unknown`: não marca nada e é logado UMA vez por valor (reportUnknownSituacao), para a gente completar a tabela com o que a DDM mandar.
//
// Lista de dívidas VAZIA (sem dívida ativa): pela premissa do dono (a mesma da régua) = quitada. Ajuste em EMPTY_LIST_MEANS_PAID.

export type SituacaoStage = "paid" | "agreement" | "none" | "unknown";

/** Lista vazia da DDM = sem dívida ativa = quitada (premissa do dono, a confirmar com a DDM). */
export const EMPTY_LIST_MEANS_PAID = true;

/** Minúsculas, sem acento, espaços colapsados. */
export function normalizeSituacao(raw: unknown): string {
  return String(raw ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const NONE = /^(sem|nenhum|nenhuma)\b|nao (possui|ha|existe|tem)\b|^-+$|^(em )?aberto$|^inadimplente$/;
const NEGATED_PAYMENT = /\bnao\b.*\b(pag|quit)/;
const PAID = /\b(quitad[oa]s?|pag[oa]s?|liquidad[oa]s?)\b/;
const AGREEMENT = /acordo|aguardando (pgto|pag)|em andamento|formaliz/;

/** Classifica UM texto de situação. Vazio/nulo = `none` (sem situação informada). */
export function classifySituacao(raw: unknown): SituacaoStage {
  const text = normalizeSituacao(raw);
  if (!text || NONE.test(text)) return "none";
  if (NEGATED_PAYMENT.test(text)) return AGREEMENT.test(text) ? "agreement" : "unknown";
  if (PAID.test(text)) return "paid";
  if (AGREEMENT.test(text)) return "agreement";
  return "unknown";
}

/**
 * Etapa do CPF a partir das situações das suas dívidas (uma por linha da lista da DDM):
 *   - lista vazia ⇒ paid (EMPTY_LIST_MEANS_PAID) ou none;
 *   - alguma dívida com acordo ⇒ agreement (acordo em andamento vence);
 *   - todas pagas ⇒ paid;
 *   - nenhuma situação informada ⇒ none; qualquer valor que não conhecemos (sem acordo reconhecido) ⇒ unknown.
 */
export function aggregateStage(situacoes: readonly unknown[]): SituacaoStage {
  if (situacoes.length === 0) return EMPTY_LIST_MEANS_PAID ? "paid" : "none";
  const stages = situacoes.map(classifySituacao);
  if (stages.includes("agreement")) return "agreement";
  if (stages.every((s) => s === "paid")) return "paid";
  if (stages.includes("unknown")) return "unknown";
  return "none";
}

const warned = new Set<string>();

/** Loga UMA vez por valor desconhecido (sem CPF, sem dado pessoal: é só o texto da situação). */
export function reportUnknownSituacao(raw: unknown, log: (message: string) => void = console.warn): void {
  const key = normalizeSituacao(raw);
  if (!key || warned.has(key)) return;
  warned.add(key);
  log(`[ddm] situacao_acordo desconhecida (não marca nada; complete o mapeamento em src/lib/billing/ddm-situacao.ts): "${key.slice(0, 60)}"`);
}

/** Só para os testes. */
export function resetUnknownSituacaoLog(): void {
  warned.clear();
}
