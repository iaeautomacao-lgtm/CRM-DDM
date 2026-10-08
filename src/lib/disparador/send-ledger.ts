import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from './admin-client';
import { ApiError } from '@/lib/api/v1/respond';

/**
 * Envolve um envio manual/API com controle de idempotência por intenção.
 *
 * Contrato (ver docs/public-api.md e migration 124):
 * - O cliente envia `Idempotency-Key` (8–128 chars) única por intenção de
 *   envio e repete a MESMA chave ao reenviar a mesma requisição.
 * - A chave é reservada em `wacrm.send_operations` (PK conta + chave) ANTES
 *   de qualquer chamada ao provedor. Só quem vence a reserva executa `work`.
 * - Repetição com mesmo conteúdo e operação concluída → devolve a resposta
 *   persistida (sem novo envio). Mesmo chave com conteúdo diferente → 409.
 * - Reserva existente sem conclusão → 409 `provider_outcome_unknown`: o
 *   provedor pode ter aceitado o envio, então não liberamos outro POST.
 *
 * @param accountId conta do usuário/API key — isola as chaves entre contas
 * @param request   requisição original (o corpo é lido via clone)
 * @param work      executa o envio de fato; só roda se a reserva for nova.
 *                  Recebe `ctl.providerCalled()`: chame ANTES de qualquer chamada ao provedor.
 * @param options   `apiEnvelope: true` (API pública v1): erros do ledger viram `ApiError`
 *                  (envelope `{error:{code,message}}`) e, se `work` falhar ANTES de
 *                  chamar o provedor, a reserva é liberada — o integrador corrige e
 *                  reenvia com a mesma chave. Depois da chamada ao provedor a reserva
 *                  continua (resultado incerto, sem novo POST).
 */
export interface SendLedgerControl {
  providerCalled: () => void;
}

export async function runIdempotentSend(
  accountId: string,
  request: Request,
  work: (ctl: SendLedgerControl) => Promise<Response>,
  options: { apiEnvelope?: boolean } = {}
): Promise<Response> {
  const api = options.apiEnvelope === true;
  // Falha do ledger: ApiError (v1) ou o formato antigo da rota do dashboard.
  const fail = (status: number, code: 'bad_request' | 'conflict' | 'unavailable', message: string, extra?: Record<string, unknown>): Response => {
    if (api) throw new ApiError(code, message, status, undefined, undefined, extra);
    return NextResponse.json({ error: message, ...(extra ?? {}) }, { status });
  };
  const key = request.headers.get('idempotency-key');
  if (!key || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) return fail(400, 'bad_request', 'Informe uma chave Idempotency-Key por intenção de envio');
  // Hash de rota (sem query string) + corpo bruto: identifica o conteúdo da
  // intenção para detectar reuso da chave com outra mensagem/destinatário.
  // clone() porque `work` ainda vai ler o corpo da requisição original.
  const hash = createHash('sha256').update(request.url.split('?')[0]).update(await request.clone().text()).digest('hex');
  const db = supabaseAdmin();
  // INSERT ... ON CONFLICT DO NOTHING no banco: true apenas para o primeiro
  // chamador da chave, mesmo com requisições concorrentes.
  const { data: reserved, error } = await db.rpc('reserve_send_operation', { p_account: accountId, p_key: key, p_hash: hash });
  if (error) return fail(503, 'unavailable', 'Controle de envios indisponível');
  if (!reserved) {
    // Chave já usada: decide entre replay da resposta, conflito de conteúdo
    // ou operação ainda sem resultado conhecido.
    const { data: existing, error: readError } = await db.from('send_operations').select('*').eq('account_id', accountId).eq('operation_key', key).maybeSingle();
    if (readError || !existing) return fail(503, 'unavailable', 'Controle de envios indisponível');
    if (existing.request_hash !== hash) return fail(409, 'conflict', 'Chave de envio já utilizada com outro conteúdo');
    if (existing.state === 'completed') return NextResponse.json(existing.response_body, { status: existing.response_status });
    return fail(409, 'conflict', 'Envio em andamento ou com resultado desconhecido. Não reenvie; aguarde reconciliação.', { provider_outcome_unknown: true });
  }
  // Crash do processo ou erro de transporte lançado por `work` mantém a
  // intenção como 'reserved'. Ela nunca expira para liberar outro POST:
  // reconciliar é uma decisão operacional explícita.
  let providerCalled = !api; // rota sem rastreio: nunca libera (comportamento antigo)
  let response: Response;
  try {
    response = await work({ providerCalled: () => { providerCalled = true; } });
  } catch (err) {
    if (!providerCalled) {
      // Nada foi enviado ao provedor: libera a reserva para o reenvio corrigido.
      const { error: releaseError } = await db.from('send_operations').delete().eq('account_id', accountId).eq('operation_key', key).eq('state', 'reserved');
      if (releaseError) console.error('[Send] Falha ao liberar reserva de idempotência:', releaseError.message);
    }
    throw err;
  }
  const body = await response.clone().json().catch(() => ({}));
  // Persiste a resposta (inclusive erros 4xx/5xx retornados por `work`) para
  // que repetições com a mesma chave recebam exatamente o mesmo resultado.
  const { error: saveError } = await db.from('send_operations').update({ state: 'completed', response_body: body, response_status: response.status }).eq('account_id', accountId).eq('operation_key', key).eq('state', 'reserved');
  if (saveError) console.error('[Send] Resultado externo requer reconciliação:', saveError.message);
  return response;
}
