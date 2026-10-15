// Constantes PURAS da leitura de campanhas da API pública (sem import de servidor): usadas pelo OpenAPI (que a página de documentação
// carrega no navegador) e por campaign-api.ts. Qualquer coisa que dependa de banco/servidor fica em campaign-api.ts.

export const CAMPAIGN_STATUSES = ['rascunho', 'agendado', 'preparando', 'em_execucao', 'pausada', 'encerrada'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];
export const CAMPAIGN_SOURCES = ['api_v1', 'dashboard'] as const;

export const CAMPAIGN_LIST_DEFAULT = 50;
export const CAMPAIGN_LIST_MAX = 200;
export const RECIPIENTS_DEFAULT = 100;
export const RECIPIENTS_MAX = 500;

export const RECIPIENT_STATUSES = ['queued', 'paused', 'sending', 'sent', 'delivered', 'read', 'error', 'blocked', 'cancelled', 'removed'] as const;
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];

// Remoção de destinatários (POST …/recipients/remove).
export const REMOVE_MAX_RECIPIENTS = 500;
export const REMOVE_REASONS = ['paid', 'agreement', 'other'] as const;
export type RemoveReason = (typeof REMOVE_REASONS)[number];
export const REMOVE_ENTRY_STATUSES = ['removed', 'already_removed', 'in_flight', 'already_sent', 'not_found', 'invalid'] as const;
export type RemoveEntryStatus = (typeof REMOVE_ENTRY_STATUSES)[number];
