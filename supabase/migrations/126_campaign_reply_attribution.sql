-- 126 — Origem de campanha na resposta do cliente (Omnichannel F0).
--
-- Quando o cliente responde a um disparo, o inbox passa a mostrar a
-- mensagem da campanha na conversa (template, texto enviado, campanha) e a
-- resposta fica ligada a ela. Lógica em src/lib/disparador/reply-tracker.ts.
--
-- messages.campaign_id / queue_item_id
--   Na mensagem do disparo (inserida na conversa só quando o cliente
--   responde; no WAHA, o eco fromMe já existente é marcado) e na resposta.
-- messages.attribution_method
--   Só na resposta: 'context' = o cliente citou a mensagem da campanha
--   (Meta context.id / WAHA replyTo.id); 'recent' = disparo mais recente
--   para o contato nos últimos 7 dias (critério antigo de trackCampaignReply).
-- conversations.origin_campaign_id / origin_queue_item_id
--   Primeira campanha que trouxe a conversa; base do filtro "Campanha".
-- disp_message_queue.replied_at
--   Primeira resposta por envio: total_respostas passa a contar uma vez
--   por mensagem enviada, não uma vez por mensagem recebida.
--
-- Antes de aplicar: conferir no SQL Editor que disp_message_queue.id é uuid
-- (a tabela foi criada direto em produção, sem CREATE nas migrations):
--   SELECT data_type FROM information_schema.columns
--   WHERE table_schema = 'wacrm' AND table_name = 'disp_message_queue' AND column_name = 'id';
-- Somente colunas e índices novos; nenhum dado existente é alterado.

BEGIN;

ALTER TABLE wacrm.messages
  ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES wacrm.campaigns(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS queue_item_id uuid,
  ADD COLUMN IF NOT EXISTS attribution_method text
    CHECK (attribution_method IS NULL OR attribution_method IN ('context', 'recent'));

ALTER TABLE wacrm.conversations
  ADD COLUMN IF NOT EXISTS origin_campaign_id uuid REFERENCES wacrm.campaigns(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS origin_queue_item_id uuid;

ALTER TABLE wacrm.disp_message_queue
  ADD COLUMN IF NOT EXISTS replied_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_messages_campaign
  ON wacrm.messages(campaign_id) WHERE campaign_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_origin_campaign
  ON wacrm.conversations(account_id, origin_campaign_id) WHERE origin_campaign_id IS NOT NULL;
-- Busca dos disparos recentes de um contato ao receber uma resposta.
CREATE INDEX IF NOT EXISTS idx_dispatch_contact_sent_at
  ON wacrm.disp_message_queue(contact_id, sent_at DESC) WHERE sent_at IS NOT NULL;

NOTIFY pgrst, 'reload schema';
COMMIT;
