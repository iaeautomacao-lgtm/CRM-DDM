-- ============================================================
-- 176_ai_tools.sql
--
-- Catálogo de FERRAMENTAS reutilizáveis dos agentes de IA (fase 2).
--
-- Antes: a ferramenta (chamada HTTP que o agente faz durante a conversa)
-- ficava copiada dentro de cada nó de IA (flow_nodes.config.tools). Agora ela
-- é um cadastro da conta; o nó referencia por id (config.tool_refs) e cada
-- ferramenta tem LIGA/DESLIGA (enabled): desligada some da lista que o modelo
-- recebe, sem editar fluxo nenhum.
--
--  - name        : nome da função para o modelo ^[a-z][a-z0-9_]{1,63}$, único por conta.
--  - parameters  : {type:'object', properties, required} (mesmo shape do inline).
--  - http        : {url, method, headers?, body?} (mesmo shape do AiAgentTool.http).
--                  NUNCA credencial literal: use {{cred.NOME}} (migration 175);
--                  a rota recusa token/Authorization em texto.
--  - timeout_ms  : 1000–60000 (padrão 30000 = valor atual do código).
--
-- Acesso: RLS ligada, sem policy, REVOKE de anon/authenticated (igual à 175);
-- tudo por /api/settings/tools (service role, papel owner/admin p/ escrever).
--
-- PRÉ-CHECK (deve devolver NULL — a tabela ainda não existe):
--   SELECT to_regclass('wacrm.ai_tools');
--   SELECT to_regclass('wacrm.accounts');   -- deve existir
--
-- ORDEM: aplicar ANTES do deploy do código. Idempotente.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.accounts') IS NULL THEN
    RAISE EXCEPTION 'wacrm.accounts não existe';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS wacrm.ai_tools (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  name         text NOT NULL,
  display_name text NOT NULL,
  description  text NOT NULL,
  parameters   jsonb NOT NULL DEFAULT '{"type":"object","properties":{}}'::jsonb,
  http         jsonb NOT NULL,
  timeout_ms   integer NOT NULL DEFAULT 30000,
  enabled      boolean NOT NULL DEFAULT true,
  created_by   uuid,
  updated_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_tools_name_format CHECK (name ~ '^[a-z][a-z0-9_]{1,63}$'),
  CONSTRAINT ai_tools_unique_name UNIQUE (account_id, name),
  CONSTRAINT ai_tools_timeout_range CHECK (timeout_ms BETWEEN 1000 AND 60000),
  -- COALESCE(..., false): campo ausente dá NULL e um CHECK deixa NULL passar.
  CONSTRAINT ai_tools_parameters_shape CHECK (COALESCE(
    jsonb_typeof(parameters) = 'object' AND parameters ->> 'type' = 'object', false
  )),
  CONSTRAINT ai_tools_http_shape CHECK (COALESCE(
    jsonb_typeof(http) = 'object'
    AND jsonb_typeof(http -> 'url') = 'string'
    AND (http ->> 'url') LIKE 'https://%'
    AND (http ->> 'method') IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE'), false
  ))
);

CREATE INDEX IF NOT EXISTS idx_ai_tools_account ON wacrm.ai_tools (account_id);

ALTER TABLE wacrm.ai_tools ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.ai_tools FROM PUBLIC, anon, authenticated;
GRANT ALL ON wacrm.ai_tools TO service_role;

-- Auditoria (sem URL/headers/body): só se o trigger genérico da 131 existir.
DO $$
BEGIN
  IF to_regprocedure('wacrm.audit_generic_changes()') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_audit_ai_tools ON wacrm.ai_tools';
    EXECUTE $t$CREATE TRIGGER trg_audit_ai_tools
      AFTER INSERT OR UPDATE OR DELETE ON wacrm.ai_tools
      FOR EACH ROW EXECUTE FUNCTION wacrm.audit_generic_changes(
        'ai_tool', 'Ferramenta de IA', 'name', 'name,display_name,enabled,description,timeout_ms')$t$;
  END IF;
EXCEPTION WHEN others THEN
  RAISE WARNING 'trigger de auditoria de ai_tools não criado: %', SQLERRM;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
