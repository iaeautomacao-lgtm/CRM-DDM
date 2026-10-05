-- Migration 133: configuração do Webchat por conta (tela /canais → Webchat).
-- APLICAR MANUALMENTE no Supabase SQL Editor ANTES do deploy (depois da 132).
-- Conferir o schema live antes (CLAUDE.md).
--
-- Até aqui o Webchat não tinha onde ser configurado: a página do cliente
-- usava o nome da conta, o link valia 24h fixas e o convite da campanha só
-- tinha texto padrão no código. Sem linha nesta tabela, valem os padrões
-- de src/lib/webchat/settings.ts (mesmo comportamento de antes).

BEGIN;

CREATE TABLE IF NOT EXISTS wacrm.webchat_settings (
  account_id uuid PRIMARY KEY REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  -- Nome no topo da página do cliente (vazio = nome da conta).
  display_name text CHECK (display_name IS NULL OR char_length(display_name) <= 60),
  -- Boas-vindas; "{nome}" vira o primeiro nome do contato.
  welcome_message text CHECK (welcome_message IS NULL OR char_length(welcome_message) <= 300),
  accent_color text CHECK (accent_color IS NULL OR accent_color ~ '^#[0-9a-fA-F]{6}$'),
  -- Validade do link enviado ao cliente.
  session_hours smallint NOT NULL DEFAULT 24 CHECK (session_hours BETWEEN 1 AND 72),
  -- Padrões do convite quando a campanha não define os seus.
  default_invite_message text CHECK (default_invite_message IS NULL OR char_length(default_invite_message) <= 1000),
  default_button_text text CHECK (default_button_text IS NULL OR char_length(default_button_text) <= 20),
  -- Fluxo usado pelo convite de campanha quando a campanha não escolhe um.
  default_flow_id uuid REFERENCES wacrm.flows(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Leitura e escrita só pelo servidor (rotas /api/webchat/settings e a
-- página pública do cliente, que não tem sessão).
ALTER TABLE wacrm.webchat_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.webchat_settings FROM PUBLIC, anon, authenticated;
GRANT ALL ON wacrm.webchat_settings TO service_role;

COMMIT;
