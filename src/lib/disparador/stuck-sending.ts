// Itens parados em 'enviando' — só visibilidade no monitor, sem reenvio.
//
// Um item fica 'enviando' entre o claim (claim_dispatch_item grava
// updated_at) e a confirmação do provedor. Se o resultado externo é
// desconhecido (timeout, 5xx, queda do processo), ele PERMANECE 'enviando'
// de propósito: reenviar às cegas pode duplicar a mensagem. Enquanto isso,
// ele ocupa uma das vagas de envio simultâneo do canal (max_in_flight) —
// vários parados travam o canal inteiro.

/** Minutos em 'enviando' a partir dos quais o monitor avisa. */
export const STUCK_SENDING_MINUTES = 3;

export function stuckSendingCutoff(now: number = Date.now()): string {
  return new Date(now - STUCK_SENDING_MINUTES * 60_000).toISOString();
}

export interface StuckSendingRow {
  campaign_id: string;
  campaigns?: { nome?: string | null } | null;
}

export interface StuckSendingSummary {
  campaignId: string;
  campaignName: string;
  count: number;
}

/** Agrupa por campanha, maior quantidade primeiro. */
export function summarizeStuckSending(rows: readonly StuckSendingRow[]): StuckSendingSummary[] {
  const byCampaign = new Map<string, StuckSendingSummary>();
  for (const row of rows) {
    const current = byCampaign.get(row.campaign_id) ?? {
      campaignId: row.campaign_id,
      campaignName: row.campaigns?.nome ?? "Campanha sem nome",
      count: 0,
    };
    current.count++;
    byCampaign.set(row.campaign_id, current);
  }
  return [...byCampaign.values()].sort((a, b) => b.count - a.count);
}
