-- Migration 148: histórico de versões do prompt da IA (PRD 02, Fase A).
-- APLICAR MANUALMENTE no Supabase SQL Editor ANTES do deploy (a rota
-- GET /api/ai/prompt-versions lê esta tabela; sem ela a tela de histórico
-- só aparece vazia e salvar continua funcionando — gravar versão é
-- best-effort). Conferir o schema live antes (CLAUDE.md).
--
-- Guarda cada texto distinto de:
--   scope 'account'   → wacrm.ai_config.system_prompt (Configurações → IA)
--   scope 'flow_node' → wacrm.flow_nodes.config->>'system_prompt_override'
--                       dos nós ai_agent (editor de fluxos), por flow_id +
--                       node_key
-- content_hash = sha256 (hex) do texto exatamente como gravado; os 12
-- primeiros caracteres são a "versão" mostrada na tela e usada em
-- ai_decisions.prompt_version. Salvar o mesmo texto de novo NÃO cria
-- linha nova: o servidor só atualiza last_saved_at/last_saved_by (índice
-- único abaixo), então restaurar uma versão antiga a traz de volta para
-- o topo da lista.
--
-- Leitura: owner/admin da conta (mesmo público de /settings e /flows).
-- Escrita: só o servidor (service_role) — sem policy de escrita.

BEGIN;

CREATE TABLE IF NOT EXISTS wacrm.ai_prompt_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('account', 'flow_node')),
  flow_id uuid REFERENCES wacrm.flows(id) ON DELETE CASCADE,
  node_key text,
  content text NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  source text NOT NULL DEFAULT 'ui'
    CHECK (source IN ('ui', 'migration', 'restore', 'backfill')),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_saved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  last_saved_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_prompt_versions_scope_target CHECK (
    (scope = 'account' AND flow_id IS NULL AND node_key IS NULL)
    OR (scope = 'flow_node' AND flow_id IS NOT NULL AND node_key IS NOT NULL)
  )
);

-- Mesmo texto no mesmo alvo = mesma versão.
CREATE UNIQUE INDEX IF NOT EXISTS ai_prompt_versions_unique_content
  ON wacrm.ai_prompt_versions (
    account_id,
    scope,
    COALESCE(flow_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(node_key, ''),
    content_hash
  );

-- Listagem da tela (mais recentes primeiro) e busca pelo hash curto.
CREATE INDEX IF NOT EXISTS ai_prompt_versions_target_idx
  ON wacrm.ai_prompt_versions (account_id, scope, flow_id, node_key, last_saved_at DESC);
CREATE INDEX IF NOT EXISTS ai_prompt_versions_hash_idx
  ON wacrm.ai_prompt_versions (account_id, (left(content_hash, 12)));

ALTER TABLE wacrm.ai_prompt_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_prompt_versions_select ON wacrm.ai_prompt_versions;
CREATE POLICY ai_prompt_versions_select ON wacrm.ai_prompt_versions
  FOR SELECT USING (wacrm.is_account_member(account_id, 'admin'));

GRANT SELECT ON wacrm.ai_prompt_versions TO authenticated;
GRANT ALL ON wacrm.ai_prompt_versions TO service_role;

-- ---- backfill: o que está no ar hoje vira a primeira versão ----------
INSERT INTO wacrm.ai_prompt_versions
  (account_id, scope, content, content_hash, source, created_at, last_saved_at)
SELECT
  c.account_id,
  'account',
  c.system_prompt,
  encode(sha256(convert_to(c.system_prompt, 'UTF8')), 'hex'),
  'backfill',
  COALESCE(c.updated_at, now()),
  COALESCE(c.updated_at, now())
FROM wacrm.ai_config c
WHERE c.account_id IS NOT NULL
  AND btrim(COALESCE(c.system_prompt, '')) <> ''
ON CONFLICT DO NOTHING;

INSERT INTO wacrm.ai_prompt_versions
  (account_id, scope, flow_id, node_key, content, content_hash, source, created_at, last_saved_at)
SELECT
  f.account_id,
  'flow_node',
  n.flow_id,
  n.node_key,
  n.config->>'system_prompt_override',
  encode(sha256(convert_to(n.config->>'system_prompt_override', 'UTF8')), 'hex'),
  'backfill',
  COALESCE(f.updated_at, now()),
  COALESCE(f.updated_at, now())
FROM wacrm.flow_nodes n
JOIN wacrm.flows f ON f.id = n.flow_id
WHERE n.node_type = 'ai_agent'
  AND f.account_id IS NOT NULL
  AND btrim(COALESCE(n.config->>'system_prompt_override', '')) <> ''
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
COMMIT;
