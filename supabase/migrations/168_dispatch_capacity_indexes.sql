-- ============================================================
-- 168_dispatch_capacity_indexes.sql — índices da fase 1 de capacidade.
--
-- ATENÇÃO — RODAR CADA CREATE INDEX SOZINHO no Supabase SQL Editor (uma
-- instrução por execução, nada antes/depois): CREATE INDEX CONCURRENTLY não
-- roda dentro de BEGIN/COMMIT nem junto com outras instruções no mesmo
-- lote. Por isso este arquivo NÃO tem BEGIN/COMMIT nem NOTIFY (mesmo
-- padrão da 158). CONCURRENTLY não bloqueia escrita (pode rodar com
-- campanha em andamento). IF NOT EXISTS: não faz nada se já existir.
--
-- PRÉ-REQUISITO: migration 167 (wacrm.phone_key) aplicada antes.
--
-- ANTES, no projeto de produção (cyftbffhgjmsfogxawrl), conferir:
--   -- índices da fila (083, 118/133, 126 (contact_id, sent_at), 158):
--   SELECT indexrelid::regclass, indisvalid
--   FROM pg_index WHERE indrelid = 'wacrm.disp_message_queue'::regclass;
--   -- idx_dmq_waha_message_id (158) precisa estar indisvalid = true; se
--   -- false, cada webhook de status faz seq scan: DROP INDEX CONCURRENTLY
--   -- wacrm.idx_dmq_waha_message_id; e rodar a 158 de novo.
--   -- blacklist: precisa haver índice em telefone (o .in("telefone", …)
--   -- da escada de telefones depende dele; nenhuma migration o cria):
--   SELECT indexdef FROM pg_indexes
--   WHERE schemaname = 'wacrm' AND tablename = 'blacklist';
--   Se já houver índice em (telefone) com outro nome, PULE o item 3.
--
-- Depois de cada um, conferir que ficou válido:
--   SELECT indexrelid::regclass, indisvalid FROM pg_index
--   WHERE indexrelid = 'wacrm.<nome>'::regclass;
-- Se indisvalid = false (execução interrompida): DROP INDEX CONCURRENTLY
-- wacrm.<nome>; e rodar o CREATE de novo.
--
-- Pode ser aplicada antes ou depois do deploy (o código não depende dela;
-- sem os índices as funções da 167 só ficam mais lentas).
-- ============================================================

-- 1) Retry de erros transitórios (wacrm.retry_transient_queue_errors, 167):
--    só as linhas retentáveis, em vez de seq scan da fila inteira.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dmq_retryable
  ON wacrm.disp_message_queue (campaign_id)
  WHERE status = 'erro' AND erro_permanente IS NOT TRUE AND tentativas < 5;

-- 2) Blacklist pela chave normalizada (retry e blacklisted_phone_keys, 167).
--    Sem account_id na chave: as consultas aceitam a conta OU blacklist
--    global (account_id nulo) e a revalidação do cron é global.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_blacklist_phone_key
  ON wacrm.blacklist (wacrm.phone_key(telefone));

-- 3) Blacklist por telefone (escada de telefones alternativos e fallback
--    da revalidação por envio). Pular se já existir com outro nome.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_blacklist_telefone
  ON wacrm.blacklist (telefone);

-- 4) Recibos de status: limpeza por idade (cleanup de recibos órfãos).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dispatch_status_receipts_created_at
  ON wacrm.dispatch_status_receipts (created_at);

-- 5) Variáveis do import por campanha / rascunho (startCampaign).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contact_import_variables_campaign
  ON wacrm.contact_import_variables (campaign_id)
  WHERE campaign_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contact_import_variables_draft
  ON wacrm.contact_import_variables (draft_id)
  WHERE draft_id IS NOT NULL;

-- 6) count exact de mensagens do cliente no webhook de entrada
--    (primeira mensagem do contato).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_conversation_sender
  ON wacrm.messages (conversation_id, sender_type);
