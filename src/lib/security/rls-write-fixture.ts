// Ajuda dos testes de RLS de ESCRITA (fase 3): para cada usuário, tenta INSERT/UPDATE/DELETE numa tabela e devolve o que a RLS deixou passar.
// Cada tentativa roda dentro de BEGIN…ROLLBACK, então o banco volta ao estado inicial e o retrato "antes" e "depois" é comparável.
import type { PGlite } from "@electric-sql/pglite";

import { U } from "./rls-fixture";

export interface WriteProbe {
  table: string;
  /** INSERT completo, para o usuário tentar (linha da conta A) */
  insert?: string;
  /** UPDATE ... RETURNING 1 que atinge uma linha EXISTENTE da conta A */
  update?: string;
  /** DELETE ... RETURNING 1 que atinge uma linha EXISTENTE da conta A */
  delete?: string;
}

export type WriteSnap = Record<string, "ok" | "negado">;

async function attempt(db: PGlite, who: string, sql: string, expectRows: boolean): Promise<"ok" | "negado"> {
  await db.exec("SET ROLE authenticated");
  await db.exec(`SELECT set_config('test.uid', '${U[who]}', false)`);
  await db.exec("BEGIN");
  try {
    const res = await db.query(sql);
    return !expectRows || res.rows.length > 0 ? "ok" : "negado";
  } catch (e) {
    if (/row-level security|permission denied/i.test(String((e as Error).message))) return "negado";
    throw e;
  } finally {
    await db.exec("ROLLBACK");
    await db.exec("RESET ROLE");
  }
}

/** "tabela.insert|update|delete" → "ok" | "negado" para o usuário `who`. */
export async function writeSnapshot(db: PGlite, who: string, probes: WriteProbe[]): Promise<WriteSnap> {
  const out: WriteSnap = {};
  for (const p of probes) {
    if (p.insert) out[`${p.table}.insert`] = await attempt(db, who, p.insert, false);
    if (p.update) out[`${p.table}.update`] = await attempt(db, who, p.update, true);
    if (p.delete) out[`${p.table}.delete`] = await attempt(db, who, p.delete, true);
  }
  return out;
}
