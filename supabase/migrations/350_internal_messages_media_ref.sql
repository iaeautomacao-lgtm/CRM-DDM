-- ============================================================
-- 350_internal_messages_media_ref.sql   (plano de segurança 13/10 — Ladrilho, item 2: media_url do chat interno)
--
-- O chat interno (wacrm.internal_messages, 109/110) grava `media_url` direto do navegador, e a RLS de INSERT só confere o remetente e a
-- conta. Qualquer membro podia gravar QUALQUER URL (externa, de rastreamento, javascript:, outra conta) e o destinatário a carregava ao abrir
-- a conversa. Esta migration restringe `media_url` à referência autenticada `/api/chat-media/account-<id da PRÓPRIA conta>/...`, a mesma que
-- o front passa a gerar (upload por URL assinada, /api/media/confirm).
--
--   wacrm.internal_messages_media_ref_guard() — gatilho BEFORE INSERT / UPDATE OF media_url: recusa (SQLSTATE 23514) media_url que não seja
--     `/api/chat-media/account-<account_id da linha>/<caminho>`, com caminho sem `..`, `?`, `#`, `\` nem `%2e`/`%2f`/`%5c`.
--
-- Por que gatilho e não CHECK: um CHECK é reavaliado em QUALQUER UPDATE da linha. Mensagens antigas guardam a URL pública do Storage
-- (anterior à 121); marcar uma delas como lida (UPDATE read_at) falharia. O gatilho só valida na inserção e quando media_url MUDA.
-- Linhas antigas ficam como estão (o front não renderiza mais URL fora da referência autenticada).
--
-- PRÉ-CHECK: SELECT to_regclass('wacrm.internal_messages');   -- não nulo
--             SELECT column_name FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='internal_messages' AND column_name IN ('account_id','media_url');  -- 2 linhas
-- VERIFICAÇÃO: SELECT tgname FROM pg_trigger WHERE tgrelid = 'wacrm.internal_messages'::regclass AND NOT tgisinternal AND tgname = 'internal_messages_media_ref';  -- 1 linha
--              Linhas antigas fora do padrão (informativo, não bloqueia):
--              SELECT count(*) FROM wacrm.internal_messages WHERE media_url IS NOT NULL AND media_url NOT LIKE '/api/chat-media/account-%';
-- ORDEM: pode rodar antes ou depois do deploy do front. O front desta entrega já grava só a referência `/api/chat-media/...`; uma versão
--        ANTIGA do front (que gravava a mesma referência desde a 121) continua passando. Independente das demais migrations do plano.
-- ROLLBACK: DROP TRIGGER IF EXISTS internal_messages_media_ref ON wacrm.internal_messages; DROP FUNCTION IF EXISTS wacrm.internal_messages_media_ref_guard();
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION wacrm.internal_messages_media_ref_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, wacrm
AS $$
DECLARE
  v_prefix text := '/api/chat-media/account-' || NEW.account_id::text || '/';
BEGIN
  IF NEW.media_url IS NULL THEN
    RETURN NEW;
  END IF;
  -- No UPDATE só valida quando media_url muda (linhas antigas seguem editáveis, ex.: read_at).
  IF TG_OP = 'UPDATE' AND NEW.media_url IS NOT DISTINCT FROM OLD.media_url THEN
    RETURN NEW;
  END IF;
  IF left(NEW.media_url, length(v_prefix)) <> v_prefix
     OR length(NEW.media_url) = length(v_prefix)
     OR length(NEW.media_url) > 600
     OR NEW.media_url ~ '[[:cntrl:]]'
     OR NEW.media_url ~* '(\.\.|[?#\\]|%2e|%2f|%5c)' THEN
    RAISE EXCEPTION 'media_url do chat interno deve ser a referência /api/chat-media/ da própria conta'
      USING ERRCODE = '23514', CONSTRAINT = 'internal_messages_media_ref';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS internal_messages_media_ref ON wacrm.internal_messages;
CREATE TRIGGER internal_messages_media_ref
  BEFORE INSERT OR UPDATE OF media_url ON wacrm.internal_messages
  FOR EACH ROW EXECUTE FUNCTION wacrm.internal_messages_media_ref_guard();

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('350_internal_messages_media_ref') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
