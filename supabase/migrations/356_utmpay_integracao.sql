-- ============================================================
-- 356_utmpay_integracao.sql   (decisões do dono 14/10 — UTMpay dentro do CRM)
--
-- Todo disparo sai com um link rastreado do UTMpay, UM POR ENVIO (tid = id do item da fila), e o UTMpay devolve os eventos do funil
-- (click, cpf_view, cpf_submit, payment_view, payment_start, paid) para o CRM. "Fechou acordo" = payment_start; "Pagou" = paid (confirmado
-- na API DDM, nunca só pelo evento). A atribuição (direto | ia | humano) sai da conversa entre o envio e o evento.
--   wacrm.utmpay_config        por conta: base_url, api_key e webhook_secret CIFRADOS (GCM, no servidor), janela_dias (padrão 7),
--                              send_without_tracking (enviar sem rastreio se o UTMpay cair; padrão false), enabled. Só service_role:
--                              o segredo nunca volta para o cliente (a API devolve só "tem chave").
--   wacrm.utmpay_links         um registro por envio rastreado: tid (PK), conta, campanha, contato, destino informado, link_curto e os
--                              RESULTADOS: clicou_em, fechou_em, pagou_em, atribuicao, atendente_id, situacao_acordo, valor_em_aberto,
--                              instituicao, verificado_em. RLS: ler = campaigns.view.
--   wacrm.utmpay_events        eventos do funil, idempotentes por event_id (UUID do UTMpay). RLS: ler = campaigns.view.
--   wacrm.utmpay_funnel(conta, campanha, desde)   contagens (links, clicou, fechou, pagou, por atribuição e por atendente) de UMA campanha ou do período.
-- COMPATIBILIDADE: sem esta migration o envio segue como hoje (sem rastreio) e a rota de eventos responde 503.
-- ORDEM: depois da 240 (has_perm); antes ou depois do deploy. Idempotente.
-- PRÉ-CHECK:  SELECT to_regclass('wacrm.utmpay_config'), to_regclass('wacrm.utmpay_links'), to_regclass('wacrm.utmpay_events');  -- NULL, NULL, NULL na 1ª vez
--             SELECT to_regprocedure('wacrm.has_perm(text)');                                                                    -- existe
-- VERIFICAÇÃO: como authenticated, SELECT em utmpay_config → negado; INSERT/UPDATE em utmpay_links e utmpay_events → negado.
-- ROLLBACK:   BEGIN;
--             DROP FUNCTION IF EXISTS wacrm.utmpay_funnel(uuid, uuid, timestamptz);
--             DROP TABLE IF EXISTS wacrm.utmpay_events;
--             DROP TABLE IF EXISTS wacrm.utmpay_links;
--             DROP TABLE IF EXISTS wacrm.utmpay_config;
--             DELETE FROM wacrm.schema_migrations WHERE version = '356_utmpay_integracao';
--             COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('wacrm.has_perm(text)') IS NULL THEN
    RAISE EXCEPTION '356: falta wacrm.has_perm(text) (migration 240) — nada foi alterado';
  END IF;
  IF to_regclass('wacrm.accounts') IS NULL OR to_regclass('wacrm.campaigns') IS NULL OR to_regclass('wacrm.contacts') IS NULL THEN
    RAISE EXCEPTION '356: faltam wacrm.accounts / campaigns / contacts — confira o schema vivo';
  END IF;
END $$;

-- ---------- Configuração por conta (só o servidor) ----------
CREATE TABLE IF NOT EXISTS wacrm.utmpay_config (
  account_id            uuid        PRIMARY KEY REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  enabled               boolean     NOT NULL DEFAULT true,
  base_url              text        NOT NULL CHECK (base_url ~ '^https://[^/?#@]+$' AND char_length(base_url) <= 255),
  api_key_enc           text,
  webhook_secret_enc    text,
  janela_dias           integer     NOT NULL DEFAULT 7 CHECK (janela_dias BETWEEN 1 AND 90),
  send_without_tracking boolean     NOT NULL DEFAULT false,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid
);
ALTER TABLE wacrm.utmpay_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.utmpay_config FROM PUBLIC, anon, authenticated;
GRANT ALL ON wacrm.utmpay_config TO service_role;

-- ---------- Um link rastreado por envio ----------
CREATE TABLE IF NOT EXISTS wacrm.utmpay_links (
  tid              text          PRIMARY KEY CHECK (char_length(tid) BETWEEN 1 AND 40),
  account_id       uuid          NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  campaign_id      uuid          REFERENCES wacrm.campaigns(id) ON DELETE CASCADE,
  contact_id       uuid          REFERENCES wacrm.contacts(id) ON DELETE SET NULL,
  canal            text          NOT NULL DEFAULT 'whatsapp',
  destino          text          NOT NULL CHECK (destino ~* '^https?://' AND char_length(destino) <= 2048),
  link_curto       text          NOT NULL CHECK (link_curto ~* '^https?://' AND char_length(link_curto) <= 2048),
  codigo           text,
  created_at       timestamptz   NOT NULL DEFAULT now(),
  clicou_em        timestamptz,
  fechou_em        timestamptz,
  pagou_em         timestamptz,
  pagou_evento_em  timestamptz,
  atribuicao       text          CHECK (atribuicao IN ('direto', 'ia', 'humano')),
  atendente_id     uuid,
  situacao_acordo  text,
  valor_em_aberto  numeric(14,2),
  instituicao      text,
  verificado_em    timestamptz
);
CREATE INDEX IF NOT EXISTS idx_utmpay_links_campaign ON wacrm.utmpay_links (account_id, campaign_id);
CREATE INDEX IF NOT EXISTS idx_utmpay_links_pending_paid ON wacrm.utmpay_links (pagou_evento_em) WHERE pagou_evento_em IS NOT NULL AND pagou_em IS NULL;

ALTER TABLE wacrm.utmpay_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS utmpay_links_select ON wacrm.utmpay_links;
CREATE POLICY utmpay_links_select ON wacrm.utmpay_links FOR SELECT USING (
  wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('campaigns.view'))
);
REVOKE ALL ON wacrm.utmpay_links FROM PUBLIC, anon, authenticated;
GRANT SELECT ON wacrm.utmpay_links TO authenticated;
GRANT ALL ON wacrm.utmpay_links TO service_role;

-- ---------- Eventos do funil (idempotentes por event_id) ----------
CREATE TABLE IF NOT EXISTS wacrm.utmpay_events (
  event_id     uuid        PRIMARY KEY,
  account_id   uuid        NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  tid          text        NOT NULL REFERENCES wacrm.utmpay_links(tid) ON DELETE CASCADE,
  etapa        text        NOT NULL CHECK (etapa IN ('click', 'cpf_view', 'cpf_submit', 'payment_view', 'payment_start', 'paid')),
  occurred_at  timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  codigo       text,
  campanha     text,
  canal        text,
  in_window    boolean     NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS idx_utmpay_events_tid ON wacrm.utmpay_events (tid);
CREATE INDEX IF NOT EXISTS idx_utmpay_events_account ON wacrm.utmpay_events (account_id, received_at DESC);

ALTER TABLE wacrm.utmpay_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS utmpay_events_select ON wacrm.utmpay_events;
CREATE POLICY utmpay_events_select ON wacrm.utmpay_events FOR SELECT USING (
  wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('campaigns.view'))
);
REVOKE ALL ON wacrm.utmpay_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON wacrm.utmpay_events TO authenticated;
GRANT ALL ON wacrm.utmpay_events TO service_role;

-- 2FA (migration 310): se já aplicada, cobre as tabelas aqui (idempotente); se não, a 310 cobre depois.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'wacrm' AND p.proname = 'apply_mfa_policy'
  ) THEN
    PERFORM wacrm.apply_mfa_policy('wacrm.utmpay_config'::regclass);
    PERFORM wacrm.apply_mfa_policy('wacrm.utmpay_links'::regclass);
    PERFORM wacrm.apply_mfa_policy('wacrm.utmpay_events'::regclass);
  END IF;
END $$;

-- Contagens por campanha (p_campaign) ou do período da conta (p_since) (entregues vêm do código, que já tem as contagens por status da fila).
CREATE OR REPLACE FUNCTION wacrm.utmpay_funnel(p_account uuid, p_campaign uuid, p_since timestamptz)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH l AS (
    SELECT * FROM wacrm.utmpay_links WHERE account_id = p_account AND (p_campaign IS NULL OR campaign_id = p_campaign) AND (p_since IS NULL OR created_at >= p_since)
  )
  SELECT jsonb_build_object(
    'links',  (SELECT count(*) FROM l),
    'clicou', (SELECT count(*) FROM l WHERE clicou_em IS NOT NULL),
    'fechou', (SELECT count(*) FROM l WHERE fechou_em IS NOT NULL),
    'pagou',  (SELECT count(*) FROM l WHERE pagou_em IS NOT NULL),
    'por_atribuicao', jsonb_build_object(
      'fechou', (SELECT COALESCE(jsonb_object_agg(a, n), '{}'::jsonb) FROM (SELECT atribuicao AS a, count(*) AS n FROM l WHERE fechou_em IS NOT NULL AND atribuicao IS NOT NULL GROUP BY atribuicao) x),
      'pagou',  (SELECT COALESCE(jsonb_object_agg(a, n), '{}'::jsonb) FROM (SELECT atribuicao AS a, count(*) AS n FROM l WHERE pagou_em IS NOT NULL AND atribuicao IS NOT NULL GROUP BY atribuicao) x)
    ),
    'por_atendente', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('atendente_id', atendente_id, 'fechou', f, 'pagou', p) ORDER BY p DESC, f DESC), '[]'::jsonb)
      FROM (
        SELECT atendente_id, count(*) FILTER (WHERE fechou_em IS NOT NULL) AS f, count(*) FILTER (WHERE pagou_em IS NOT NULL) AS p
        FROM l WHERE atribuicao = 'humano' AND atendente_id IS NOT NULL GROUP BY atendente_id
      ) y
    )
  );
$$;
REVOKE ALL ON FUNCTION wacrm.utmpay_funnel(uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.utmpay_funnel(uuid, uuid, timestamptz) TO service_role;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('356_utmpay_integracao') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
