-- ============================================================
-- 293_dashboard_aggregates.sql   (BUG do Dashboard — totais cortados em 1000 linhas em contas grandes)
--
-- PROBLEMA: src/lib/dashboard/queries.ts (loadConversationsSeries, loadResponseTime, loadAiAnalytics e o donut de status) baixava as linhas
-- de messages/conversations/deals SEM .range() e somava no navegador. O PostgREST devolve no máximo 1000 linhas por consulta: numa conta com
-- mais mensagens que isso a série, o tempo de resposta, a razão bot × humano e os totais saíam CORTADOS (sem erro, números errados).
--
-- CORREÇÃO: a soma passa para o banco, em funções de leitura com o MESMO formato que o front já consome:
--   wacrm.dashboard_conversations_series(p_start, p_tz)           → linhas (day 'YYYY-MM-DD', incoming, outgoing)
--   wacrm.dashboard_conversations_status()                         → {"open": n, "pending": n}
--   wacrm.dashboard_response_time(p_start, p_tz, p_this_week, p_last_week) → {buckets:[{dow,avgMinutes,samples}×7], thisWeekAvg, lastWeekAvg}
--   wacrm.dashboard_ai_analytics()                                 → o objeto AiAnalyticsData (sentiment, messagesRatio, conversion, financials)
-- SECURITY INVOKER: rodam com a sessão de quem chama, então a RLS de conversations/messages/deals/profiles vale EXATAMENTE como na leitura
-- direta de antes (o agente continua vendo só o que a RLS dele deixa); o filtro explícito por conta (wacrm.current_account_id()) só ajuda o
-- planejador a usar o índice. Dia e dia da semana são calculados no FUSO que o navegador informa (p_tz, nome IANA; inválido vira UTC) — o
-- mesmo "dia local" que o front sempre usou.
--
-- ÍNDICE: o filtro por conta + intervalo de datas de messages precisa de apoio — veja a 293b (CONCURRENTLY, rodar SOZINHA). As funções
-- funcionam sem ela, só mais devagar em bases enormes.
-- COMPATIBILIDADE: o app detecta a ausência das funções (PGRST202/42883) e volta à leitura antiga (com o limite de 1000 linhas).
-- ANTES ou DEPOIS do deploy.
--
-- PRÉ-CHECK:  SELECT to_regprocedure('wacrm.dashboard_ai_analytics()');   -- NULL
-- ROLLBACK:   DROP FUNCTION IF EXISTS wacrm.dashboard_conversations_series(timestamptz, text), wacrm.dashboard_conversations_status(),
--               wacrm.dashboard_response_time(timestamptz, text, timestamptz, timestamptz), wacrm.dashboard_ai_analytics();
-- Idempotente — pode rodar mais de uma vez.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.messages') IS NULL OR to_regclass('wacrm.conversations') IS NULL OR to_regclass('wacrm.deals') IS NULL
     OR to_regclass('wacrm.profiles') IS NULL THEN
    RAISE EXCEPTION '293: faltam wacrm.messages/conversations/deals/profiles';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'wacrm' AND p.proname = 'current_account_id') THEN
    RAISE EXCEPTION '293: wacrm.current_account_id() não existe (migration 170)';
  END IF;
END $$;

-- ---------- 1) série mensagens recebidas × enviadas por dia ----------
CREATE OR REPLACE FUNCTION wacrm.dashboard_conversations_series(p_start timestamptz, p_tz text DEFAULT 'UTC')
RETURNS TABLE (day text, incoming bigint, outgoing bigint)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_tz text := COALESCE(NULLIF(p_tz, ''), 'UTC');
BEGIN
  BEGIN
    PERFORM now() AT TIME ZONE v_tz;
  EXCEPTION WHEN OTHERS THEN
    v_tz := 'UTC';
  END;
  RETURN QUERY
  SELECT to_char((m.created_at AT TIME ZONE v_tz)::date, 'YYYY-MM-DD'),
         count(*) FILTER (WHERE m.sender_type IS NOT DISTINCT FROM 'customer'),
         count(*) FILTER (WHERE m.sender_type IS DISTINCT FROM 'customer')   -- atendente + bot (e qualquer outro) = enviadas
    FROM wacrm.messages m
   WHERE m.account_id = wacrm.current_account_id()
     AND m.created_at >= p_start
   GROUP BY 1
   ORDER BY 1;
END;
$$;

-- ---------- 2) situação atual das conversas ----------
CREATE OR REPLACE FUNCTION wacrm.dashboard_conversations_status()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
           'open',    count(*) FILTER (WHERE c.status = 'open'),
           'pending', count(*) FILTER (WHERE c.status = 'pending'))
    FROM wacrm.conversations c
   WHERE c.account_id = wacrm.current_account_id();
$$;

-- ---------- 3) tempo de primeira resposta por dia da semana ----------
-- Por conversa, em ordem de tempo: o 1º cliente de uma sequência de mensagens do cliente é pareado com a 1ª mensagem de saída que vem
-- depois (uma mensagem do cliente só conta uma vez, mesmo que ele escreva de novo antes da resposta). Mesma regra do cálculo antigo.
CREATE OR REPLACE FUNCTION wacrm.dashboard_response_time(
  p_start timestamptz,
  p_tz text DEFAULT 'UTC',
  p_this_week timestamptz DEFAULT NULL,
  p_last_week timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_tz text := COALESCE(NULLIF(p_tz, ''), 'UTC');
  v_result jsonb;
BEGIN
  BEGIN
    PERFORM now() AT TIME ZONE v_tz;
  EXCEPTION WHEN OTHERS THEN
    v_tz := 'UTC';
  END;

  WITH msgs AS (
    SELECT m.conversation_id, m.id, m.created_at, (m.sender_type IS NOT DISTINCT FROM 'customer') AS is_c
      FROM wacrm.messages m
     WHERE m.account_id = wacrm.current_account_id()
       AND m.created_at >= p_start
  ), flagged AS (
    SELECT *, (is_c IS DISTINCT FROM lag(is_c) OVER w)::int AS changed
      FROM msgs
    WINDOW w AS (PARTITION BY conversation_id ORDER BY created_at, id)
  ), runs AS (
    SELECT conversation_id, is_c, created_at,
           sum(changed) OVER (PARTITION BY conversation_id ORDER BY created_at, id) AS run_no
      FROM flagged
  ), run_start AS (
    SELECT conversation_id, run_no, is_c, min(created_at) AS first_at
      FROM runs
     GROUP BY conversation_id, run_no, is_c
  ), samples AS (
    SELECT a.first_at AS customer_at,
           EXTRACT(EPOCH FROM (b.first_at - a.first_at)) / 60.0 AS minutes
      FROM run_start a
      JOIN run_start b ON b.conversation_id = a.conversation_id AND b.run_no = a.run_no + 1
     WHERE a.is_c AND NOT b.is_c
       AND b.first_at >= a.first_at
  ), by_dow AS (
    SELECT (EXTRACT(ISODOW FROM (customer_at AT TIME ZONE v_tz)) - 1)::int AS dow,
           avg(minutes) AS avg_minutes, count(*) AS samples
      FROM samples
     GROUP BY 1
  )
  SELECT jsonb_build_object(
           'buckets', (
             SELECT jsonb_agg(jsonb_build_object('dow', d.dow, 'avgMinutes', b.avg_minutes, 'samples', COALESCE(b.samples, 0)) ORDER BY d.dow)
               FROM generate_series(0, 6) AS d(dow)
               LEFT JOIN by_dow b ON b.dow = d.dow),
           'thisWeekAvg', (SELECT avg(minutes) FROM samples WHERE p_this_week IS NOT NULL AND customer_at >= p_this_week),
           'lastWeekAvg', (SELECT avg(minutes) FROM samples WHERE p_last_week IS NOT NULL AND p_this_week IS NOT NULL
                                                                  AND customer_at >= p_last_week AND customer_at < p_this_week))
    INTO v_result;
  RETURN v_result;
END;
$$;

-- ---------- 4) análises (sentimento, razão bot × humano, conversão e ranking de operadores) ----------
CREATE OR REPLACE FUNCTION wacrm.dashboard_ai_analytics()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH acct AS (SELECT wacrm.current_account_id() AS id),
  sent AS (
    SELECT count(*) FILTER (WHERE c.sentiment = 'positive') AS positive,
           count(*) FILTER (WHERE c.sentiment = 'neutral')  AS neutral,
           count(*) FILTER (WHERE c.sentiment = 'negative') AS negative,
           count(*) FILTER (WHERE c.sentiment = 'mixed')    AS mixed
      FROM wacrm.conversations c, acct WHERE c.account_id = acct.id
  ), ratio AS (
    SELECT count(*) FILTER (WHERE m.sender_type = 'bot')   AS bot,
           count(*) FILTER (WHERE m.sender_type = 'agent') AS human
      FROM wacrm.messages m, acct
     WHERE m.account_id = acct.id AND m.sender_type IN ('agent', 'bot')
  ), dl AS (
    SELECT count(*) FILTER (WHERE d.status = 'won') AS won,
           count(*) FILTER (WHERE d.status = 'lost') AS lost,
           count(*) FILTER (WHERE d.status IS DISTINCT FROM 'won' AND d.status IS DISTINCT FROM 'lost') AS open,
           COALESCE(sum(COALESCE(d.value, 0)) FILTER (WHERE d.status = 'won'), 0) AS won_value,
           COALESCE(sum(COALESCE(d.value, 0)) FILTER (WHERE d.status IS DISTINCT FROM 'won' AND d.status IS DISTINCT FROM 'lost'), 0) AS open_value
      FROM wacrm.deals d, acct WHERE d.account_id = acct.id
  ), ops AS (
    SELECT d.user_id,
           COALESCE(sum(COALESCE(d.value, 0)), 0) AS total_won,
           count(*) AS deal_count
      FROM wacrm.deals d, acct
     WHERE d.account_id = acct.id AND d.status = 'won' AND d.user_id IS NOT NULL
     GROUP BY d.user_id
  )
  SELECT jsonb_build_object(
    'sentiment', jsonb_build_object(
      'positive', sent.positive, 'neutral', sent.neutral, 'negative', sent.negative, 'mixed', sent.mixed,
      'total', sent.positive + sent.neutral + sent.negative + sent.mixed),
    'messagesRatio', jsonb_build_object('bot', ratio.bot, 'human', ratio.human, 'total', ratio.bot + ratio.human),
    'conversion', jsonb_build_object(
      'won', dl.won, 'lost', dl.lost, 'open', dl.open, 'total', dl.won + dl.lost + dl.open,
      'rate', CASE WHEN dl.won + dl.lost > 0 THEN round(dl.won::numeric / (dl.won + dl.lost) * 100) ELSE 0 END),
    'financials', jsonb_build_object(
      'totalWonValue', dl.won_value,
      'totalOpenValue', dl.open_value,
      'ticketMedio', CASE WHEN dl.won > 0 THEN round(dl.won_value / dl.won) ELSE 0 END,
      'operators', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'userId', o.user_id,
                 'userName', COALESCE(NULLIF(p.full_name, ''), NULLIF(p.email, ''), 'Operador'),
                 'totalWon', o.total_won,
                 'dealCount', o.deal_count) ORDER BY o.total_won DESC, o.user_id)
          FROM ops o LEFT JOIN wacrm.profiles p ON p.user_id = o.user_id), '[]'::jsonb)))
    FROM sent, ratio, dl;
$$;

REVOKE ALL ON FUNCTION wacrm.dashboard_conversations_series(timestamptz, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION wacrm.dashboard_conversations_status() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION wacrm.dashboard_response_time(timestamptz, text, timestamptz, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION wacrm.dashboard_ai_analytics() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wacrm.dashboard_conversations_series(timestamptz, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION wacrm.dashboard_conversations_status() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION wacrm.dashboard_response_time(timestamptz, text, timestamptz, timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION wacrm.dashboard_ai_analytics() TO authenticated, service_role;

-- Registro (migration 202). Tolerante a banco sem a 202.
DO $$
BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('293_dashboard_aggregates') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
