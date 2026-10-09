// Cadência esperada de cada cron (docs/crons.md). Dados puros, sem dependência de servidor: usados pelo registro do batimento
// (cron-heartbeat.ts) e pelo cartão de saúde (system-health.ts). `every` = segundos entre execuções do agendador externo.
export const CRON_JOBS = {
  disparador_tick: { every: 60, label: "Disparador (tick de envio)" },
  disparador_prepare: { every: 60, label: "Preparo de campanhas agendadas" },
  disparador_health: { every: 600, label: "Saúde dos números Meta" },
  disparador_exports: { every: 60, label: "Exportações do Disparador" },
  disparador_imports: { every: 60, label: "Importações de contatos" },
  automations: { every: 60, label: "Automações" },
  flows: { every: 300, label: "Flows (runs abandonados, atrasos)" },
  webhooks_out: { every: 60, label: "Webhooks de saída" },
  billing: { every: 60, label: "Régua de cobrança" },
  channels_refresh_tokens: { every: 86_400, label: "Renovação de tokens dos canais" },
  conversations_retry_assignment: { every: 300, label: "Redistribuição de conversas" },
} as const;

export type CronJob = keyof typeof CRON_JOBS;
