-- ============================================================
-- 364_disp_live_push.sql   (desempenho — acompanhamento do Disparador EMPURRADO pelo banco, em vez de polling a cada 3 s)
--
-- PROBLEMA: Monitor, Campanhas, Desempenho e Números perguntavam ao servidor a cada 3 s (cada aba aberta = 20 idas/min por tela, cada uma lendo a fila).
--
-- O QUE FAZ:
--   1. Trigger de comando (statement-level) em wacrm.campaign_metric_deltas: TODO envio/entrega/leitura/erro/bloqueio/resposta que o motor ou o webhook
--      registra (increment_campaign_metric da 183, a função de status da 185) insere ali um delta. O trigger agrega o comando por campanha e publica UMA
--      mensagem de Realtime Broadcast no canal PRIVADO `disp:<account_id>`, evento `delta`, payload
--      {"ts": "<hora do banco>", "campaigns": {"<campaign_id>": {"total_enviados": 1, "total_erros": 2, ...}}}.
--      Nunca assina nem publica a fila: é um contador pequeno por campanha, no instante em que o fato acontece.
--      Falha do Realtime NUNCA derruba o envio (EXCEPTION WHEN OTHERS → ignora).
--   2. Policy em realtime.messages: só lê o canal `disp:<conta>` quem é admin+ (mesmo critério de requireDisparadorAccess) dessa conta. Outra conta não recebe.
--   3. Tira member_presence da publication supabase_realtime: o batimento de cada aba (30 s) era avaliado pelo Realtime para todos os assinantes da conta;
--      a tela de presença agora relê a tabela a cada 30 s (código desta entrega).
--
-- O front aplica o delta na hora e reconcilia por consulta leve a cada 45 s (se o canal cair, volta ao polling de 3 s).
--
-- PRÉ-CHECK:  SELECT to_regprocedure('realtime.send(jsonb, text, text, boolean)'), to_regclass('realtime.messages');          -- ambos não nulos (Supabase Realtime Broadcast)
--             SELECT to_regclass('wacrm.campaign_metric_deltas'), to_regprocedure('wacrm.is_account_member(uuid, wacrm.account_role_enum)');   -- (a 2ª pode ser public.account_role_enum)
--             SELECT schemaname, tablename FROM pg_publication_tables WHERE pubname = 'supabase_realtime';                                      -- confira member_presence
-- VERIFICAÇÃO: INSERT de teste num delta (em transação com ROLLBACK) e uma aba do Disparador aberta mostra "ao vivo"; SELECT count(*) FROM realtime.messages WHERE topic LIKE 'disp:%'; cresce.
-- ORDEM: aplicar ANTES ou DEPOIS do deploy (o código antigo ignora o canal; o novo cai no polling se o canal não existir). Idempotente.
-- CUSTO: +1 INSERT em realtime.messages por comando que grava deltas (o motor grava 1 por item processado). Para desligar sem desfazer o resto:
--        DROP TRIGGER IF EXISTS campaign_metric_deltas_live_push ON wacrm.campaign_metric_deltas;
-- ROLLBACK:   BEGIN;
--             DROP TRIGGER IF EXISTS campaign_metric_deltas_live_push ON wacrm.campaign_metric_deltas;
--             DROP FUNCTION IF EXISTS wacrm.disp_live_push();
--             DROP POLICY IF EXISTS disp_live_receive ON realtime.messages;
--             DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'member_presence') AND to_regclass('wacrm.member_presence') IS NOT NULL THEN ALTER PUBLICATION supabase_realtime ADD TABLE wacrm.member_presence; END IF; END $$;
--             DELETE FROM wacrm.schema_migrations WHERE version = '364_disp_live_push';
--             COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.campaign_metric_deltas') IS NULL THEN
    RAISE EXCEPTION '364: falta wacrm.campaign_metric_deltas (migration 183)';
  END IF;
  IF to_regclass('wacrm.campaigns') IS NULL THEN
    RAISE EXCEPTION '364: falta wacrm.campaigns';
  END IF;
  IF to_regclass('realtime.messages') IS NULL OR NOT EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'realtime' AND p.proname = 'send') THEN
    RAISE EXCEPTION '364: faltam realtime.messages / realtime.send (Realtime Broadcast do Supabase) — confira o projeto';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'wacrm' AND p.proname = 'is_account_member') THEN
    RAISE EXCEPTION '364: falta wacrm.is_account_member';
  END IF;
END $$;

-- 1) Publica o delta agregado do comando, por conta.
CREATE OR REPLACE FUNCTION wacrm.disp_live_push()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.account_id,
           jsonb_object_agg(x.campaign_id::text, x.fields) AS campaigns
      FROM (
        SELECT d.campaign_id, jsonb_object_agg(d.field, d.qty) AS fields
          FROM (SELECT campaign_id, field, sum(n)::int AS qty FROM newrows GROUP BY campaign_id, field) d
         GROUP BY d.campaign_id
      ) x
      JOIN wacrm.campaigns c ON c.id = x.campaign_id
     GROUP BY c.account_id
  LOOP
    BEGIN
      PERFORM realtime.send(
        jsonb_build_object('ts', clock_timestamp(), 'campaigns', r.campaigns),
        'delta',
        'disp:' || r.account_id::text,
        true
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;   -- o acompanhamento ao vivo nunca pode atrapalhar o envio
    END;
  END LOOP;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION wacrm.disp_live_push() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS campaign_metric_deltas_live_push ON wacrm.campaign_metric_deltas;
CREATE TRIGGER campaign_metric_deltas_live_push
  AFTER INSERT ON wacrm.campaign_metric_deltas
  REFERENCING NEW TABLE AS newrows
  FOR EACH STATEMENT EXECUTE FUNCTION wacrm.disp_live_push();

-- 2) Só admin+ da conta recebe o canal da conta.
DROP POLICY IF EXISTS disp_live_receive ON realtime.messages;
CREATE POLICY disp_live_receive ON realtime.messages
  FOR SELECT TO authenticated
  USING (
    realtime.messages.extension = 'broadcast'
    AND CASE
          WHEN (SELECT realtime.topic()) ~ '^disp:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN wacrm.is_account_member(substring((SELECT realtime.topic()) FROM 6)::uuid, 'admin')
          ELSE false
        END
  );

-- 3) Presença sai da publication (a tela relê a tabela; ver hooks/use-presence.ts).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT schemaname, tablename FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'member_presence' LOOP
    EXECUTE format('ALTER PUBLICATION supabase_realtime DROP TABLE %I.%I', r.schemaname, r.tablename);
  END LOOP;
END $$;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('364_disp_live_push') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
