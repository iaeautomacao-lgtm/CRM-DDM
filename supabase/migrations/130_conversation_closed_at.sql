-- Migration 130: conversations.closed_at — quando a conversa foi finalizada.
-- APLICAR MANUALMENTE no Supabase SQL Editor ANTES do deploy (depois da 128).
--
-- Até aqui não havia data de finalização (ver 051: updated_at fazia esse
-- papel, mas muda a cada mensagem). A aba "Hoje" do Monitoramento
-- (/api/monitoramento/dia) conta as finalizadas no dia por closed_at.
-- Reabrir a conversa limpa o campo; fechar de novo grava a nova data.
-- Conferir o schema live antes (CLAUDE.md).

BEGIN;

ALTER TABLE wacrm.conversations
  ADD COLUMN IF NOT EXISTS closed_at timestamptz;

-- Backfill: para as já fechadas, updated_at é a melhor aproximação.
-- Triggers de UPDATE desligadas só durante o backfill: set_updated_at
-- (001) trocaria updated_at de TODAS as fechadas pela hora da migration —
-- o dashboard conta "finalizadas hoje" por updated_at — e a auditoria
-- (050) gravaria um evento por linha. Religadas logo abaixo, na mesma
-- transação.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['set_updated_at', 'trg_audit_conversations'] LOOP
    IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'wacrm.conversations'::regclass AND tgname = t) THEN
      EXECUTE format('ALTER TABLE wacrm.conversations DISABLE TRIGGER %I', t);
    END IF;
  END LOOP;
END;
$$;

UPDATE wacrm.conversations
  SET closed_at = updated_at
  WHERE status = 'closed' AND closed_at IS NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['set_updated_at', 'trg_audit_conversations'] LOOP
    IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'wacrm.conversations'::regclass AND tgname = t) THEN
      EXECUTE format('ALTER TABLE wacrm.conversations ENABLE TRIGGER %I', t);
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION wacrm.set_conversation_closed_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = wacrm, public AS $$
BEGIN
  IF NEW.status = 'closed' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'closed') THEN
    NEW.closed_at := clock_timestamp();
  ELSIF NEW.status <> 'closed' THEN
    NEW.closed_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_conversation_closed_at ON wacrm.conversations;
CREATE TRIGGER trg_set_conversation_closed_at
  BEFORE INSERT OR UPDATE OF status ON wacrm.conversations
  FOR EACH ROW EXECUTE FUNCTION wacrm.set_conversation_closed_at();

CREATE INDEX IF NOT EXISTS idx_conversations_account_closed_at
  ON wacrm.conversations (account_id, closed_at)
  WHERE closed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_account_first_response
  ON wacrm.conversations (account_id, first_response_at)
  WHERE first_response_at IS NOT NULL;

COMMIT;
