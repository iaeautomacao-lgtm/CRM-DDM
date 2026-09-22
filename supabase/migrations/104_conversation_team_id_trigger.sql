-- Migration 104: preenche conversations.team_id automaticamente a partir
-- do team_id do canal (whatsapp_config) usado, na criação da conversa.
-- APLICAR MANUALMENTE no Supabase SQL Editor ANTES do deploy.

-- Depende de whatsapp_config.team_id (migration 103) — aplicar 103 antes
-- desta, senão o SELECT dentro da função falha (coluna não existe ainda).
--
-- SECURITY DEFINER é necessário aqui: com a policy de SELECT da 103, um
-- agent pode não ter visibilidade de RLS sobre a linha de whatsapp_config
-- de um canal fora da sua equipe — sem SECURITY DEFINER, o SELECT dentro
-- do trigger rodaria com o papel de quem está inserindo a conversa e
-- poderia voltar NULL mesmo quando o canal tem team_id preenchido.
-- SET search_path explícito (mesmo padrão de set_member_team,
-- 049_teams.sql) — a função só referencia wacrm.whatsapp_config
-- qualificado, mas mantém a convenção de toda função SECURITY DEFINER
-- deste projeto.
CREATE OR REPLACE FUNCTION wacrm.set_conversation_team_id()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wacrm, public, extensions
AS $$
BEGIN
  IF NEW.team_id IS NULL AND NEW.config_id IS NOT NULL THEN
    SELECT team_id INTO NEW.team_id
    FROM wacrm.whatsapp_config
    WHERE id = NEW.config_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_conversation_team_id ON wacrm.conversations;
CREATE TRIGGER trg_set_conversation_team_id
  BEFORE INSERT ON wacrm.conversations
  FOR EACH ROW EXECUTE FUNCTION wacrm.set_conversation_team_id();
