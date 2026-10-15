-- ============================================================
-- 375_dashboard_ai_snapshot.sql   (desempenho — painel de IA do Dashboard sem recontar mensagens a cada abertura)
--
-- PROBLEMA: wacrm.dashboard_ai_analytics() (293/306) conta TODAS as mensagens de agente/bot da conta, as conversas por sentimento e os negócios, tudo com a RLS
-- por linha (messages lê conversations por linha): ~4,2 s a cada vez que alguém abre o Dashboard (pg_stat_statements, 15/10).
--
-- O QUE FAZ (mesma informação, mesmo formato, o painel não muda):
--   1. wacrm.dashboard_ai_snapshot (conta → jsonb + hora): o resumo já calculado da conta. Só o servidor/funções escrevem e leem (RLS ligada, sem policy).
--   2. wacrm.dashboard_ai_compute(conta): o mesmo cálculo da 293 para UMA conta, sem RLS e SEM nome/e-mail de operador (só userId, total, quantidade).
--   3. wacrm.refresh_dashboard_ai_snapshots(): recalcula, em lote pequeno, as contas com atividade nas últimas 24 h (member_presence) cujo resumo tem mais de 5 min.
--      O cron do Disparador já chama esta função a cada tick (código desta entrega); chamar à mão: SELECT wacrm.refresh_dashboard_ai_snapshots();
--   4. wacrm.dashboard_ai_analytics() passa a ler o resumo (≤ 30 min) e a juntar os nomes dos operadores NA HORA (full_name, e-mail só para quem pode ver — como
--      na 306). A função antiga é MANTIDA como wacrm.dashboard_ai_analytics_live() (renomeada: a definição VIVA, sem recopiar texto) e é o caminho de reserva.
--
-- QUEM LÊ O RESUMO: só quem, antes, via a conta INTEIRA: admin+ da conta E com pipelines.view. Supervisor, agente, visualizador e papel sem pipelines.view continuam
-- no cálculo ao vivo (RLS por linha), porque a RLS deles restringe o que contam: o resumo da conta inteira mostraria mais do que viam.
-- Sem resumo, ou resumo velho (> 30 min), ou função de cálculo ausente: também cai no ao vivo (nunca devolve número velho demais).
--
-- ATRASO: o painel mostra o estado de até ~5 min atrás (antes: de agora). O painel já exibe "Atualizado há N min".
--
-- PRÉ-CHECK:  SELECT to_regprocedure('wacrm.dashboard_ai_analytics()'), to_regprocedure('wacrm.current_account_id()'), to_regprocedure('wacrm.has_perm(text)'),
--                    to_regprocedure('wacrm.visible_member_email(uuid)'), to_regclass('wacrm.member_presence');                  -- todos não nulos (293, 170, 241, 306, 024)
--             SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'wacrm' AND proname LIKE 'dashboard_ai%';   -- só dashboard_ai_analytics
-- VERIFICAÇÃO: SELECT wacrm.refresh_dashboard_ai_snapshots(); SELECT account_id, refreshed_at FROM wacrm.dashboard_ai_snapshot;     -- 1 linha por conta ativa
--              logado como admin: EXPLAIN (ANALYZE) SELECT wacrm.dashboard_ai_analytics();  → de ~4 s para poucos ms (prd-v2/perf-explain.sql [3]).
-- ORDEM: depois da 293 e da 306. Antes ou depois do deploy (sem o cron novo o painel usa o cálculo ao vivo até alguém rodar o refresh). Idempotente.
-- ROLLBACK:   BEGIN;
--             DROP FUNCTION IF EXISTS wacrm.dashboard_ai_analytics();
--             ALTER FUNCTION wacrm.dashboard_ai_analytics_live() RENAME TO dashboard_ai_analytics;
--             DROP FUNCTION IF EXISTS wacrm.refresh_dashboard_ai_snapshots(interval, integer);
--             DROP FUNCTION IF EXISTS wacrm.dashboard_ai_snapshot_read();
--             DROP FUNCTION IF EXISTS wacrm.dashboard_ai_compute(uuid);
--             DROP TABLE IF EXISTS wacrm.dashboard_ai_snapshot;
--             DELETE FROM wacrm.schema_migrations WHERE version = '375_dashboard_ai_snapshot';
--             COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.accounts') IS NULL THEN
    RAISE EXCEPTION '375: falta wacrm.accounts';
  END IF;
  IF to_regclass('wacrm.conversations') IS NULL OR to_regclass('wacrm.messages') IS NULL OR to_regclass('wacrm.deals') IS NULL OR to_regclass('wacrm.profiles') IS NULL THEN
    RAISE EXCEPTION '375: faltam conversations/messages/deals/profiles em wacrm — confira o schema vivo';
  END IF;
  -- por NOME (a assinatura pode variar entre ambientes); has_perm/visible_member_email/current_account_id são chamadas por nome na execução
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'wacrm' AND p.proname = 'has_perm') THEN
    RAISE EXCEPTION '375: falta wacrm.has_perm (migration 241)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'wacrm' AND p.proname = 'current_account_id') THEN
    RAISE EXCEPTION '375: falta wacrm.current_account_id (migration 170)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'wacrm' AND p.proname = 'visible_member_email') THEN
    RAISE EXCEPTION '375: falta wacrm.visible_member_email (migration 306)';
  END IF;
  IF to_regclass('wacrm.member_presence') IS NULL THEN
    RAISE EXCEPTION '375: falta wacrm.member_presence (migration 024)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'wacrm' AND p.proname IN ('dashboard_ai_analytics', 'dashboard_ai_analytics_live')) THEN
    RAISE EXCEPTION '375: falta wacrm.dashboard_ai_analytics (migration 293)';
  END IF;
END $$;

-- 1) Resumo por conta. Só funções SECURITY DEFINER e o service_role tocam nele.
CREATE TABLE IF NOT EXISTS wacrm.dashboard_ai_snapshot (
  account_id   uuid PRIMARY KEY REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  data         jsonb NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE wacrm.dashboard_ai_snapshot ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE wacrm.dashboard_ai_snapshot FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE wacrm.dashboard_ai_snapshot TO service_role;

-- 2) O cálculo da 293 para UMA conta, sem RLS e sem nomes (os nomes entram na leitura, com a regra de e-mail da 306).
CREATE OR REPLACE FUNCTION wacrm.dashboard_ai_compute(p_account uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH sent AS (
    SELECT count(*) FILTER (WHERE c.sentiment = 'positive') AS positive,
           count(*) FILTER (WHERE c.sentiment = 'neutral')  AS neutral,
           count(*) FILTER (WHERE c.sentiment = 'negative') AS negative,
           count(*) FILTER (WHERE c.sentiment = 'mixed')    AS mixed
      FROM wacrm.conversations c WHERE c.account_id = p_account
  ), ratio AS (
    SELECT count(*) FILTER (WHERE m.sender_type = 'bot')   AS bot,
           count(*) FILTER (WHERE m.sender_type = 'agent') AS human
      FROM wacrm.messages m
     WHERE m.account_id = p_account AND m.sender_type IN ('agent', 'bot')
  ), dl AS (
    SELECT count(*) FILTER (WHERE d.status = 'won') AS won,
           count(*) FILTER (WHERE d.status = 'lost') AS lost,
           count(*) FILTER (WHERE d.status IS DISTINCT FROM 'won' AND d.status IS DISTINCT FROM 'lost') AS open,
           COALESCE(sum(COALESCE(d.value, 0)) FILTER (WHERE d.status = 'won'), 0) AS won_value,
           COALESCE(sum(COALESCE(d.value, 0)) FILTER (WHERE d.status IS DISTINCT FROM 'won' AND d.status IS DISTINCT FROM 'lost'), 0) AS open_value
      FROM wacrm.deals d WHERE d.account_id = p_account
  ), ops AS (
    SELECT d.user_id,
           COALESCE(sum(COALESCE(d.value, 0)), 0) AS total_won,
           count(*) AS deal_count
      FROM wacrm.deals d
     WHERE d.account_id = p_account AND d.status = 'won' AND d.user_id IS NOT NULL
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
        SELECT jsonb_agg(jsonb_build_object('userId', o.user_id, 'totalWon', o.total_won, 'dealCount', o.deal_count)
                         ORDER BY o.total_won DESC, o.user_id)
          FROM ops o), '[]'::jsonb)))
    FROM sent, ratio, dl;
$$;
REVOKE ALL ON FUNCTION wacrm.dashboard_ai_compute(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.dashboard_ai_compute(uuid) TO service_role;

-- 3) Recalcula as contas ativas com resumo velho (lote pequeno; uma conta presa por outro processo é pulada).
CREATE OR REPLACE FUNCTION wacrm.refresh_dashboard_ai_snapshots(p_max_age interval DEFAULT interval '5 minutes', p_limit integer DEFAULT 20)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r record;
  v_done integer := 0;
BEGIN
  FOR r IN
    SELECT a.id
      FROM wacrm.accounts a
     WHERE EXISTS (SELECT 1 FROM wacrm.member_presence mp WHERE mp.account_id = a.id AND mp.last_seen_at > now() - interval '24 hours')
       AND NOT EXISTS (SELECT 1 FROM wacrm.dashboard_ai_snapshot s WHERE s.account_id = a.id AND s.refreshed_at > now() - p_max_age)
     LIMIT GREATEST(COALESCE(p_limit, 20), 1)
  LOOP
    CONTINUE WHEN NOT pg_try_advisory_xact_lock(hashtextextended('dashboard_ai_snapshot:' || r.id::text, 0));
    INSERT INTO wacrm.dashboard_ai_snapshot (account_id, data, refreshed_at)
    VALUES (r.id, wacrm.dashboard_ai_compute(r.id), now())
    ON CONFLICT (account_id) DO UPDATE SET data = EXCLUDED.data, refreshed_at = EXCLUDED.refreshed_at;
    v_done := v_done + 1;
  END LOOP;
  RETURN v_done;
END;
$$;
REVOKE ALL ON FUNCTION wacrm.refresh_dashboard_ai_snapshots(interval, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.refresh_dashboard_ai_snapshots(interval, integer) TO service_role;

-- 4a) Leitura do resumo, só para quem via a conta inteira (admin+ E pipelines.view); NULL = use o cálculo ao vivo.
CREATE OR REPLACE FUNCTION wacrm.dashboard_ai_snapshot_read()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT s.data
    FROM wacrm.dashboard_ai_snapshot s
   WHERE s.account_id = (SELECT wacrm.current_account_id())
     AND s.refreshed_at > now() - interval '30 minutes'
     AND wacrm.is_account_member(s.account_id, 'admin')
     AND (SELECT wacrm.has_perm('pipelines.view'))
$$;
REVOKE ALL ON FUNCTION wacrm.dashboard_ai_snapshot_read() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wacrm.dashboard_ai_snapshot_read() TO authenticated, service_role;

-- 4b) A função antiga vira o caminho de reserva (renomeada: mantém a definição VIVA e as permissões).
DO $$
BEGIN
  IF to_regprocedure('wacrm.dashboard_ai_analytics_live()') IS NULL THEN
    ALTER FUNCTION wacrm.dashboard_ai_analytics() RENAME TO dashboard_ai_analytics_live;
  END IF;
END $$;

-- 4c) A função que o painel chama: resumo + nomes na hora (INVOKER: nome e e-mail seguem a RLS/regra da 306 de quem pergunta).
CREATE OR REPLACE FUNCTION wacrm.dashboard_ai_analytics()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH snap AS (SELECT wacrm.dashboard_ai_snapshot_read() AS j)
  SELECT CASE
    WHEN snap.j IS NULL THEN wacrm.dashboard_ai_analytics_live()
    ELSE jsonb_set(snap.j, '{financials,operators}', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'userId', o.elem ->> 'userId',
               'userName', COALESCE(NULLIF(p.full_name, ''), NULLIF(wacrm.visible_member_email(p.user_id), ''), 'Operador'),
               'totalWon', o.elem -> 'totalWon',
               'dealCount', o.elem -> 'dealCount') ORDER BY o.ord)
        FROM jsonb_array_elements(snap.j #> '{financials,operators}') WITH ORDINALITY AS o(elem, ord)
        LEFT JOIN wacrm.profiles p ON p.user_id = (o.elem ->> 'userId')::uuid), '[]'::jsonb))
  END
  FROM snap;
$$;
REVOKE ALL ON FUNCTION wacrm.dashboard_ai_analytics() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wacrm.dashboard_ai_analytics() TO authenticated, service_role;

-- 2FA (migration 310): se já aplicada, cobre a tabela nova aqui (idempotente); se não, a 310 cobre depois.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'wacrm' AND p.proname = 'apply_mfa_policy') THEN
    PERFORM wacrm.apply_mfa_policy('wacrm.dashboard_ai_snapshot'::regclass);
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('375_dashboard_ai_snapshot') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
