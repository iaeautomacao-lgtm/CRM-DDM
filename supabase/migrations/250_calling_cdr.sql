-- ============================================================
-- 250_calling_cdr.sql   (PRD 18 — PR-18.1: WhatsApp Calling, registro de chamadas (CDR))
--
-- Só DADOS e ingestão do webhook `calls` da Meta. SEM áudio/WebRTC (gateway = PR-18.2+; TURN decidido depois).
--
--   wacrm.call_detail_records   uma linha por chamada (meta_call_id único): direção, estado, horários e DURAÇÃO em segundos (o limite de
--                               minutos por canal está em aberto — o CDR já registra a duração para somar depois). Colunas de gravação
--                               reservadas para a PR-18.4 (nada grava nelas agora).
--   wacrm.apply_call_event()    aplica um evento do webhook de forma ATÔMICA e monotônica: o estado só avança (ringing → connected →
--                               terminal); evento atrasado/repetido não volta o estado; terminal é congelado; a duração é calculada
--                               no banco (answered_at → ended_at) quando a Meta não a informa.
--   whatsapp_config.calling_recording_enabled   gravação POR CANAL (o admin liga/desliga por número; desligada por padrão). Quando ligada,
--                               o cliente ouve o aviso antes de o áudio conectar (CALL-04) — implementado na PR-18.3/18.4; aqui é só a coluna.
--
-- Acesso: authenticated só LÊ as chamadas da própria conta (is_account_member); toda escrita é do servidor (service_role). A tabela guarda o
-- vínculo conversa/contato e NÃO guarda telefone nem mídia.
--
-- COMPATIBILIDADE: o app detecta a ausência da migration (42P01/PGRST202/42883/42703) e ignora o evento `calls` sem derrubar o webhook.
-- Pode ser aplicada ANTES ou DEPOIS do deploy. Índices só em tabela nova (vazia): sem CONCURRENTLY.
--
-- PRÉ-CHECK:  SELECT to_regclass('wacrm.call_detail_records');   -- NULL
--             SELECT column_name FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='whatsapp_config'
--              AND column_name = 'calling_recording_enabled';      -- 0 linhas
-- ROLLBACK:   DROP FUNCTION IF EXISTS wacrm.apply_call_event(uuid, uuid, uuid, uuid, text, text, text, timestamptz, timestamptz, timestamptz, integer, text);
--             DROP TABLE IF EXISTS wacrm.call_detail_records;
--             ALTER TABLE wacrm.whatsapp_config DROP COLUMN IF EXISTS calling_recording_enabled;
-- Idempotente — pode rodar mais de uma vez.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.accounts') IS NULL OR to_regclass('wacrm.conversations') IS NULL
     OR to_regclass('wacrm.contacts') IS NULL OR to_regclass('wacrm.whatsapp_config') IS NULL THEN
    RAISE EXCEPTION '250: faltam wacrm.accounts/conversations/contacts/whatsapp_config — confira o schema vivo';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'wacrm' AND p.proname = 'is_account_member') THEN
    RAISE EXCEPTION '250: wacrm.is_account_member não existe (migration 017/140)';
  END IF;
END $$;

-- ---- gravação por canal (só a configuração) ---------------------------------------------------------------------------------
ALTER TABLE wacrm.whatsapp_config
  ADD COLUMN IF NOT EXISTS calling_recording_enabled boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN wacrm.whatsapp_config.calling_recording_enabled IS
  'PRD 18: gravar as chamadas deste número (admin liga/desliga). Ligada ⇒ aviso de gravação ao cliente antes do áudio (CALL-04). Sem efeito até a PR-18.4.';

-- ---- CDR ----------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wacrm.call_detail_records (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id                 uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  conversation_id            uuid NOT NULL REFERENCES wacrm.conversations(id) ON DELETE CASCADE,
  contact_id                 uuid NOT NULL REFERENCES wacrm.contacts(id) ON DELETE CASCADE,
  user_id                    uuid,                       -- atendente (preenchido pelas rotas da 18.2+); sem FK: o usuário pode sair
  channel_id                 uuid REFERENCES wacrm.whatsapp_config(id) ON DELETE SET NULL,
  direction                  text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  meta_call_id               text NOT NULL,
  status                     text NOT NULL DEFAULT 'initiated'
                               CHECK (status IN ('initiated', 'ringing', 'connected', 'ended', 'missed', 'rejected', 'failed', 'busy')),
  started_at                 timestamptz NOT NULL DEFAULT now(),
  answered_at                timestamptz,
  ended_at                   timestamptz,
  duration_seconds           integer NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
  hangup_cause               text,
  recording_storage_path     text,                       -- PR-18.4
  recording_duration_seconds integer,
  recording_sha256           text,
  cost_estimated_cents       integer NOT NULL DEFAULT 0,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cdr_meta_call_id ON wacrm.call_detail_records (meta_call_id);
CREATE INDEX IF NOT EXISTS idx_cdr_account_started ON wacrm.call_detail_records (account_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_cdr_conversation ON wacrm.call_detail_records (conversation_id);
CREATE INDEX IF NOT EXISTS idx_cdr_channel_started ON wacrm.call_detail_records (channel_id, started_at DESC) WHERE channel_id IS NOT NULL;

ALTER TABLE wacrm.call_detail_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE wacrm.call_detail_records FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE wacrm.call_detail_records TO authenticated;
GRANT ALL ON TABLE wacrm.call_detail_records TO service_role;

DROP POLICY IF EXISTS cdr_select_member ON wacrm.call_detail_records;
CREATE POLICY cdr_select_member ON wacrm.call_detail_records
  FOR SELECT TO authenticated
  USING (wacrm.is_account_member(account_id));

-- ---- aplicação atômica de um evento do webhook ---------------------------------------------------------------------------------
-- Estados: initiated(0) < ringing(1) < connected(2) < terminal(3: ended | missed | rejected | failed | busy). Só avança; terminal congela.
-- p_conversation_id/p_contact_id nulos = evento só de status: atualiza uma chamada que já existe e NUNCA cria (devolve 'unknown_call').
-- Chamada de OUTRA conta com o mesmo meta_call_id é ignorada ('account_mismatch'). 'ended' de chamada recebida que nunca foi atendida vira 'missed'.
-- Devolve jsonb {result: created|updated|unchanged|unknown_call|account_mismatch, id, status, duration_seconds, became_terminal}.
CREATE OR REPLACE FUNCTION wacrm.apply_call_event(
  p_account_id uuid,
  p_channel_id uuid,
  p_conversation_id uuid,
  p_contact_id uuid,
  p_meta_call_id text,
  p_direction text,
  p_status text,
  p_event_ts timestamptz,
  p_start_ts timestamptz,
  p_end_ts timestamptz,
  p_duration integer,
  p_cause text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_rank constant jsonb := '{"initiated":0,"ringing":1,"connected":2,"ended":3,"missed":3,"rejected":3,"failed":3,"busy":3}';
  v_row wacrm.call_detail_records%ROWTYPE;
  v_created boolean := false;
  v_inserted integer;
  v_new_status text;
  v_new_rank integer;
  v_old_rank integer;
  v_answered timestamptz;
  v_ended timestamptz;
  v_duration integer;
  v_became_terminal boolean := false;
  v_result text;
BEGIN
  IF p_meta_call_id IS NULL OR p_meta_call_id = '' OR p_status IS NULL OR NOT (v_rank ? p_status)
     OR p_direction NOT IN ('inbound', 'outbound') THEN
    RETURN jsonb_build_object('result', 'invalid');
  END IF;

  SELECT * INTO v_row FROM wacrm.call_detail_records WHERE meta_call_id = p_meta_call_id FOR UPDATE;
  IF NOT FOUND THEN
    IF p_conversation_id IS NULL OR p_contact_id IS NULL THEN
      RETURN jsonb_build_object('result', 'unknown_call');
    END IF;
    INSERT INTO wacrm.call_detail_records(account_id, conversation_id, contact_id, channel_id, direction, meta_call_id, status, started_at)
    VALUES (p_account_id, p_conversation_id, p_contact_id, p_channel_id, p_direction, p_meta_call_id, 'initiated',
            COALESCE(p_start_ts, p_event_ts, now()))
    ON CONFLICT (meta_call_id) DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    v_created := v_inserted > 0;
    SELECT * INTO v_row FROM wacrm.call_detail_records WHERE meta_call_id = p_meta_call_id FOR UPDATE;
  END IF;

  IF v_row.account_id <> p_account_id THEN
    RETURN jsonb_build_object('result', 'account_mismatch');
  END IF;

  v_new_status := p_status;
  -- Chamada recebida que terminou sem nunca ter sido atendida = perdida.
  IF v_new_status = 'ended' AND v_row.direction = 'inbound' AND v_row.answered_at IS NULL AND p_duration IS NULL AND p_start_ts IS NULL THEN
    v_new_status := 'missed';
  END IF;

  v_old_rank := (v_rank ->> v_row.status)::integer;
  v_new_rank := (v_rank ->> v_new_status)::integer;

  IF v_old_rank >= 3 OR v_new_rank < v_old_rank THEN
    -- Terminal congela; evento atrasado não volta o estado.
    RETURN jsonb_build_object('result', 'unchanged', 'id', v_row.id, 'status', v_row.status, 'duration_seconds', v_row.duration_seconds, 'became_terminal', false);
  END IF;

  v_answered := v_row.answered_at;
  IF v_new_status = 'connected' OR (v_new_rank = 3 AND p_start_ts IS NOT NULL) THEN
    v_answered := COALESCE(v_answered, p_start_ts, p_event_ts, now());
  END IF;

  v_ended := v_row.ended_at;
  v_duration := v_row.duration_seconds;
  IF v_new_rank = 3 THEN
    v_became_terminal := true;
    v_ended := COALESCE(p_end_ts, p_event_ts, now());
    v_duration := COALESCE(
      p_duration,
      CASE WHEN v_answered IS NOT NULL THEN GREATEST(0, floor(extract(epoch FROM (v_ended - v_answered)))::integer) ELSE 0 END
    );
    IF v_new_status IN ('missed', 'rejected', 'failed', 'busy') AND v_answered IS NULL THEN v_duration := 0; END IF;
  END IF;

  UPDATE wacrm.call_detail_records c
     SET status = v_new_status,
         answered_at = v_answered,
         ended_at = v_ended,
         duration_seconds = v_duration,
         hangup_cause = COALESCE(left(p_cause, 200), c.hangup_cause),
         channel_id = COALESCE(c.channel_id, p_channel_id),
         updated_at = now()
   WHERE c.id = v_row.id
   RETURNING * INTO v_row;

  v_result := CASE WHEN v_created THEN 'created' ELSE 'updated' END;
  RETURN jsonb_build_object('result', v_result, 'id', v_row.id, 'status', v_row.status, 'duration_seconds', v_row.duration_seconds,
                            'became_terminal', v_became_terminal);
END;
$$;

REVOKE ALL ON FUNCTION wacrm.apply_call_event(uuid, uuid, uuid, uuid, text, text, text, timestamptz, timestamptz, timestamptz, integer, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.apply_call_event(uuid, uuid, uuid, uuid, text, text, text, timestamptz, timestamptz, timestamptz, integer, text)
  TO service_role;

-- Registro (migration 202). Tolerante a banco sem a 202.
DO $$
BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('250_calling_cdr') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
