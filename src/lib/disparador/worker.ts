// Worker em memória DESATIVADO: o processamento da fila é do cron (/api/disparador/cron). O Phusion Passenger não mantém `setInterval`
// entre requisições, então o antigo loop aqui nunca era garantido em produção, e, se alguém o reativasse, competiria com o cron pelos
// mesmos itens de disp_message_queue (risco já visto em 23/07/2026). O corpo antigo (inalcançável) foi removido na auditoria do
// Disparador; o histórico está no git. A função fica como no-op só porque a rota de início ainda a chama.

export function ensureQueueWorkerRunning(): void {
  // Intencionalmente vazio.
}
