-- ============================================================
-- 213_messages_transcription.sql   (PRD 13 — transcrição de áudio recebido, STT, com a chave da CONTA)
--
-- O áudio recebido do cliente passa a ser transcrito NA ENTRADA da mensagem (inbound-message.ts), com a chave de IA da conta
-- (ai_config.api_key do provider openai; a conta liga com ai_config.enabled + multimodal_enabled; nunca o .env). O texto fica junto
-- da mensagem para o inbox e para a IA (que deixa de chamar o Whisper de novo):
--   messages.transcription_text    texto bruto transcrito (sem o enfeite do inbox)
--   messages.transcription_status  'done' | 'failed' | 'skipped' (skipped = conta sem chave/consentimento: nada foi enviado a terceiros)
--   messages.transcribed_at        quando a transcrição terminou
-- content_text continua recebendo o texto formatado ("🎙️ _Áudio transcrito:_ "…""), como o inbox já mostrava.
--
-- ADD COLUMN sem DEFAULT, nulo: só catálogo, sem reescrever a tabela (messages é grande e quente). Sem índice.
-- COMPATIBILIDADE: o app só inclui as colunas no INSERT quando há transcrição e, se a migration não estiver aplicada (42703/PGRST204),
-- regrava a mensagem SEM elas — o cliente nunca perde a mensagem. Pode ser aplicada ANTES ou DEPOIS do deploy.
--
-- PRÉ-CHECK:  SELECT column_name FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='messages'
--              AND column_name IN ('transcription_text','transcription_status','transcribed_at');   -- 0 linhas
-- ROLLBACK:   ALTER TABLE wacrm.messages DROP COLUMN IF EXISTS transcription_text, DROP COLUMN IF EXISTS transcription_status,
--                                         DROP COLUMN IF EXISTS transcribed_at;
-- Idempotente — pode rodar mais de uma vez.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.messages') IS NULL THEN
    RAISE EXCEPTION '213: falta wacrm.messages';
  END IF;
END $$;

ALTER TABLE wacrm.messages
  ADD COLUMN IF NOT EXISTS transcription_text   text,
  ADD COLUMN IF NOT EXISTS transcription_status text,
  ADD COLUMN IF NOT EXISTS transcribed_at       timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'messages_transcription_status_check' AND conrelid = 'wacrm.messages'::regclass
  ) THEN
    -- NOT VALID: não varre a tabela (todas as linhas existentes são NULL, que o CHECK aceita).
    ALTER TABLE wacrm.messages
      ADD CONSTRAINT messages_transcription_status_check
      CHECK (transcription_status IS NULL OR transcription_status IN ('done', 'failed', 'skipped')) NOT VALID;
  END IF;
END $$;

COMMENT ON COLUMN wacrm.messages.transcription_text IS 'Texto transcrito do áudio recebido (STT com a chave de IA da conta).';
COMMENT ON COLUMN wacrm.messages.transcription_status IS 'done | failed | skipped (skipped: conta sem chave de IA/multimodal — nada enviado a terceiros).';
COMMENT ON COLUMN wacrm.messages.transcribed_at IS 'Quando a transcrição do áudio terminou.';

-- Registro (migration 202). Tolerante a banco sem a 202.
DO $$
BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('213_messages_transcription') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
