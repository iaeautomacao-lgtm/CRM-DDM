-- ============================================================
-- 154_personal_api_keys_mcp.sql — chaves de API pessoais para o MCP do
-- DDM Intelligence (PRD-04, Fase 3).
-- APLICAR MANUALMENTE no Supabase SQL Editor ANTES do deploy: o caminho de
-- autenticação da API pública (findActiveKeyByHash) passa a ler
-- api_keys.user_id — sem a coluna TODAS as chaves (/api/v1 e /api/mcp)
-- deixam de autenticar.
-- Conferir o schema live antes (CLAUDE.md): wacrm.api_keys (026) e
-- wacrm.intelligence_tool_calls (141) precisam existir.
--
-- 1. api_keys.user_id
--    Chave pessoal: ligada a um usuário. O escopo `intelligence:read`
--    (src/lib/api-keys/scopes.ts) só vale com user_id — o servidor recalcula
--    a cada requisição o papel e as equipes desse usuário na conta da chave
--    (owner/admin → conta toda; supervisor → equipes dele; demais → 403).
--    ON DELETE CASCADE: usuário apagado leva junto as chaves pessoais.
--    Chaves da conta (as de /api/v1) continuam com user_id NULL.
--    O CHECK garante no banco que nenhuma chave com intelligence:read
--    fique sem dono.
--
-- 2. intelligence_tool_calls.origin / api_key_id
--    Origem da chamada auditada ('api' = POST /api/intelligence/tools/*,
--    'chat' = chat do /inteligencia, 'mcp' = /api/mcp) e a chave usada.
--    Nulos nas linhas antigas e nos caminhos que não informam.
--
-- RLS de api_keys não muda: escrita direta segue admin+. A criação e a
-- revogação da chave pessoal pelo próprio supervisor passam pela rota
-- /api/account/api-keys, que valida papel, dono e escopo no servidor.
--
-- Idempotente.
-- ============================================================

BEGIN;

SET search_path TO wacrm, public, extensions;

ALTER TABLE wacrm.api_keys
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;

COMMENT ON COLUMN wacrm.api_keys.user_id IS
  'Dono da chave pessoal (MCP / intelligence:read). NULL = chave da conta.';

CREATE INDEX IF NOT EXISTS api_keys_user_id_idx
  ON wacrm.api_keys (user_id)
  WHERE user_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'api_keys_intelligence_requires_user'
      AND conrelid = 'wacrm.api_keys'::regclass
  ) THEN
    ALTER TABLE wacrm.api_keys
      ADD CONSTRAINT api_keys_intelligence_requires_user
      CHECK (NOT ('intelligence:read' = ANY (scopes)) OR user_id IS NOT NULL);
  END IF;
END
$$;

ALTER TABLE wacrm.intelligence_tool_calls
  ADD COLUMN IF NOT EXISTS origin text,
  ADD COLUMN IF NOT EXISTS api_key_id uuid REFERENCES wacrm.api_keys(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'intelligence_tool_calls_origin_check'
      AND conrelid = 'wacrm.intelligence_tool_calls'::regclass
  ) THEN
    ALTER TABLE wacrm.intelligence_tool_calls
      ADD CONSTRAINT intelligence_tool_calls_origin_check
      CHECK (origin IS NULL OR origin IN ('api', 'chat', 'mcp'));
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
