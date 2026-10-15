-- ============================================================
-- 366_dispatch_engine_flags.sql   (decisão do dono de 15/10 — chave de ligar/desligar claim em lote e tick encadeado pela tela)
--
-- O QUE FAZ:
--   wacrm.dispatch_engine_flags: 1 linha por conta com duas chaves do motor do Disparador:
--     batch_claim  (claim e confirmação em lote, migration 188)  e  tick_chain  (tick encadeado).
--   NULL = "seguir o ambiente" (DISPARADOR_BATCH_CLAIM / DISPARADOR_TICK_CHAIN, hoje desligados); true/false = decisão da conta, que vale
--   no próximo tick (≤ 10 s de cache, sem reinício). O motor é compartilhado: se mais de uma conta tiver linha, "ligar" de qualquer uma liga;
--   senão "desligar" de qualquer uma desliga; senão vale o ambiente. Quem muda é o app (rota /api/disparador/engine, permissão
--   campaigns.rate_limit, com auditoria); o navegador só LÊ (RLS com campaigns.rate_limit).
-- COMPATIBILIDADE: tabela nova, nada existente muda. Sem ela o motor segue exatamente o ambiente (como hoje) e a rota devolve 503.
--   Antes ou depois do deploy. Idempotente.
-- PRÉ-CHECK (rodar ANTES; schema vivo):
--   SELECT to_regclass('wacrm.dispatch_engine_flags');                                                    -- NULL na 1ª vez
--   SELECT to_regclass('wacrm.accounts'), to_regprocedure('wacrm.has_perm(text)'), to_regprocedure('wacrm.is_account_member(uuid, text)');  -- não nulos
--   SELECT key FROM wacrm.permission_catalog WHERE key = 'campaigns.rate_limit';                           -- 1 linha
-- VERIFICAÇÃO:
--   SELECT account_id, batch_claim, tick_chain FROM wacrm.dispatch_engine_flags;
--   SELECT version FROM wacrm.schema_migrations WHERE version = '366_dispatch_engine_flags';
-- ROLLBACK (executável; o teste PGlite executa este bloco):
--   BEGIN;
--   DROP TABLE IF EXISTS wacrm.dispatch_engine_flags;
--   DELETE FROM wacrm.schema_migrations WHERE version = '366_dispatch_engine_flags';
--   COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.accounts') IS NULL THEN
    RAISE EXCEPTION '366: falta wacrm.accounts';
  END IF;
  IF to_regprocedure('wacrm.has_perm(text)') IS NULL THEN
    RAISE EXCEPTION '366: falta wacrm.has_perm(text) (migration 241)';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS wacrm.dispatch_engine_flags (
  account_id  uuid        PRIMARY KEY REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  batch_claim boolean,
  tick_chain  boolean,
  updated_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE wacrm.dispatch_engine_flags IS
  'Chaves do motor do Disparador por conta (NULL = seguir o ambiente). Escrita só pelo app (service_role); leitura com campaigns.rate_limit.';

ALTER TABLE wacrm.dispatch_engine_flags ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS dispatch_engine_flags_select ON wacrm.dispatch_engine_flags;
CREATE POLICY dispatch_engine_flags_select ON wacrm.dispatch_engine_flags FOR SELECT USING (
  wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('campaigns.rate_limit'))
);
REVOKE ALL ON wacrm.dispatch_engine_flags FROM PUBLIC, anon, authenticated;
GRANT SELECT ON wacrm.dispatch_engine_flags TO authenticated;
GRANT ALL ON wacrm.dispatch_engine_flags TO service_role;

-- 2FA (migration 310): se já aplicada, cobre a tabela aqui (idempotente); se não, a 310 cobre depois.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'wacrm' AND p.proname = 'apply_mfa_policy'
  ) THEN
    PERFORM wacrm.apply_mfa_policy('wacrm.dispatch_engine_flags'::regclass);
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('366_dispatch_engine_flags') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
