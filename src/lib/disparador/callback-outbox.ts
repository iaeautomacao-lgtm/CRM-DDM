import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from './admin-client';
import { sendCampaignCallback } from './processQueue';
export async function drainCallbackOutbox(limit = 5): Promise<void> {
  const db = supabaseAdmin();
  const owner = randomUUID();
  for (let index = 0; index < limit; index++) {
    const { data, error } = await db.rpc('claim_campaign_callback', { p_owner: owner });
    if (error) throw error;
    const row = data?.[0];
    if (!row) break;
    const delivered = await sendCampaignCallback(row.campaign_id);
    const { error: updateError } = await db.from('campaign_callback_outbox').update(delivered ? {
      state: 'delivered', delivered_at: new Date().toISOString(), lease_until: null, last_error: null,
    } : {
      state: 'pending', lease_until: null, last_error: 'Callback não confirmado',
      next_attempt_at: new Date(Date.now() + Math.min(3600_000, 30_000 * 2 ** Math.min(row.attempts, 7))).toISOString(),
    }).eq('campaign_id', row.campaign_id).eq('owner_id', owner).eq('state', 'sending');
    if (updateError) throw updateError;
  }
}
