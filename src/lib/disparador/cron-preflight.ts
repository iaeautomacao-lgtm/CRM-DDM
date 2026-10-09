import type { SupabaseClient } from "@supabase/supabase-js";

// Preflight de deploy do tick (AUDIT-DISPARADOR D-16): se a coluna campaigns.next_batch_at (migration 118) não existir, o código novo
// subiu sem as migrations e o tick para antes de preparar ou enviar. Antes a checagem custava 1 ida ao banco A CADA tick (1.440/dia, ou
// mais com o tick encadeado). Agora um resultado POSITIVO vale por 10 min no processo: schema não "desaparece" sozinho, e o app é
// reiniciado a cada deploy. Falha nunca é guardada (o próximo tick confere de novo), então o comportamento de proteção é o mesmo.

export const PREFLIGHT_OK_TTL_MS = 10 * 60_000;

let okUntil = 0;

/** Só para testes. */
export function resetPreflightCache(): void {
  okUntil = 0;
}

export async function dispatchSchemaReady(
  db: Pick<SupabaseClient, "from">,
  now: number = Date.now(),
): Promise<{ ok: true; cached: boolean } | { ok: false; error: { message: string } }> {
  if (now < okUntil) return { ok: true, cached: true };
  const { error } = await db.from("campaigns").select("next_batch_at").limit(1);
  if (error) {
    okUntil = 0;
    return { ok: false, error };
  }
  okUntil = now + PREFLIGHT_OK_TTL_MS;
  return { ok: true, cached: false };
}
