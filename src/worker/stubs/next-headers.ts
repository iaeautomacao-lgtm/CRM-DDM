// Substituto de `next/headers` no bundle do worker (só src/lib/audit/context.ts o importa).
// Fora de uma requisição o `headers()` real também lança, e o auditFetch já trata isso: nada é anexado. Mesmo comportamento, sem trazer o Next.
export async function headers(): Promise<never> {
  throw new Error("headers() indisponível fora de uma requisição (worker)");
}
