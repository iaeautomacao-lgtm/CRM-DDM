import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllKeyset } from "./keyset";

// Número inválido conhecido (decisão do dono 13/10, item 4; migration 335). O telefone PRINCIPAL que a Meta recusou como inválido fica
// marcado no contato (phone_invalid_at + phone_invalid_normalized). O startCampaign pula o contato enquanto a marca valer, e conta.
// Opt-out e blacklist NÃO passam por aqui (outra tabela, outra regra).

export interface MarkedContact {
  id: string;
  phone_normalized: string | null;
  phone_invalid_normalized: string | null;
}

/**
 * A marca vale SÓ enquanto o telefone do contato continuar o mesmo que foi recusado. Mudou o telefone (ou o normalizado ficou vazio):
 * a marca deixa de valer sozinha, sem limpeza.
 */
export function isKnownInvalid(row: Pick<MarkedContact, "phone_normalized" | "phone_invalid_normalized">): boolean {
  return !!row.phone_invalid_normalized && !!row.phone_normalized && row.phone_invalid_normalized === row.phone_normalized;
}

const missingColumn = (error: { code?: string; message?: string }) =>
  error.code === "42703" || error.code === "PGRST204" || /phone_invalid/i.test(error.message ?? "");

type Db = Pick<SupabaseClient, "from">;

/**
 * Ids (entre os do público) que o startCampaign deve PULAR: marca válida e SEM telefone alternativo utilizável (contact_phones com
 * ordem > 1 e status diferente de 'invalido'; com alternativo o contato segue e a escada de telefones faz o resto).
 * Nunca lança: migration 335 ausente ou qualquer falha de leitura = ninguém é pulado (comportamento de antes).
 */
export async function loadKnownInvalidContactIds(db: Db, accountId: string, audienceIds: ReadonlySet<string>): Promise<{ skip: Set<string>; marked: number }> {
  const skip = new Set<string>();
  try {
    const marked = await fetchAllKeyset<MarkedContact>("Erro ao ler números inválidos conhecidos", (after, limit) => {
      let q = db
        .from("contacts")
        .select("id, phone_normalized, phone_invalid_normalized")
        .eq("account_id", accountId)
        .not("phone_invalid_at", "is", null)
        .order("id", { ascending: true })
        .limit(limit);
      if (after != null) q = q.gt("id", after as string);
      return q as never;
    });
    const candidates = marked.filter((row) => audienceIds.has(row.id) && isKnownInvalid(row)).map((row) => row.id);
    const withAlternate = new Set<string>();
    for (let i = 0; i < candidates.length; i += 200) {
      const chunk = candidates.slice(i, i + 200);
      const { data, error } = await db.from("contact_phones").select("contact_id, status").in("contact_id", chunk).gt("ordem", 1);
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as Array<{ contact_id: string; status: string | null }>) {
        if (r.status !== "invalido") withAlternate.add(r.contact_id);
      }
    }
    for (const id of candidates) if (!withAlternate.has(id)) skip.add(id);
    return { skip, marked: candidates.length };
  } catch (error) {
    const err = error as { code?: string; message?: string };
    if (!missingColumn(err)) console.error("[Disparador] números inválidos conhecidos indisponíveis; ninguém é pulado:", err.message ?? error);
    return { skip: new Set(), marked: 0 };
  }
}
