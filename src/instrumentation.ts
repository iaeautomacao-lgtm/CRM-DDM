// Verificação de boot: o gate da bancada de carga (META_API_BASE_URL / OPENAI_BASE_URL só com DISPATCH_LOAD_TEST=1,
// nunca contra o endereço real nem com Supabase de produção). Se falhar, o app NÃO sobe.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { assertLoadTestGate } = await import('./lib/loadtest/gate')
    assertLoadTestGate(process.env)
  }
}
