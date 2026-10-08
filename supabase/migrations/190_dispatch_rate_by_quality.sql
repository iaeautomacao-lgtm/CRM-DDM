-- ============================================================
-- 190_dispatch_rate_by_quality.sql   (P1-4 + P1-5 — limite por segundo por número, padrão pela qualidade da Meta, saúde do número)
--
-- Decisões do dono (guardadas EM TABELA, não em código): verde 80/s, amarelo 40/s, vermelho 8/s (+ campanha nova no número exige confirmação do owner),
-- desconhecido 5/s; sobe em RAMPA (+25% a cada 60 s) e nunca salta direto para 80/s; admin sobrescreve com motivo e auditoria; "voltar ao automático";
-- o sistema nunca sobe sozinho acima de um manual; se a qualidade piora e auto < manual, vale min(manual, auto) salvo force_above_quality (só owner).
-- WAHA fica fora da regra.
--
--   * wacrm.channel_health               — último estado conhecido do número na Meta (qualidade, tier, throughput) e de onde veio
--   * wacrm.dispatch_channel_rate        — limite/s automático (alvo + rampa) e o manual por número
--   * wacrm.dispatch_channel_rate_history — histórico IMUTÁVEL de cada mudança (só acknowledged_by/at pode mudar)
--   * wacrm.dispatch_rate_policy         — 1 linha por conta: % por cor, piso, teto físico, rampa (owner edita)
--   * trigger de auditoria em dispatch_channel_limits e dispatch_channel_rate (audit_logs, como a 131)
--
-- INERTE por padrão: sem linha em dispatch_channel_rate o motor segue exatamente como antes (só max_in_flight). As linhas nascem quando o webhook
-- de qualidade ou o poll /api/disparador/health/cron gravam a saúde do número.
--
-- PRÉ-CHECK (rode ANTES; cada linha deve dar o esperado):
--   SELECT to_regclass('wacrm.whatsapp_config'), to_regclass('wacrm.accounts'), to_regclass('wacrm.dispatch_channel_limits');   -- não nulos
--   SELECT to_regprocedure('wacrm.audit_write(uuid,text,text,uuid,text,text,text,jsonb,jsonb)');                               -- não nulo (migration 131)
--   SELECT column_name FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='whatsapp_config'
--      AND column_name IN ('account_id','waba_id','display_phone_number','provider','habilitado');                              -- 5 linhas
--
-- ORDEM: aplicar ANTES do deploy do código (o código novo tolera a ausência das tabelas — vira inerte — mas só liga com elas).
-- Idempotente. Só service_role acessa (padrão da 164).
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.whatsapp_config') IS NULL OR to_regclass('wacrm.accounts') IS NULL OR to_regclass('wacrm.dispatch_channel_limits') IS NULL THEN
    RAISE EXCEPTION '190: faltam wacrm.whatsapp_config / accounts / dispatch_channel_limits';
  END IF;
  IF to_regprocedure('wacrm.audit_write(uuid,text,text,uuid,text,text,text,jsonb,jsonb)') IS NULL THEN
    RAISE EXCEPTION '190: falta wacrm.audit_write (migration 131)';
  END IF;
END $$;

-- ---------- 1) política por conta ----------
CREATE TABLE IF NOT EXISTS wacrm.dispatch_rate_policy (
  account_id uuid PRIMARY KEY REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  green_rate   numeric(8,2) NOT NULL DEFAULT 80 CHECK (green_rate   > 0 AND green_rate   <= 1000),
  yellow_rate  numeric(8,2) NOT NULL DEFAULT 40 CHECK (yellow_rate  > 0 AND yellow_rate  <= 1000),
  red_rate     numeric(8,2) NOT NULL DEFAULT 8  CHECK (red_rate     > 0 AND red_rate     <= 1000),
  unknown_rate numeric(8,2) NOT NULL DEFAULT 5  CHECK (unknown_rate > 0 AND unknown_rate <= 1000),
  /** Teto físico por número (a Cloud API padrão aceita 80/s; sobe até 1.000/s em números elegíveis). */
  max_rate_per_second numeric(8,2) NOT NULL DEFAULT 80 CHECK (max_rate_per_second > 0 AND max_rate_per_second <= 1000),
  floor_rate numeric(8,2) NOT NULL DEFAULT 1 CHECK (floor_rate > 0),
  ramp_percent integer NOT NULL DEFAULT 25 CHECK (ramp_percent BETWEEN 1 AND 400),
  ramp_interval_seconds integer NOT NULL DEFAULT 60 CHECK (ramp_interval_seconds BETWEEN 10 AND 3600),
  red_requires_owner_confirmation boolean NOT NULL DEFAULT true,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO wacrm.dispatch_rate_policy (account_id)
SELECT id FROM wacrm.accounts
ON CONFLICT (account_id) DO NOTHING;

-- ---------- 2) saúde do número ----------
CREATE TABLE IF NOT EXISTS wacrm.channel_health (
  session_id uuid PRIMARY KEY REFERENCES wacrm.whatsapp_config(id) ON DELETE CASCADE,
  account_id uuid NOT NULL,
  quality_rating text CHECK (quality_rating IS NULL OR quality_rating IN ('GREEN', 'YELLOW', 'RED')),
  messaging_limit_tier text,
  daily_limit bigint,
  throughput_level text,
  checked_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL DEFAULT 'poll' CHECK (source IN ('poll', 'webhook', 'manual')),
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_channel_health_account ON wacrm.channel_health (account_id);

-- ---------- 3) limite/s por número ----------
CREATE TABLE IF NOT EXISTS wacrm.dispatch_channel_rate (
  session_id uuid PRIMARY KEY REFERENCES wacrm.whatsapp_config(id) ON DELETE CASCADE,
  account_id uuid NOT NULL,
  /** Alvo automático pela qualidade (cor → % da política). A rampa sobe até ele; descer é imediato. */
  auto_rate_per_second numeric(8,2) NOT NULL CHECK (auto_rate_per_second > 0),
  /** Rampa: taxa de partida e quando começou (o efetivo cresce ramp_percent a cada ramp_interval_seconds). */
  auto_ramp_from numeric(8,2),
  auto_ramp_started_at timestamptz,
  manual_rate_per_second numeric(8,2) CHECK (manual_rate_per_second IS NULL OR manual_rate_per_second > 0),
  manual_reason text,
  manual_set_by uuid,
  manual_set_at timestamptz,
  /** Só owner: manual vale mesmo com a qualidade abaixo dele. */
  force_above_quality boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (manual_rate_per_second IS NULL OR (manual_reason IS NOT NULL AND length(btrim(manual_reason)) >= 3))
);
CREATE INDEX IF NOT EXISTS idx_dispatch_channel_rate_account ON wacrm.dispatch_channel_rate (account_id);

-- ---------- 4) histórico imutável ----------
CREATE TABLE IF NOT EXISTS wacrm.dispatch_channel_rate_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  session_id uuid NOT NULL,   -- sem FK de propósito: o histórico sobrevive à exclusão do canal
  source text NOT NULL CHECK (source IN ('webhook', 'poll', 'admin', 'revert_auto', 'policy')),
  quality_old text,
  quality_new text,
  tier_old text,
  tier_new text,
  rate_old numeric(8,2),
  rate_new numeric(8,2),
  actor_id uuid,
  reason text,
  detail jsonb,
  acknowledged_by uuid,
  acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dcrh_account_created ON wacrm.dispatch_channel_rate_history (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dcrh_unacked ON wacrm.dispatch_channel_rate_history (account_id, created_at DESC) WHERE acknowledged_at IS NULL;

CREATE OR REPLACE FUNCTION wacrm.dispatch_channel_rate_history_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'dispatch_channel_rate_history é imutável (DELETE negado)';
  END IF;
  -- UPDATE: só o reconhecimento ("Reconhecer" no Monitor), uma vez.
  IF (to_jsonb(NEW) - 'acknowledged_by' - 'acknowledged_at') IS DISTINCT FROM (to_jsonb(OLD) - 'acknowledged_by' - 'acknowledged_at')
     OR OLD.acknowledged_at IS NOT NULL THEN
    RAISE EXCEPTION 'dispatch_channel_rate_history é imutável (só o reconhecimento pode ser registrado, uma vez)';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_dcrh_guard ON wacrm.dispatch_channel_rate_history;
CREATE TRIGGER trg_dcrh_guard
  BEFORE UPDATE OR DELETE ON wacrm.dispatch_channel_rate_history
  FOR EACH ROW EXECUTE FUNCTION wacrm.dispatch_channel_rate_history_guard();

-- ---------- 5) RLS: só service_role ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['dispatch_rate_policy', 'channel_health', 'dispatch_channel_rate', 'dispatch_channel_rate_history'] LOOP
    EXECUTE format('ALTER TABLE wacrm.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON wacrm.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT ALL ON wacrm.%I TO service_role', t);
  END LOOP;
END $$;

-- ---------- 6) auditoria das mudanças de limite ----------
-- Tabelas com chave session_id (sem id/account_id próprios no caso de dispatch_channel_limits): o recurso auditado é o número.
CREATE OR REPLACE FUNCTION wacrm.audit_dispatch_rate_changes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wacrm, public, extensions
AS $$
DECLARE
  v_type    text := TG_ARGV[0];
  v_noun    text := TG_ARGV[1];
  v_cols    text[] := string_to_array(TG_ARGV[2], ',');
  v_old     jsonb;
  v_new     jsonb;
  v_row     jsonb;
  v_changes jsonb := '{}';
  v_col     text;
  v_session uuid;
  v_account uuid;
  v_label   text;
BEGIN
  v_old := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END;
  v_new := CASE WHEN TG_OP IN ('UPDATE', 'INSERT') THEN to_jsonb(NEW) END;
  v_row := coalesce(v_new, v_old);
  v_session := (v_row ->> 'session_id')::uuid;
  SELECT account_id, coalesce(nullif(display_phone_number, ''), phone_number_id, 'Número')
    INTO v_account, v_label
  FROM wacrm.whatsapp_config WHERE id = v_session;
  v_account := coalesce((v_row ->> 'account_id')::uuid, v_account);
  IF v_account IS NULL THEN RETURN coalesce(NEW, OLD); END IF;

  IF TG_OP = 'UPDATE' THEN
    FOREACH v_col IN ARRAY v_cols LOOP
      IF (v_old -> v_col) IS DISTINCT FROM (v_new -> v_col) THEN
        v_changes := v_changes || jsonb_build_object(v_col, jsonb_build_object('before', v_old -> v_col, 'after', v_new -> v_col));
      END IF;
    END LOOP;
    IF v_changes = '{}' THEN RETURN NEW; END IF;
  ELSIF TG_OP = 'INSERT' THEN
    FOREACH v_col IN ARRAY v_cols LOOP
      IF (v_new -> v_col) IS NOT NULL AND (v_new -> v_col) <> 'null'::jsonb THEN
        v_changes := v_changes || jsonb_build_object(v_col, jsonb_build_object('before', NULL, 'after', v_new -> v_col));
      END IF;
    END LOOP;
  END IF;

  PERFORM wacrm.audit_write(
    v_account,
    CASE TG_OP WHEN 'INSERT' THEN 'created' WHEN 'DELETE' THEN 'deleted' ELSE 'updated' END,
    v_type,
    v_session,
    v_label,
    v_type || CASE TG_OP WHEN 'INSERT' THEN '.created' WHEN 'DELETE' THEN '.deleted' ELSE '.updated' END,
    format('%s do número %s %s', v_noun, v_label,
      CASE TG_OP WHEN 'INSERT' THEN 'criado' WHEN 'DELETE' THEN 'removido' ELSE
        'alterado (' || coalesce((SELECT string_agg(k, ', ') FROM jsonb_object_keys(v_changes) k), '') || ')' END),
    CASE WHEN v_changes = '{}' THEN NULL ELSE v_changes END
  );
  RETURN coalesce(NEW, OLD);
EXCEPTION WHEN others THEN
  -- Auditoria nunca derruba a escrita original.
  RAISE WARNING 'audit_dispatch_rate_changes falhou: %', SQLERRM;
  RETURN coalesce(NEW, OLD);
END;
$$;
REVOKE ALL ON FUNCTION wacrm.audit_dispatch_rate_changes() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_audit_dispatch_channel_limits ON wacrm.dispatch_channel_limits;
CREATE TRIGGER trg_audit_dispatch_channel_limits
  AFTER INSERT OR UPDATE OR DELETE ON wacrm.dispatch_channel_limits
  FOR EACH ROW EXECUTE FUNCTION wacrm.audit_dispatch_rate_changes('dispatch_channel_limits', 'Limites de envio', 'max_in_flight,hourly_limit');

DROP TRIGGER IF EXISTS trg_audit_dispatch_channel_rate ON wacrm.dispatch_channel_rate;
CREATE TRIGGER trg_audit_dispatch_channel_rate
  AFTER INSERT OR UPDATE OR DELETE ON wacrm.dispatch_channel_rate
  FOR EACH ROW EXECUTE FUNCTION wacrm.audit_dispatch_rate_changes(
    'dispatch_channel_rate', 'Limite por segundo',
    'auto_rate_per_second,manual_rate_per_second,manual_reason,force_above_quality');

NOTIFY pgrst, 'reload schema';

COMMIT;
