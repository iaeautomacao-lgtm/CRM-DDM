import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from './admin-client';
import { sendCampaignCallback } from './processQueue';

/**
 * Entrega os callbacks `campaign.completed` pendentes na outbox
 * (`wacrm.campaign_callback_outbox`, migration 122).
 *
 * A linha da outbox é criada por `complete_dispatch_campaign` na MESMA
 * transação que encerra a campanha, então o callback não se perde se o
 * processo cair entre encerrar e notificar.
 *
 * Fluxo por item:
 * 1. `claim_campaign_callback` pega uma linha pendente (ou com lease
 *    vencido) via FOR UPDATE SKIP LOCKED e grava lease de 120s com o
 *    `owner` desta execução — dois crons simultâneos não pegam a mesma.
 * 2. Envia o callback HTTP.
 * 3. Sucesso → 'delivered'. Falha → volta a 'pending' com backoff
 *    exponencial (30s · 2^tentativas, teto de 1h).
 *
 * O update final filtra por owner + state='sending': se o lease expirou e
 * outro worker assumiu, este não sobrescreve o estado dele.
 *
 * @param limit máximo de callbacks processados nesta chamada (limita o
 *              tempo gasto dentro do tick do cron)
 */
export async function drainCallbackOutbox(limit = 5): Promise<void> {
  const db = supabaseAdmin();
  const owner = randomUUID();
  for (let index = 0; index < limit; index++) {
    const { data, error } = await db.rpc('claim_campaign_callback', { p_owner: owner });
    if (error) throw error;
    const row = data?.[0];
    if (!row) break; // outbox vazia (ou nada vencido ainda)
    const delivered = await sendCampaignCallback(row.campaign_id);
    const { error: updateError } = await db.from('campaign_callback_outbox').update(delivered ? {
      state: 'delivered', delivered_at: new Date().toISOString(), lease_until: null, last_error: null,
    } : {
      state: 'pending', lease_until: null, last_error: 'Callback não confirmado',
      // Backoff exponencial: 30s, 1min, 2min, ... limitado a 1h.
      next_attempt_at: new Date(Date.now() + Math.min(3600_000, 30_000 * 2 ** Math.min(row.attempts, 7))).toISOString(),
    }).eq('campaign_id', row.campaign_id).eq('owner_id', owner).eq('state', 'sending');
    if (updateError) throw updateError;
  }
}
