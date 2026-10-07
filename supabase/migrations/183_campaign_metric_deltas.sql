-- ============================================================
-- 183_campaign_metric_deltas.sql
--
-- B11 (capacidade do disparador): tira a "linha quente" de campaign_metrics.
--
-- PROBLEMA: wacrm.increment_campaign_metric fazia UPSERT/UPDATE na MESMA linha
-- de campaign_metrics a cada envio, entregue, lido, erro e resposta (~2,5
-- escritas por mensagem). A 80 envios/s por número isso vira centenas de
-- UPDATEs/s na mesma tupla: fila de lock (cada UPDATE espera o anterior) e
-- inchaço (uma tupla morta por incremento).
--
-- SOLUÇÃO (deltas só-insert + consolidação em lote):
--   * wacrm.campaign_metric_deltas (campaign_id, field, n): cada incremento é
--     um INSERT — sem lock de linha compartilhada, sem tupla morta por evento.
--     (Alternativa descartada: shards (campaign_id, field, shard) com UPSERT —
--     reduz a contenção 16x, mas continua fazendo UPDATE em linhas quentes e
--     gera tupla morta por evento; o delta puro tem contenção zero.)
--   * wacrm.increment_campaign_metric(uuid, text): MESMA assinatura, agora só
--     grava o delta. Nenhum chamador (TS ou SQL) muda.
--   * wacrm.consolidate_campaign_metrics(p_limit): soma os deltas em
--     campaign_metrics e apaga os consolidados, em lote (FOR UPDATE SKIP
--     LOCKED: duas consolidações concorrentes pegam lotes disjuntos). Chamada
--     pelo cron de envio com lock próprio ("disparador_metrics"), só com sobra
--     de tempo.
--   * wacrm.campaign_metrics_live (view, security_invoker): campaign_metrics +
--     deltas ainda não consolidados. TODOS os leitores passam a ler a view,
--     então a leitura é sempre exata, mesmo antes da consolidação.
--   * wacrm.recalculate_campaign_metrics: continua recalculando a partir da
--     fila; agora, NO MESMO COMANDO (mesmo snapshot), descarta os deltas
--     pendentes dos 5 campos que recalcula — senão contaria duas vezes.
--     total_respostas não é recalculado (não sai da fila): seus deltas ficam.
--   * wacrm.get_campaign_report_detail (relatório de envio em lote) passa a ler a view live.
--
-- PRÉ-CHECK (rodar antes; cada linha deve dar o esperado):
--   SELECT to_regclass('wacrm.campaign_metrics'), to_regclass('wacrm.campaigns');   -- ambos não nulos
--   SELECT pg_get_function_result('wacrm.increment_campaign_metric(uuid,text)'::regprocedure);  -- void
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema='wacrm' AND table_name='campaign_metrics'
--      AND column_name IN ('total_enviados','total_entregues','total_lidos','total_erros','total_blacklist','total_respostas');  -- 6 linhas
--   SHOW server_version;  -- 15+ (a view usa security_invoker)
--
-- ORDEM: aplicar ANTES do deploy do código (o código novo lê campaign_metrics_live).
--   Aplicar a migration já muda o comportamento do app ANTIGO sem prejuízo: os
--   incrementos viram deltas e a consolidação passa a ser feita... só pelo cron
--   NOVO. Por isso, entre aplicar a migration e fazer o deploy, os números do
--   app antigo ficam defasados (nada se perde: ao subir o cron novo, tudo é
--   consolidado). Faça as duas coisas em sequência rápida, ou rode uma vez
--   `SELECT wacrm.consolidate_campaign_metrics(100000);` depois do deploy.
--
-- Índice: a tabela de deltas é NOVA (vazia), então o CREATE INDEX deste arquivo
-- é instantâneo e não precisa de CONCURRENTLY nem de arquivo próprio.
--
-- Idempotente (IF NOT EXISTS / CREATE OR REPLACE / DROP+CREATE de policy e view).
-- ============================================================

BEGIN;

DO $$
DECLARE
  v_result text;
  v_missing text;
BEGIN
  IF to_regclass('wacrm.campaign_metrics') IS NULL OR to_regclass('wacrm.campaigns') IS NULL THEN
    RAISE EXCEPTION '183: faltam wacrm.campaign_metrics / wacrm.campaigns';
  END IF;

  SELECT string_agg(f, ', ') INTO v_missing
  FROM unnest(ARRAY['total_enviados','total_entregues','total_lidos','total_erros','total_blacklist','total_respostas']) AS f
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'wacrm' AND table_name = 'campaign_metrics' AND column_name = f
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '183: campaign_metrics sem as colunas: %', v_missing;
  END IF;

  IF to_regprocedure('wacrm.increment_campaign_metric(uuid,text)') IS NOT NULL THEN
    SELECT pg_get_function_result('wacrm.increment_campaign_metric(uuid,text)'::regprocedure) INTO v_result;
    IF v_result IS DISTINCT FROM 'void' THEN
      RAISE EXCEPTION '183: increment_campaign_metric devolve %, esperado void — ajuste a migration', v_result;
    END IF;
  END IF;
END $$;

-- ---------- 1. Tabela de deltas (só INSERT; sem FK de propósito: FK = lock KEY SHARE na linha da campanha) ----------
CREATE TABLE IF NOT EXISTS wacrm.campaign_metric_deltas (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  campaign_id uuid        NOT NULL,
  field       text        NOT NULL CHECK (field IN (
                'total_enviados', 'total_entregues', 'total_lidos',
                'total_erros', 'total_blacklist', 'total_respostas')),
  n           integer     NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_campaign_metric_deltas_campaign
  ON wacrm.campaign_metric_deltas (campaign_id, field);

ALTER TABLE wacrm.campaign_metric_deltas ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE wacrm.campaign_metric_deltas FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE wacrm.campaign_metric_deltas TO authenticated;
GRANT ALL ON TABLE wacrm.campaign_metric_deltas TO service_role;
-- O navegador lê a view live com os direitos de quem consulta (security_invoker): precisa enxergar os
-- deltas das campanhas da PRÓPRIA conta, igual à policy de campaign_metrics.
DROP POLICY IF EXISTS campaign_metric_deltas_select ON wacrm.campaign_metric_deltas;
CREATE POLICY campaign_metric_deltas_select ON wacrm.campaign_metric_deltas FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM wacrm.campaigns c
    WHERE c.id = campaign_metric_deltas.campaign_id AND wacrm.is_account_member(c.account_id)
  ));

-- ---------- 2. increment_campaign_metric: mesma assinatura, agora só grava o delta ----------
CREATE OR REPLACE FUNCTION wacrm.increment_campaign_metric(p_campaign_id uuid, p_field text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO wacrm.campaign_metric_deltas (campaign_id, field, n) VALUES (p_campaign_id, p_field, 1);
END;
$$;

-- ---------- 3. Consolidação em lote ----------
CREATE OR REPLACE FUNCTION wacrm.consolidate_campaign_metrics(p_limit integer DEFAULT 5000)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_rows integer;
BEGIN
  WITH batch AS (
    SELECT id FROM wacrm.campaign_metric_deltas
    ORDER BY id
    LIMIT GREATEST(COALESCE(p_limit, 5000), 1)
    FOR UPDATE SKIP LOCKED
  ),
  taken AS (
    DELETE FROM wacrm.campaign_metric_deltas d
    USING batch b
    WHERE d.id = b.id
    RETURNING d.campaign_id, d.field, d.n
  ),
  pivot AS (
    SELECT t.campaign_id,
           COALESCE(SUM(t.n) FILTER (WHERE t.field = 'total_enviados'), 0)::int  AS enviados,
           COALESCE(SUM(t.n) FILTER (WHERE t.field = 'total_entregues'), 0)::int AS entregues,
           COALESCE(SUM(t.n) FILTER (WHERE t.field = 'total_lidos'), 0)::int     AS lidos,
           COALESCE(SUM(t.n) FILTER (WHERE t.field = 'total_erros'), 0)::int     AS erros,
           COALESCE(SUM(t.n) FILTER (WHERE t.field = 'total_blacklist'), 0)::int AS blacklist,
           COALESCE(SUM(t.n) FILTER (WHERE t.field = 'total_respostas'), 0)::int AS respostas
    FROM taken t
    GROUP BY t.campaign_id
  ),
  applied AS (
    INSERT INTO wacrm.campaign_metrics AS m
      (campaign_id, account_id, total_enviados, total_entregues, total_lidos, total_erros, total_blacklist, total_respostas)
    SELECT p.campaign_id, c.account_id, p.enviados, p.entregues, p.lidos, p.erros, p.blacklist, p.respostas
    FROM pivot p
    JOIN wacrm.campaigns c ON c.id = p.campaign_id   -- campanha apagada: os deltas são descartados
    ON CONFLICT (campaign_id) DO UPDATE SET
      total_enviados  = COALESCE(m.total_enviados, 0)  + EXCLUDED.total_enviados,
      total_entregues = COALESCE(m.total_entregues, 0) + EXCLUDED.total_entregues,
      total_lidos     = COALESCE(m.total_lidos, 0)     + EXCLUDED.total_lidos,
      total_erros     = COALESCE(m.total_erros, 0)     + EXCLUDED.total_erros,
      total_blacklist = COALESCE(m.total_blacklist, 0) + EXCLUDED.total_blacklist,
      total_respostas = COALESCE(m.total_respostas, 0) + EXCLUDED.total_respostas,
      updated_at      = now()
    RETURNING 1
  )
  SELECT count(*)::int INTO v_rows FROM taken;
  RETURN COALESCE(v_rows, 0);
END;
$$;

-- ---------- 4. recalculate_campaign_metrics: descarta os deltas dos campos que recalcula (mesmo snapshot) ----------
CREATE OR REPLACE FUNCTION wacrm.recalculate_campaign_metrics(p_campaign_id UUID)
RETURNS VOID AS $$
BEGIN
  WITH dropped AS (
    DELETE FROM wacrm.campaign_metric_deltas
    WHERE campaign_id = p_campaign_id
      AND field IN ('total_enviados', 'total_entregues', 'total_lidos', 'total_erros', 'total_blacklist')
    RETURNING 1
  )
  UPDATE wacrm.campaign_metrics
  SET
    total_enviados   = (SELECT COUNT(*) FROM wacrm.disp_message_queue
                        WHERE campaign_id = p_campaign_id
                          AND status IN ('enviado','entregue','lido')),
    total_entregues  = (SELECT COUNT(*) FROM wacrm.disp_message_queue
                        WHERE campaign_id = p_campaign_id
                          AND status IN ('entregue','lido')),
    total_lidos      = (SELECT COUNT(*) FROM wacrm.disp_message_queue
                        WHERE campaign_id = p_campaign_id
                          AND status = 'lido'),
    total_erros      = (SELECT COUNT(*) FROM wacrm.disp_message_queue
                        WHERE campaign_id = p_campaign_id
                          AND status = 'erro'),
    total_blacklist  = (SELECT COUNT(*) FROM wacrm.disp_message_queue
                        WHERE campaign_id = p_campaign_id
                          AND status = 'bloqueado'),
    updated_at       = NOW()
  WHERE campaign_id = p_campaign_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = wacrm, public, extensions;

-- ---------- 5. View live: campaign_metrics + deltas pendentes (colunas montadas do catálogo) ----------
DO $$
DECLARE
  v_counters text[] := ARRAY['total_enviados','total_entregues','total_lidos','total_erros','total_blacklist','total_respostas'];
  v_cols text;
  v_sums text;
BEGIN
  SELECT string_agg(
           CASE WHEN a.attname = ANY (v_counters)
                THEN format('(COALESCE(m.%1$I, 0) + COALESCE(d.%1$I, 0))::%2$s AS %1$I', a.attname, format_type(a.atttypid, a.atttypmod))
                ELSE format('m.%I', a.attname) END,
           ', ' ORDER BY a.attnum)
    INTO v_cols
  FROM pg_attribute a
  WHERE a.attrelid = 'wacrm.campaign_metrics'::regclass AND a.attnum > 0 AND NOT a.attisdropped;

  SELECT string_agg(format('SUM(x.n) FILTER (WHERE x.field = %L) AS %I', f, f), ', ')
    INTO v_sums FROM unnest(v_counters) AS f;

  EXECUTE 'DROP VIEW IF EXISTS wacrm.campaign_metrics_live';
  EXECUTE format(
    'CREATE VIEW wacrm.campaign_metrics_live WITH (security_invoker = true) AS '
    'SELECT %s FROM wacrm.campaign_metrics m '
    'LEFT JOIN LATERAL (SELECT %s FROM wacrm.campaign_metric_deltas x WHERE x.campaign_id = m.campaign_id) d ON true',
    v_cols, v_sums);
  EXECUTE 'REVOKE ALL ON wacrm.campaign_metrics_live FROM PUBLIC, anon';
  EXECUTE 'GRANT SELECT ON wacrm.campaign_metrics_live TO authenticated, service_role';
END $$;

-- ---------- 5b. Relatório de envio em lote: entregues/lidos pela view live (função DEFINER: a view roda como o dono) ----------
CREATE OR REPLACE FUNCTION wacrm.get_campaign_report_detail(
  p_campaign_id UUID,
  p_account_id  UUID
)
RETURNS TABLE (
  campaign_id       UUID,
  nome              TEXT,
  created_at        TIMESTAMPTZ,
  agendamento       TIMESTAMPTZ,
  created_by_name   TEXT,
  created_by_email  TEXT,
  session_name      TEXT,
  total_contatos    BIGINT,
  total_mensagens   BIGINT,
  total_agendados   BIGINT,
  total_enviando    BIGINT,
  total_enviados    BIGINT,
  total_erros       BIGINT,
  total_cancelados  BIGINT,
  total_entregues   BIGINT, -- always 0 today — see header
  total_lidos       BIGINT  -- always 0 today — see header
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = wacrm, public, extensions
AS $$
  SELECT
    c.id,
    c.nome,
    c.created_at,
    c.agendamento,
    p.full_name,
    u.email,
    wc.waha_session,
    COALESCE(m.total_contatos, 0),
    COALESCE(q.total_mensagens, 0),
    COALESCE(q.agendado, 0),
    COALESCE(q.enviando, 0),
    COALESCE(q.enviado, 0),
    COALESCE(q.erro, 0),
    COALESCE(q.cancelado, 0),
    COALESCE(m.total_entregues, 0),
    COALESCE(m.total_lidos, 0)
  FROM wacrm.campaigns c
  JOIN wacrm.profiles p ON p.user_id = c.created_by
  JOIN auth.users u ON u.id = c.created_by
  LEFT JOIN wacrm.campaign_metrics_live m ON m.campaign_id = c.id
  -- session_ids is a UUID[]; array subscripts are 1-indexed in
  -- Postgres. NULL/empty array yields NULL here, handled by the
  -- LEFT JOIN (session_name comes back NULL, not an error).
  LEFT JOIN wacrm.whatsapp_config wc ON wc.id = c.session_ids[1]
  LEFT JOIN (
    SELECT
      campaign_id,
      COUNT(*)                                    AS total_mensagens,
      COUNT(*) FILTER (WHERE status = 'agendado')  AS agendado,
      COUNT(*) FILTER (WHERE status = 'enviando')  AS enviando,
      COUNT(*) FILTER (WHERE status = 'enviado')   AS enviado,
      COUNT(*) FILTER (WHERE status = 'erro')      AS erro,
      COUNT(*) FILTER (WHERE status = 'cancelado') AS cancelado
    FROM wacrm.disp_message_queue
    WHERE campaign_id = p_campaign_id
    GROUP BY campaign_id
  ) q ON q.campaign_id = c.id
  WHERE c.id = p_campaign_id
    AND p.account_id = p_account_id
    AND is_account_member(p_account_id);
$$;

ALTER FUNCTION wacrm.get_campaign_report_detail(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION wacrm.get_campaign_report_detail(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wacrm.get_campaign_report_detail(UUID, UUID) TO authenticated, service_role;

-- ---------- 6. Permissões das funções internas (só service_role) ----------
REVOKE ALL ON FUNCTION wacrm.increment_campaign_metric(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.increment_campaign_metric(uuid, text) TO service_role;
REVOKE ALL ON FUNCTION wacrm.consolidate_campaign_metrics(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.consolidate_campaign_metrics(integer) TO service_role;
REVOKE ALL ON FUNCTION wacrm.recalculate_campaign_metrics(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.recalculate_campaign_metrics(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
