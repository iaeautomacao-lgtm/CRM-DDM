-- ============================================================
-- 191_dispatch_errors_summary.sql
--
-- Resumo por código da tela de Erros (GET /api/disparador/erros): quantos itens em erro por erro_codigo
-- sob os filtros (período / campanha / número / contatos), numa ÚNICA ida ao banco e LIMITADO: lê no máximo
-- 20.001 itens mais recentes (índice da 191b) e devolve `truncated` quando passou disso — nunca varre a
-- fila inteira nem faz count(*) livre.
-- Escopo: só itens de campanhas de p_account_id (join com campaigns.account_id).
--
-- PRÉ-CHECK: SELECT to_regclass('wacrm.disp_message_queue'), to_regclass('wacrm.campaigns');  -- não nulos
--            SELECT column_name FROM information_schema.columns
--             WHERE table_schema='wacrm' AND table_name='disp_message_queue' AND column_name='erro_codigo'; -- 187
-- ORDEM: antes ou depois do deploy (sem a função o app resume uma amostra dos 5.000 itens mais recentes).
-- Depois, rode a 191b (índice CONCURRENTLY, sozinha). Idempotente.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.disp_message_queue') IS NULL OR to_regclass('wacrm.campaigns') IS NULL THEN
    RAISE EXCEPTION '191: faltam disp_message_queue / campaigns';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'wacrm' AND table_name = 'disp_message_queue' AND column_name = 'erro_codigo'
  ) THEN
    RAISE EXCEPTION '191: aplique a 187 (erro_codigo) antes';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION wacrm.dispatch_errors_summary(
  p_account_id uuid,
  p_since timestamptz DEFAULT NULL,
  p_campaign uuid DEFAULT NULL,
  p_session uuid DEFAULT NULL,
  p_contact_ids uuid[] DEFAULT NULL,
  p_cap integer DEFAULT 20000
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cap       integer := LEAST(GREATEST(COALESCE(p_cap, 20000), 1), 100000);
  v_total     integer;
  v_codes     jsonb;
  v_truncated boolean;
BEGIN
  -- Uma única leitura (cap + 1 linhas mais recentes); o +1 só serve para saber se passou do teto.
  WITH sample AS MATERIALIZED (
    SELECT q.erro_codigo, q.updated_at, q.id
    FROM wacrm.disp_message_queue q
    JOIN wacrm.campaigns c ON c.id = q.campaign_id AND c.account_id = p_account_id
    WHERE q.status = 'erro'
      AND (p_campaign    IS NULL OR q.campaign_id = p_campaign)
      AND (p_session     IS NULL OR q.session_id = p_session)
      AND (p_since       IS NULL OR q.updated_at >= p_since)
      AND (p_contact_ids IS NULL OR q.contact_id = ANY (p_contact_ids))
    ORDER BY q.updated_at DESC, q.id DESC
    LIMIT v_cap + 1
  ),
  capped AS (
    SELECT erro_codigo FROM sample ORDER BY updated_at DESC, id DESC LIMIT v_cap
  ),
  grouped AS (
    SELECT erro_codigo, count(*)::integer AS n FROM capped GROUP BY erro_codigo
  )
  SELECT
    COALESCE((SELECT sum(n) FROM grouped), 0)::integer,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('erro_codigo', erro_codigo, 'n', n) ORDER BY n DESC) FROM grouped), '[]'::jsonb),
    (SELECT count(*) FROM sample) > v_cap
  INTO v_total, v_codes, v_truncated;

  RETURN jsonb_build_object('codes', v_codes, 'total', v_total, 'truncated', v_truncated);
END;
$$;

REVOKE ALL ON FUNCTION wacrm.dispatch_errors_summary(uuid, timestamptz, uuid, uuid, uuid[], integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.dispatch_errors_summary(uuid, timestamptz, uuid, uuid, uuid[], integer) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
