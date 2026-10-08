-- ============================================================
-- 188_dispatch_batch_claim_confirm.sql   (P1-3b — claim e confirmação EM LOTE)
--
-- A 80 envios/s por número, 1 RPC por item para reivindicar (claim) e 1 para confirmar são ~160 idas ao banco por segundo POR NÚMERO, e o
-- candidato vinha de um SELECT paginado por OFFSET (F9/F10). Esta migration traz o caminho em lote; o por-item continua como fallback.
--
--   1) claim_dispatch_batch(p_session_id, p_n, p_campaign_ids, p_default_max_in_flight)
--        Reivindica até N itens VENCIDOS do número numa chamada: FOR UPDATE SKIP LOCKED (dois claims concorrentes nunca pegam o mesmo item),
--        UM advisory lock por lote (o mesmo do claim por item: serializa com ele), max_in_flight, hourly_limit do canal e limite_por_hora da
--        campanha checados UMA vez (regra do limite_por_hora IDÊNTICA à de claim_dispatch_item_capped: com limite → FOR UPDATE na campanha +
--        contagem enviando/última hora; sem limite → FOR SHARE). Devolve cada linha já com o contato embutido (jsonb no mesmo formato do
--        select "*, contacts(name, phone, company)" do PostgREST).
--   2) count_due_dispatch_items(p_campaign_ids, p_limit): quantos itens vencidos há por (campanha, número), limitado — substitui a paginação por OFFSET.
--   3) unclaim_dispatch_items(p_ids): devolve a 'agendado' itens reivindicados e NUNCA entregues ao envio (sobra do lote no fim do tick).
--   4) confirm_dispatch_items_sent(p_items jsonb): confirma um micro-lote chamando confirm_dispatch_item_sent (mark + replay de recibos + message_logs +
--        delta de métrica) item a item em SUBTRANSAÇÃO — o efeito de cada item é idêntico ao da confirmação unitária; um item inválido não derruba os outros.
--
-- PRÉ-CHECK (rode ANTES e confira — o corpo de produção pode divergir dos arquivos):
--   SELECT pg_get_functiondef('wacrm.claim_dispatch_item_capped(uuid,integer)'::regprocedure);
--   SELECT pg_get_functiondef('wacrm.confirm_dispatch_item_sent(uuid,uuid,uuid,uuid,text,text,integer)'::regprocedure);
--   SELECT pg_get_functiondef('wacrm.mark_queue_item_sent(uuid,uuid,uuid,uuid,text,text,integer)'::regprocedure);
--   -- Conferir: o claim usa advisory lock hashtextextended(session_id::text, 118), exige campanha 'em_execucao', item 'agendado' vencido, sem
--   -- waha_message_id, e limite_por_hora com FOR UPDATE + contagem (enviando OU sent_at na última hora). Se divergir, ajuste este arquivo.
--   SELECT indexdef FROM pg_indexes WHERE schemaname='wacrm' AND tablename='disp_message_queue';  -- idealmente (campaign_id, status, scheduled_at)
--
-- ORDEM: aplicar ANTES do deploy do código. Código novo + banco antigo: o cron detecta a falta das RPCs e volta sozinho ao caminho por item.
-- Idempotente (CREATE OR REPLACE). Só service_role executa.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('wacrm.claim_dispatch_item_capped(uuid,integer)') IS NULL THEN
    RAISE EXCEPTION '188: falta wacrm.claim_dispatch_item_capped(uuid,integer) (migration 164/167)';
  END IF;
  IF to_regprocedure('wacrm.confirm_dispatch_item_sent(uuid,uuid,uuid,uuid,text,text,integer)') IS NULL THEN
    RAISE EXCEPTION '188: falta wacrm.confirm_dispatch_item_sent (migration 167)';
  END IF;
  IF to_regclass('wacrm.dispatch_channel_limits') IS NULL THEN
    RAISE EXCEPTION '188: falta wacrm.dispatch_channel_limits';
  END IF;
END $$;

-- ---------- 1) claim em lote ----------
CREATE OR REPLACE FUNCTION wacrm.claim_dispatch_batch(
  p_session_id uuid,
  p_n integer,
  p_campaign_ids uuid[],
  p_default_max_in_flight integer DEFAULT NULL
)
RETURNS TABLE (item jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n integer := LEAST(GREATEST(COALESCE(p_n, 1), 1), 200);
  v_concurrency integer;
  v_channel_limit integer;
  v_count bigint;
  v_room integer;
  v_campaign_id uuid;
  v_campaign wacrm.campaigns%ROWTYPE;
  v_hourly_limit integer;
  v_take integer;
  v_ids uuid[];
  v_claimed uuid[] := ARRAY[]::uuid[];
  v_limited uuid[] := ARRAY[]::uuid[];
  v_unlimited uuid[] := ARRAY[]::uuid[];
BEGIN
  IF p_session_id IS NULL OR p_campaign_ids IS NULL OR cardinality(p_campaign_ids) = 0 THEN RETURN; END IF;

  -- Leitura sem lock só para escolher o modo de lock de cada campanha (igual ao claim por item).
  FOREACH v_campaign_id IN ARRAY p_campaign_ids LOOP
    SELECT limite_por_hora INTO v_hourly_limit FROM wacrm.campaigns WHERE id = v_campaign_id;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF COALESCE(v_hourly_limit, 0) > 0 THEN v_limited := v_limited || v_campaign_id;
    ELSE v_unlimited := v_unlimited || v_campaign_id;
    END IF;
  END LOOP;

  -- Locks de campanha em ordem de id (sem deadlock entre lotes): com limite → FOR UPDATE; sem → FOR SHARE.
  PERFORM 1 FROM wacrm.campaigns WHERE id = ANY (v_limited) ORDER BY id FOR UPDATE;
  PERFORM 1 FROM wacrm.campaigns WHERE id = ANY (v_unlimited) ORDER BY id FOR SHARE;

  -- Um advisory lock por lote (o mesmo do claim por item): serializa com claims de outras campanhas do mesmo número.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_session_id::text, 118));

  SELECT max_in_flight, hourly_limit INTO v_concurrency, v_channel_limit
  FROM wacrm.dispatch_channel_limits WHERE session_id = p_session_id;
  v_concurrency := COALESCE(
    v_concurrency,
    CASE WHEN p_default_max_in_flight BETWEEN 1 AND 150 THEN p_default_max_in_flight END,
    4
  );

  SELECT count(*) INTO v_count FROM wacrm.disp_message_queue WHERE session_id = p_session_id AND status = 'enviando';
  v_room := v_concurrency - v_count;
  IF v_room <= 0 THEN RETURN; END IF;
  v_n := LEAST(v_n, v_room);

  IF v_channel_limit IS NOT NULL THEN
    SELECT count(*) INTO v_count FROM wacrm.disp_message_queue
    WHERE session_id = p_session_id
      AND (status = 'enviando' OR sent_at >= clock_timestamp() - interval '1 hour');
    v_room := v_channel_limit - v_count;
    IF v_room <= 0 THEN RETURN; END IF;
    v_n := LEAST(v_n, v_room);
  END IF;

  FOREACH v_campaign_id IN ARRAY p_campaign_ids LOOP
    EXIT WHEN v_n <= 0;

    SELECT * INTO v_campaign FROM wacrm.campaigns WHERE id = v_campaign_id;
    IF NOT FOUND OR v_campaign.status <> 'em_execucao' THEN CONTINUE; END IF;
    -- Limite ligado entre a leitura e o lock: o lock compartilhado não protege a contagem; recusa (volta no próximo tick).
    IF v_campaign_id = ANY (v_unlimited) AND COALESCE(v_campaign.limite_por_hora, 0) > 0 THEN CONTINUE; END IF;

    v_take := v_n;
    IF COALESCE(v_campaign.limite_por_hora, 0) > 0 THEN
      SELECT count(*) INTO v_count FROM wacrm.disp_message_queue
      WHERE campaign_id = v_campaign.id
        AND (status = 'enviando' OR sent_at >= clock_timestamp() - interval '1 hour');
      v_take := LEAST(v_take, v_campaign.limite_por_hora - v_count);
      IF v_take <= 0 THEN CONTINUE; END IF;
    END IF;

    SELECT COALESCE(array_agg(s.id), ARRAY[]::uuid[]) INTO v_ids
    FROM (
      SELECT q.id
      FROM wacrm.disp_message_queue q
      WHERE q.campaign_id = v_campaign.id
        AND q.session_id = p_session_id
        AND q.status = 'agendado'
        AND q.scheduled_at <= clock_timestamp()
        AND NULLIF(q.waha_message_id, '') IS NULL
      ORDER BY q.scheduled_at, q.id
      LIMIT v_take
      FOR UPDATE SKIP LOCKED
    ) s;

    IF cardinality(v_ids) > 0 THEN
      UPDATE wacrm.disp_message_queue
      SET status = 'enviando', updated_at = clock_timestamp()
      WHERE id = ANY (v_ids);
      v_claimed := v_claimed || v_ids;
      v_n := v_n - cardinality(v_ids);
    END IF;
  END LOOP;

  RETURN QUERY
  SELECT to_jsonb(q) || jsonb_build_object(
           'contacts',
           CASE WHEN c.id IS NULL THEN NULL
                ELSE jsonb_build_object('name', c.name, 'phone', c.phone, 'company', c.company) END
         )
  FROM wacrm.disp_message_queue q
  LEFT JOIN wacrm.contacts c ON c.id = q.contact_id
  WHERE q.id = ANY (v_claimed)
  ORDER BY q.scheduled_at, q.id;
END;
$$;

-- ---------- 2) contagem de itens vencidos (substitui a paginação por OFFSET) ----------
CREATE OR REPLACE FUNCTION wacrm.count_due_dispatch_items(p_campaign_ids uuid[], p_limit integer DEFAULT 5000)
RETURNS TABLE (campaign_id uuid, session_id uuid, n integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT s.campaign_id, s.session_id, count(*)::integer
  FROM unnest(COALESCE(p_campaign_ids, ARRAY[]::uuid[])) AS c(id)
  CROSS JOIN LATERAL (
    SELECT q.campaign_id, q.session_id
    FROM wacrm.disp_message_queue q
    WHERE q.campaign_id = c.id
      AND q.status = 'agendado'
      AND q.scheduled_at <= clock_timestamp()
    ORDER BY q.scheduled_at, q.id
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 5000), 1), 20000)
  ) s
  GROUP BY s.campaign_id, s.session_id;
$$;

-- ---------- 3) devolve a 'agendado' itens reivindicados e nunca enviados ----------
CREATE OR REPLACE FUNCTION wacrm.unclaim_dispatch_items(p_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_count integer;
BEGIN
  UPDATE wacrm.disp_message_queue
  SET status = 'agendado', updated_at = clock_timestamp()
  WHERE id = ANY (COALESCE(p_ids, ARRAY[]::uuid[]))
    AND status = 'enviando'
    AND NULLIF(waha_message_id, '') IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ---------- 4) confirmação em micro-lote ----------
-- p_items: [{"p_item_id","p_campaign_id","p_contact_id","p_session_id","p_mensagem","p_waha_message_id","p_tentativas"}, …]
-- Devolve [{"item_id","ok","error"}] na mesma ordem de entrada. Cada item roda em subtransação: erro de um não desfaz os outros.
CREATE OR REPLACE FUNCTION wacrm.confirm_dispatch_items_sent(p_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row record;
  v_out jsonb := '[]'::jsonb;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN RETURN v_out; END IF;
  -- Ordem estável por item evita deadlock entre lotes concorrentes; o resultado volta na ordem de entrada (ord).
  FOR v_row IN
    SELECT e.value AS j, e.ord
    FROM jsonb_array_elements(p_items) WITH ORDINALITY AS e(value, ord)
    ORDER BY e.value ->> 'p_item_id'
  LOOP
    BEGIN
      PERFORM wacrm.confirm_dispatch_item_sent(
        (v_row.j ->> 'p_item_id')::uuid,
        (v_row.j ->> 'p_campaign_id')::uuid,
        NULLIF(v_row.j ->> 'p_contact_id', '')::uuid,
        (v_row.j ->> 'p_session_id')::uuid,
        v_row.j ->> 'p_mensagem',
        v_row.j ->> 'p_waha_message_id',
        COALESCE((v_row.j ->> 'p_tentativas')::integer, 0)
      );
      v_out := v_out || jsonb_build_array(jsonb_build_object('ord', v_row.ord, 'item_id', v_row.j ->> 'p_item_id', 'ok', true, 'error', NULL));
    EXCEPTION WHEN OTHERS THEN
      v_out := v_out || jsonb_build_array(jsonb_build_object('ord', v_row.ord, 'item_id', v_row.j ->> 'p_item_id', 'ok', false, 'error', SQLERRM));
    END;
  END LOOP;
  RETURN (SELECT COALESCE(jsonb_agg(x ORDER BY (x ->> 'ord')::integer), '[]'::jsonb) FROM jsonb_array_elements(v_out) AS x);
END;
$$;

-- ---------- Permissões (só service_role) ----------
REVOKE ALL ON FUNCTION wacrm.claim_dispatch_batch(uuid, integer, uuid[], integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.claim_dispatch_batch(uuid, integer, uuid[], integer) TO service_role;
REVOKE ALL ON FUNCTION wacrm.count_due_dispatch_items(uuid[], integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.count_due_dispatch_items(uuid[], integer) TO service_role;
REVOKE ALL ON FUNCTION wacrm.unclaim_dispatch_items(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.unclaim_dispatch_items(uuid[]) TO service_role;
REVOKE ALL ON FUNCTION wacrm.confirm_dispatch_items_sent(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.confirm_dispatch_items_sent(jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
