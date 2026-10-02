import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from './admin-client';
export async function runIdempotentSend(accountId: string, request: Request, work: () => Promise<Response>): Promise<Response> {
  const key = request.headers.get('idempotency-key');
  if (!key || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) return NextResponse.json({ error: 'Informe uma chave Idempotency-Key por intenção de envio' }, { status: 400 });
  const hash = createHash('sha256').update(request.url.split('?')[0]).update(await request.clone().text()).digest('hex');
  const db = supabaseAdmin();
  const { data: reserved, error } = await db.rpc('reserve_send_operation', { p_account: accountId, p_key: key, p_hash: hash });
  if (error) return NextResponse.json({ error: 'Controle de envios indisponível' }, { status: 503 });
  if (!reserved) {
    const { data: existing, error: readError } = await db.from('send_operations').select('*').eq('account_id', accountId).eq('operation_key', key).maybeSingle();
    if (readError || !existing) return NextResponse.json({ error: 'Controle de envios indisponível' }, { status: 503 });
    if (existing.request_hash !== hash) return NextResponse.json({ error: 'Chave de envio já utilizada com outro conteúdo' }, { status: 409 });
    if (existing.state === 'completed') return NextResponse.json(existing.response_body, { status: existing.response_status });
    return NextResponse.json({ error: 'Envio em andamento ou com resultado desconhecido. Não reenvie; aguarde reconciliação.', provider_outcome_unknown: true }, { status: 409 });
  }
  // A crash or thrown transport error keeps the intent reserved. Never expire it
  // into another POST; reconciliation is an explicit operational decision.
  const response = await work();
  const body = await response.clone().json().catch(() => ({}));
  const { error: saveError } = await db.from('send_operations').update({ state: 'completed', response_body: body, response_status: response.status }).eq('account_id', accountId).eq('operation_key', key).eq('state', 'reserved');
  if (saveError) console.error('[Send] Resultado externo requer reconciliação:', saveError.message);
  return response;
}
