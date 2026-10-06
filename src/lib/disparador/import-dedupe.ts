// Funções puras de deduplicação do import de contatos do disparador
// (api/disparador/contacts/import/route.ts). Sem I/O, para serem testáveis.
//
// Motivo: o upsert em lote de wacrm.contact_import_variables (e de
// contact_phones) falha inteiro com "ON CONFLICT DO UPDATE command cannot
// affect row a second time" quando o MESMO lote traz duas linhas com a mesma
// chave de conflito — ex.: o mesmo contato aparecendo duas vezes no CSV.
// Antes, esse erro saía do loop e todos os lotes seguintes eram pulados em
// silêncio, com o import reportando sucesso.

import { processWithConcurrency } from "./concurrency";
import { phoneKey } from "./phone-key";

/**
 * Remove linhas repetidas pela chave. A ÚLTIMA ocorrência vence (mesma
 * semântica de um upsert aplicado em sequência), mantendo a posição da
 * primeira ocorrência para a ordem do resultado ser estável.
 */
export function dedupeByKey<T>(rows: readonly T[], keyOf: (row: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const row of rows) byKey.set(keyOf(row), row);
  return [...byKey.values()];
}

export interface ImportVariableRow {
  contact_id: string;
  var_index: number;
  value: string;
}

/**
 * VAR1/VAR2/VAR3 por contato. A chave de conflito no banco é
 * (contact_id, campaign_id|draft_id, var_index); dentro de um import o
 * campaign_id/draft_id é o mesmo para todas as linhas, então basta
 * (contact_id, var_index).
 */
export function dedupeImportVariables<T extends ImportVariableRow>(rows: readonly T[]): T[] {
  return dedupeByKey(rows, (r) => `${r.contact_id}:${r.var_index}`);
}

export interface AltPhoneAssignmentRow {
  contact_id: string;
  ordem: number;
}

/** contact_phones: conflito em (contact_id, ordem). */
export function dedupeAltPhoneAssignments<T extends AltPhoneAssignmentRow>(rows: readonly T[]): T[] {
  return dedupeByKey(rows, (r) => `${r.contact_id}:${r.ordem}`);
}

/**
 * Chave de "mesmo telefone" do import — a mesma da blacklist
 * (phone-key.ts): com/sem 55 e com/sem o 9º dígito de celular contam como o
 * mesmo número, para a mesma pessoa não ser importada duas vezes.
 */
export function importPhoneKey(phone: string): string {
  return phoneKey(phone);
}

export interface BatchWriteSummary {
  totalBatches: number;
  failedBatches: number;
  failedRows: number;
  /** Mensagem do primeiro lote que falhou (para o resultado/log). */
  firstError: string | null;
}

/**
 * Grava `rows` em lotes de `size`. Um lote com erro NÃO interrompe os
 * seguintes: o erro é contabilizado e o próximo lote é tentado. `write`
 * devolve o erro do lote (ou null) e também pode lançar. Com
 * `concurrency` > 1, até esse número de lotes grava ao mesmo tempo.
 */
export async function writeInBatches<T>(
  rows: readonly T[],
  size: number,
  write: (chunk: T[]) => Promise<{ message: string } | null>,
  concurrency = 1,
): Promise<BatchWriteSummary> {
  const summary: BatchWriteSummary = { totalBatches: 0, failedBatches: 0, failedRows: 0, firstError: null };
  const step = Math.max(1, size);
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += step) chunks.push(rows.slice(i, i + step));
  summary.totalBatches = chunks.length;
  await processWithConcurrency(chunks, Math.max(1, Math.floor(concurrency)), async (chunk) => {
    let error: { message: string } | null;
    try {
      error = await write(chunk);
    } catch (err) {
      error = { message: err instanceof Error ? err.message : String(err) };
    }
    if (error) {
      summary.failedBatches++;
      summary.failedRows += chunk.length;
      summary.firstError ??= error.message;
    }
  });
  return summary;
}
