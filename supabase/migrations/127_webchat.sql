-- 127 — Webchat de campanha (Omnichannel F4).
--
-- O cliente recebe no WhatsApp um botão/link para continuar a conversa
-- numa página de chat nossa (/w/<token>). Lógica em src/lib/webchat/.
--
-- conversations.channel_type
--   Canal da conversa. 'whatsapp' para todas as existentes (default);
--   'webchat' para as conversas abertas pela sessão. As buscas de conversa
--   do WhatsApp (webhooks, envio, automações) passam a filtrar por canal,
--   então ESTA MIGRATION PRECISA ESTAR APLICADA ANTES DO DEPLOY do código.
--   Os demais canais (instagram, messenger, sms) entram na F1 ampliando o
--   CHECK.
-- messages.interactive_payload
--   Botões/lista que o fluxo manda no Webchat; a página do cliente
--   desenha os botões e devolve o reply_id escolhido.
-- webchat_sessions
--   Uma linha por convite. O token vai só na URL; aqui fica apenas o
--   sha256 dele. No máximo uma sessão ativa por contato (um link novo
--   revoga o anterior), válida por 24h.
-- campaigns.webchat_*
--   Opção da campanha "ao responder, enviar para o Webchat" e o fluxo que
--   atende lá.
--
-- Somente colunas/tabela/índices novos; nenhum dado existente é alterado
-- além do default 'whatsapp' em conversations.channel_type.

BEGIN;

ALTER TABLE wacrm.conversations
  ADD COLUMN IF NOT EXISTS channel_type text NOT NULL DEFAULT 'whatsapp';
ALTER TABLE wacrm.conversations DROP CONSTRAINT IF EXISTS conversations_channel_type_check;
ALTER TABLE wacrm.conversations ADD CONSTRAINT conversations_channel_type_check
  CHECK (channel_type IN ('whatsapp', 'webchat'));
CREATE INDEX IF NOT EXISTS idx_conversations_contact_channel
  ON wacrm.conversations(account_id, contact_id, channel_type, created_at DESC);

ALTER TABLE wacrm.messages
  ADD COLUMN IF NOT EXISTS interactive_payload jsonb;

ALTER TABLE wacrm.campaigns
  ADD COLUMN IF NOT EXISTS webchat_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS webchat_flow_id uuid REFERENCES wacrm.flows(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS webchat_message text,
  ADD COLUMN IF NOT EXISTS webchat_button_text text
    CHECK (webchat_button_text IS NULL OR char_length(webchat_button_text) <= 20);

-- Trava atômica do convite de campanha: só a primeira resposta a um envio
-- dispara o convite (UPDATE ... WHERE webchat_invited_at IS NULL), mesmo
-- com duas mensagens do cliente chegando juntas ou retry do webhook.
ALTER TABLE wacrm.disp_message_queue
  ADD COLUMN IF NOT EXISTS webchat_invited_at timestamptz;

CREATE TABLE IF NOT EXISTS wacrm.webchat_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES wacrm.contacts(id) ON DELETE CASCADE,
  -- Conversa de WhatsApp de onde o convite saiu (card "Outras conversas").
  source_conversation_id uuid REFERENCES wacrm.conversations(id) ON DELETE SET NULL,
  -- Criada quando o cliente abre o link pela primeira vez.
  webchat_conversation_id uuid REFERENCES wacrm.conversations(id) ON DELETE SET NULL,
  -- Linha (whatsapp_config) de origem: equipe, marca e config do run.
  config_id uuid REFERENCES wacrm.whatsapp_config(id) ON DELETE SET NULL,
  flow_id uuid REFERENCES wacrm.flows(id) ON DELETE SET NULL,
  -- Primeiro nó executado no Webchat (null = entry_node_id do fluxo).
  start_node_key text,
  -- Variáveis iniciais do run no Webchat (vars do run de origem + campanha).
  initial_vars jsonb NOT NULL DEFAULT '{}'::jsonb,
  campaign_id uuid REFERENCES wacrm.campaigns(id) ON DELETE SET NULL,
  queue_item_id uuid,
  -- 'flow_node' (nó Enviar para Webchat) | 'campaign' (opção da campanha)
  origin text NOT NULL CHECK (origin IN ('flow_node', 'campaign')),
  token_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
  expires_at timestamptz NOT NULL,
  opened_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- "Cada link é único para aquele número": um convite novo revoga o anterior.
CREATE UNIQUE INDEX IF NOT EXISTS idx_webchat_one_active_per_contact
  ON wacrm.webchat_sessions(account_id, contact_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_webchat_sessions_conversation
  ON wacrm.webchat_sessions(webchat_conversation_id) WHERE webchat_conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_webchat_sessions_source
  ON wacrm.webchat_sessions(source_conversation_id) WHERE source_conversation_id IS NOT NULL;

-- Leitura para membros da conta (painel do inbox liga WhatsApp ↔ Webchat).
-- Escrita só pelo service_role (API pública do Webchat e engine).
ALTER TABLE wacrm.webchat_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS webchat_sessions_select ON wacrm.webchat_sessions;
CREATE POLICY webchat_sessions_select ON wacrm.webchat_sessions
  FOR SELECT TO authenticated USING (wacrm.is_account_member(account_id));
REVOKE ALL ON wacrm.webchat_sessions FROM PUBLIC, anon;
GRANT SELECT ON wacrm.webchat_sessions TO authenticated;
GRANT ALL ON wacrm.webchat_sessions TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
