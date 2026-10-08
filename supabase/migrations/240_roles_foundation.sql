-- ============================================================
-- 240_roles_foundation.sql   (PRD 20, fase 20.2 — fundação dos papéis, SEM mudança de comportamento)
--
-- O que faz:
--   1. wacrm.permission_catalog  — catálogo fechado de permissões (seed = src/lib/auth/permissions.ts).
--   2. wacrm.account_roles       — papéis como linhas. account_id NULL = papel de SISTEMA (os 5 de hoje, semeados);
--                                  preenchido = papel personalizado (ainda não existe nenhum; a criação vem em fase posterior).
--   3. wacrm.role_permissions    — permissões de cada papel. Os 5 papéis de sistema recebem o conjunto IDÊNTICO ao
--                                  comportamento de hoje (os mesmos conjuntos de SYSTEM_ROLE_PERMISSIONS, já expandidos).
--   4. wacrm.profiles.role_id    — vínculo do perfil ao papel (nullable) + BACKFILL dos perfis existentes.
--   5. Trigger wacrm.profiles_sync_role — sincronia account_role ⇄ role_id nos DOIS sentidos, para migrar sem downtime:
--        código antigo + banco novo  → quem só escreve account_role (RPCs legadas) ganha role_id = papel de sistema;
--        código novo  + banco antigo → a coluna role_id simplesmente não existe/é ignorada.
--      Só BEFORE: o trigger mexe apenas em NEW, então não há laço.
--   6. Trigger wacrm.profiles_guard_role_id — defesa em profundidade: anon/authenticated não gravam role_id
--      (como a 169 faz com account_role/account_id; a escrita já é barrada por GRANT por coluna).
--   Nada nesta migration muda o que um usuário pode ou não fazer: nenhuma policy nem RPC usa as tabelas novas ainda.
--
-- ORDEM: aplicar ANTES do deploy do código da 20.2 (o código antigo ignora tudo isto). Depois, a 241 e a 241b.
-- Idempotente — pode rodar mais de uma vez. PRÉ-CHECK vivo: aborta SEM alterar nada se o schema não for o esperado.
-- Conferir o schema vivo antes (drift public × wacrm; migration files podem não refletir produção).
--
-- PRÉ-CHECK (rodar antes e conferir):
--   SELECT to_regclass('wacrm.profiles'), to_regclass('wacrm.accounts');                    -- ambos não nulos
--   SELECT n.nspname, enum_range(NULL::wacrm.account_role_enum)
--     FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'account_role_enum';
--     -- ordem esperada: {owner,admin,supervisor,agent,viewer} (ou com o supervisor entre admin e agent)
--   SELECT to_regclass('wacrm.account_roles'), to_regclass('wacrm.permission_catalog'), to_regclass('wacrm.role_permissions');
--     -- todos NULL na primeira execução (se algum existir, o pré-check confere o formato e aborta se for outro)
--   SELECT account_role, count(*) FROM wacrm.profiles GROUP BY 1 ORDER BY 1;               -- guarde o resultado
--
-- VERIFICAÇÃO PÓS-APLICAÇÃO (todas devem dar 0, exceto a 1ª e a 2ª):
--   SELECT count(*) FROM wacrm.account_roles WHERE account_id IS NULL;                      -- 5
--   SELECT count(*) FROM wacrm.permission_catalog;                                           -- = nº de chaves do catálogo (63 nesta versão)
--   SELECT count(*) FROM wacrm.profiles WHERE role_id IS NULL;                               -- 0  (backfill completo)
--   SELECT count(*) FROM wacrm.profiles p JOIN wacrm.account_roles r ON r.id = p.role_id
--     WHERE r.compat_role <> p.account_role::text;                                           -- 0  (os dois lados concordam)
--   SELECT count(*) FROM wacrm.profiles p JOIN wacrm.account_roles r ON r.id = p.role_id
--     WHERE r.account_id IS NOT NULL AND r.account_id <> p.account_id;                       -- 0
--   SELECT r.key, count(*) FROM wacrm.account_roles r JOIN wacrm.role_permissions rp ON rp.role_id = r.id
--     WHERE r.account_id IS NULL GROUP BY 1 ORDER BY 1;                                      -- compare com SYSTEM_ROLE_PERMISSIONS (o teste PGlite faz isso)
--
-- ROLLBACK (devolve ao estado anterior; a 241/241b devem ser desfeitas antes — ver o cabeçalho delas):
--   BEGIN;
--   DROP TRIGGER IF EXISTS profiles_sync_role ON wacrm.profiles;
--   DROP TRIGGER IF EXISTS profiles_guard_role_id ON wacrm.profiles;
--   DROP FUNCTION IF EXISTS wacrm.profiles_sync_role();
--   DROP FUNCTION IF EXISTS wacrm.profiles_guard_role_id();
--   ALTER TABLE wacrm.profiles DROP COLUMN IF EXISTS role_id;
--   DROP TABLE IF EXISTS wacrm.role_permissions;
--   DROP TABLE IF EXISTS wacrm.account_roles;
--   DROP TABLE IF EXISTS wacrm.permission_catalog;
--   COMMIT;
--   NOTIFY pgrst, 'reload schema';
--
-- Efeito colateral conhecido: o backfill faz UPDATE em todos os profiles (só role_id), então `updated_at` deles vai
-- para "agora" e, se o trigger de auditoria de profiles estiver ativo, grava uma linha por perfil.
-- ============================================================

BEGIN;

-- ---- PRÉ-CHECK (aborta sem alterar nada) ----------------------------------------------------------------------
DO $$
DECLARE
  v_missing text;
BEGIN
  IF to_regclass('wacrm.profiles') IS NULL THEN
    RAISE EXCEPTION '240: falta wacrm.profiles (migrations 001/017)';
  END IF;
  IF to_regclass('wacrm.accounts') IS NULL THEN
    RAISE EXCEPTION '240: falta wacrm.accounts (migration 017)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'wacrm' AND table_name = 'profiles' AND column_name = 'account_role'
  ) THEN
    RAISE EXCEPTION '240: falta wacrm.profiles.account_role (migration 017)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'wacrm' AND table_name = 'profiles' AND column_name = 'account_id'
  ) THEN
    RAISE EXCEPTION '240: falta wacrm.profiles.account_id (migration 017)';
  END IF;
  IF to_regprocedure('wacrm.current_account_id()') IS NULL THEN
    RAISE EXCEPTION '240: falta wacrm.current_account_id() (migration 170)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'account_role_enum') THEN
    RAISE EXCEPTION '240: account_role_enum não encontrado (migration 017)';
  END IF;
  -- Todos os valores atuais do enum precisam ser papéis que esta migration semeia.
  SELECT string_agg(e.enumlabel, ', ') INTO v_missing
    FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
   WHERE t.typname = 'account_role_enum'
     AND e.enumlabel NOT IN ('owner', 'admin', 'supervisor', 'agent', 'viewer');
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '240: account_role_enum tem valores sem papel de sistema semeado: %', v_missing;
  END IF;
  -- Se as tabelas novas já existem, precisam ter o formato esperado (outro formato = drift: pare e avise).
  IF to_regclass('wacrm.account_roles') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'wacrm' AND table_name = 'account_roles' AND column_name = 'compat_role'
  ) THEN
    RAISE EXCEPTION '240: wacrm.account_roles já existe com outro formato — nada foi alterado';
  END IF;
  IF to_regclass('wacrm.permission_catalog') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'wacrm' AND table_name = 'permission_catalog' AND column_name = 'group_name'
  ) THEN
    RAISE EXCEPTION '240: wacrm.permission_catalog já existe com outro formato — nada foi alterado';
  END IF;
END $$;

-- ---- Catálogo --------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wacrm.permission_catalog (
  key         text PRIMARY KEY,
  label       text NOT NULL,
  description text NOT NULL,
  group_name  text NOT NULL,
  scope       text NOT NULL CHECK (scope IN ('account', 'team', 'own', 'n/a')),
  owner_only  boolean NOT NULL DEFAULT false,
  grantable   boolean NOT NULL DEFAULT true,
  depends_on  text[] NOT NULL DEFAULT '{}',
  sort        integer NOT NULL DEFAULT 0
);

-- ---- Papéis (linhas) -------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wacrm.account_roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid REFERENCES wacrm.accounts(id) ON DELETE CASCADE,        -- NULL = papel de sistema
  key         text NOT NULL,
  name        text NOT NULL,
  description text,
  kind        text NOT NULL CHECK (kind IN ('system', 'custom')),
  rank        integer NOT NULL,                                            -- sistema: 5..1
  compat_role text NOT NULL CHECK (compat_role IN ('owner', 'admin', 'supervisor', 'agent', 'viewer')),
  is_default  boolean NOT NULL DEFAULT false,
  created_by  uuid,
  updated_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_roles_kind_account CHECK ((kind = 'system') = (account_id IS NULL)),
  CONSTRAINT account_roles_account_key UNIQUE (account_id, key)
);
-- UNIQUE (account_id, key) não barra duplicata quando account_id é NULL: índice parcial para os papéis de sistema.
CREATE UNIQUE INDEX IF NOT EXISTS uq_account_roles_system_key ON wacrm.account_roles (key) WHERE account_id IS NULL;

CREATE TABLE IF NOT EXISTS wacrm.role_permissions (
  role_id    uuid NOT NULL REFERENCES wacrm.account_roles(id) ON DELETE CASCADE,
  permission text NOT NULL REFERENCES wacrm.permission_catalog(key) ON UPDATE CASCADE ON DELETE RESTRICT,
  PRIMARY KEY (role_id, permission)
);

-- Leitura para o usuário logado (os papéis da própria conta e os de sistema); escrita só por service_role/RPCs.
ALTER TABLE wacrm.permission_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE wacrm.account_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE wacrm.role_permissions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON wacrm.permission_catalog, wacrm.account_roles, wacrm.role_permissions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON wacrm.permission_catalog, wacrm.account_roles, wacrm.role_permissions TO authenticated;
GRANT ALL ON wacrm.permission_catalog, wacrm.account_roles, wacrm.role_permissions TO service_role;

DROP POLICY IF EXISTS permission_catalog_select ON wacrm.permission_catalog;
CREATE POLICY permission_catalog_select ON wacrm.permission_catalog FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS account_roles_select ON wacrm.account_roles;
CREATE POLICY account_roles_select ON wacrm.account_roles FOR SELECT TO authenticated
  USING (account_id IS NULL OR account_id = (SELECT wacrm.current_account_id()));

DROP POLICY IF EXISTS role_permissions_select ON wacrm.role_permissions;
CREATE POLICY role_permissions_select ON wacrm.role_permissions FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM wacrm.account_roles r
     WHERE r.id = role_permissions.role_id
       AND (r.account_id IS NULL OR r.account_id = (SELECT wacrm.current_account_id()))
  ));

-- ---- Seed: catálogo ---------------------------------------------------------------------------------------------
INSERT INTO wacrm.permission_catalog (key, label, description, group_name, scope, owner_only, grantable, depends_on, sort) VALUES
  ('inbox.view', 'Ver conversas', 'Acessar o Inbox (o nível — todas, da equipe ou próprias — vem de conversations.scope_*).', 'Inbox', 'own', false, true, '{}'::text[], 10),
  ('inbox.reply', 'Responder', 'Enviar mensagens, reagir e registrar notas.', 'Inbox', 'n/a', false, true, ARRAY['inbox.view']::text[], 20),
  ('inbox.transfer', 'Transferir conversa', 'Transferir uma conversa para outra equipe ou atendente.', 'Inbox', 'n/a', false, true, ARRAY['inbox.view']::text[], 30),
  ('inbox.close', 'Encerrar e tabular', 'Encerrar a conversa e aplicar tabulação.', 'Inbox', 'n/a', false, true, ARRAY['inbox.view']::text[], 40),
  ('inbox.delete_conversation', 'Excluir conversa', 'Excluir definitivamente uma conversa.', 'Inbox', 'n/a', false, true, ARRAY['inbox.view']::text[], 50),
  ('inbox.ai_assist', 'Assistente de IA no atendimento', 'Análise de sentimento e sugestão de tag.', 'Inbox', 'n/a', false, true, ARRAY['inbox.view']::text[], 60),
  ('inbox.receive_assignments', 'Receber atribuições', 'Pode receber conversas por atribuição e por handoff (hoje: só o papel Operador).', 'Inbox', 'n/a', false, true, '{}'::text[], 70),
  ('inbox.quick_replies.manage', 'Gerenciar respostas rápidas', 'Cadastrar e editar respostas rápidas.', 'Inbox', 'n/a', false, true, '{}'::text[], 80),
  ('calls.use', 'Chamadas de voz', 'Usar o VoIP.', 'Inbox', 'n/a', false, true, '{}'::text[], 90),
  ('conversations.scope_all', 'Ver todas as conversas da organização', 'Visibilidade total de conversas.', 'Inbox', 'account', false, true, '{}'::text[], 100),
  ('conversations.scope_team', 'Ver as conversas das equipes dele', 'Sem escopo amplo, só as dele e a fila da equipe (nível do operador).', 'Inbox', 'team', false, true, '{}'::text[], 110),
  ('contacts.view', 'Ver contatos', 'Listar e abrir contatos.', 'Contatos', 'account', false, true, '{}'::text[], 120),
  ('contacts.edit', 'Editar contatos', 'Criar, editar e vincular contatos.', 'Contatos', 'n/a', false, true, ARRAY['contacts.view']::text[], 130),
  ('contacts.import', 'Importar contatos', 'Importar contatos (cria tags).', 'Contatos', 'n/a', false, true, ARRAY['contacts.edit']::text[], 140),
  ('tags.manage', 'Gerenciar tags e tabulações', 'Tags, tabulações e campos personalizados.', 'Contatos', 'n/a', false, true, '{}'::text[], 150),
  ('pipelines.manage', 'Gerenciar funis', 'Funis, etapas e regras de negócio do CRM.', 'Contatos', 'n/a', false, true, '{}'::text[], 160),
  ('dashboard.view', 'Dashboard', 'Ver o dashboard.', 'Acompanhamento', 'account', false, true, '{}'::text[], 170),
  ('monitoring.view_team', 'Monitoramento (equipes)', 'Monitorar as equipes dele.', 'Acompanhamento', 'team', false, true, '{}'::text[], 180),
  ('monitoring.view_all', 'Monitoramento (organização)', 'Monitorar a organização toda.', 'Acompanhamento', 'account', false, true, ARRAY['monitoring.view_team']::text[], 190),
  ('monitoring.assign', 'Reatribuir no monitoramento', 'Arrastar/reatribuir conversas.', 'Acompanhamento', 'n/a', false, true, ARRAY['monitoring.view_all']::text[], 200),
  ('reports.view_team', 'Relatórios (equipes)', 'Atendimentos, conversas, tabulações e agentes das equipes dele.', 'Acompanhamento', 'team', false, true, '{}'::text[], 210),
  ('reports.view_all', 'Relatórios (organização)', 'Relatórios da organização toda, inclusive envio em lote.', 'Acompanhamento', 'account', false, true, ARRAY['reports.view_team']::text[], 220),
  ('reports.export', 'Gerar exportações', 'Gerar e registrar exportações.', 'Acompanhamento', 'n/a', false, true, ARRAY['reports.view_team']::text[], 230),
  ('exports.manage', 'Gerenciar exportações', 'Listar e apagar exportações geradas.', 'Acompanhamento', 'n/a', false, true, ARRAY['reports.export']::text[], 240),
  ('audit.view', 'Auditoria e logs', 'Ver a auditoria e os logs.', 'Acompanhamento', 'account', false, true, '{}'::text[], 250),
  ('intelligence.use', 'DDM Intelligence', 'Chat, ferramentas e MCP (escopo das equipes dele).', 'Intelligence', 'team', false, true, '{}'::text[], 260),
  ('intelligence.scope_account', 'Intelligence da organização toda', 'Sem isso, só as equipes dele.', 'Intelligence', 'account', false, true, ARRAY['intelligence.use']::text[], 270),
  ('intelligence.personal_key', 'Chave pessoal do MCP', 'Criar a própria chave de acesso ao Intelligence.', 'Intelligence', 'own', false, true, ARRAY['intelligence.use']::text[], 280),
  ('campaigns.manage', 'Disparador', 'Criar, editar, iniciar e pausar campanhas; listas, métricas, erros e UTM.', 'Disparador', 'n/a', false, true, ARRAY['channels.view']::text[], 290),
  ('campaigns.rate_limit', 'Limites de envio', 'Vagas e limite por segundo por número; reconhecer avisos de qualidade.', 'Disparador', 'n/a', false, true, ARRAY['campaigns.manage']::text[], 300),
  ('campaigns.red_quality_override', 'Número em qualidade vermelha', 'Iniciar campanha em número vermelho e alterar a política de qualidade.', 'Disparador', 'n/a', true, false, ARRAY['campaigns.manage']::text[], 310),
  ('flows.edit', 'Editar fluxos', 'Criar, editar, ativar e importar fluxos.', 'Fluxos e IA', 'n/a', false, true, ARRAY['automations.view']::text[], 320),
  ('flows.view_runs', 'Ver execuções de fluxo', 'Ver o fluxo que rodou numa conversa e o histórico de execuções.', 'Fluxos e IA', 'n/a', false, true, '{}'::text[], 330),
  ('flows.simulate', 'Simulador de fluxo', 'Usar o simulador (leitura real de credencial exige secrets.write).', 'Fluxos e IA', 'n/a', false, true, '{}'::text[], 340),
  ('automations.view', 'Ver automações', 'Listar automações.', 'Fluxos e IA', 'n/a', false, true, '{}'::text[], 350),
  ('automations.edit', 'Editar automações', 'Criar, editar e apagar automações.', 'Fluxos e IA', 'n/a', false, true, ARRAY['automations.view']::text[], 360),
  ('ai.config', 'Configuração da IA', 'Chave, prompt e liga/desliga da IA da organização.', 'Fluxos e IA', 'n/a', false, true, '{}'::text[], 370),
  ('ai.agents.view', 'Ver agentes de IA', 'Listar e pré-visualizar perfis de agente.', 'Fluxos e IA', 'n/a', false, true, '{}'::text[], 380),
  ('ai.agents.edit', 'Editar agentes de IA', 'Criar, editar, publicar e reverter perfis de agente.', 'Fluxos e IA', 'n/a', false, true, ARRAY['ai.agents.view']::text[], 390),
  ('ai.tools.view', 'Ver ferramentas de IA', 'Listar ferramentas dos agentes.', 'Fluxos e IA', 'n/a', false, true, '{}'::text[], 400),
  ('ai.tools.edit', 'Editar ferramentas de IA', 'Criar, editar, testar e apagar ferramentas.', 'Fluxos e IA', 'n/a', false, true, ARRAY['ai.tools.view']::text[], 410),
  ('secrets.view_meta', 'Ver variáveis e credenciais', 'Listar nomes, hosts e últimos 4 dígitos (o valor nunca volta).', 'Fluxos e IA', 'n/a', false, true, '{}'::text[], 420),
  ('secrets.write', 'Gravar variáveis e credenciais', 'Criar, trocar e apagar variáveis e credenciais.', 'Fluxos e IA', 'n/a', false, true, ARRAY['secrets.view_meta']::text[], 430),
  ('channels.view', 'Ver canais', 'Listar linhas/canais (equipes para operador e supervisor).', 'Canais', 'team', false, true, '{}'::text[], 440),
  ('channels.manage', 'Gerenciar canais', 'Conectar, configurar, WAHA, webchat e tokens.', 'Canais', 'n/a', false, true, ARRAY['channels.view']::text[], 450),
  ('templates.view', 'Ver templates', 'Listar templates e pastas.', 'Canais', 'n/a', false, true, '{}'::text[], 460),
  ('templates.manage', 'Gerenciar templates', 'Criar, editar, sincronizar e apagar templates Meta e pastas.', 'Canais', 'n/a', false, true, ARRAY['templates.view']::text[], 470),
  ('teams.view', 'Ver equipes', 'Listar equipes e membros.', 'Pessoas', 'n/a', false, true, '{}'::text[], 480),
  ('teams.manage', 'Gerenciar equipes', 'Criar equipes e gerir membros de equipe.', 'Pessoas', 'n/a', false, true, ARRAY['teams.view']::text[], 490),
  ('members.view', 'Ver membros', 'Listar membros (nome, avatar, papel).', 'Pessoas', 'n/a', false, true, '{}'::text[], 500),
  ('members.view_emails', 'Ver e-mails dos membros', 'Ver o e-mail de cada membro.', 'Pessoas', 'n/a', false, true, ARRAY['members.view']::text[], 510),
  ('members.invite', 'Convidar membros', 'Criar e revogar convites.', 'Pessoas', 'n/a', false, true, ARRAY['members.view']::text[], 520),
  ('members.manage', 'Gerir membros', 'Mudar papel, equipe e limite de chats; desativar membro.', 'Pessoas', 'n/a', false, true, ARRAY['members.view']::text[], 530),
  ('members.reset_password', 'Redefinir senha de outro membro', 'Trocar a senha de um membro.', 'Pessoas', 'n/a', true, false, '{}'::text[], 540),
  ('members.bulk_invite', 'Convite em lote', 'Criar vários membros de uma vez.', 'Pessoas', 'n/a', true, false, '{}'::text[], 550),
  ('ownership.transfer', 'Transferir a propriedade', 'Passar a organização a outro membro.', 'Pessoas', 'n/a', true, false, '{}'::text[], 560),
  ('account.delete', 'Excluir a organização', 'Excluir a organização e seus dados.', 'Pessoas', 'n/a', true, false, '{}'::text[], 570),
  ('roles.manage', 'Gerir papéis personalizados', 'Criar, editar, apagar e atribuir papéis personalizados.', 'Pessoas', 'n/a', true, false, '{}'::text[], 580),
  ('account.view', 'Ver a organização', 'Ver nome e dados gerais da organização.', 'Organização', 'n/a', false, true, '{}'::text[], 590),
  ('settings.account', 'Configurações da organização', 'Nome e configurações gerais.', 'Organização', 'n/a', false, true, ARRAY['account.view']::text[], 600),
  ('api_keys.view', 'Ver chaves de API', 'Listar as chaves de API da organização (sem o segredo).', 'Organização', 'n/a', false, true, '{}'::text[], 610),
  ('api_keys.manage', 'Gerenciar chaves de API', 'Criar e revogar chaves de API.', 'Organização', 'n/a', false, true, ARRAY['api_keys.view']::text[], 620),
  ('integrations.manage', 'Integrações da organização', 'Chaves e integrações por organização (PRD 19).', 'Organização', 'n/a', false, true, '{}'::text[], 630)
ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, description = EXCLUDED.description, group_name = EXCLUDED.group_name,
  scope = EXCLUDED.scope, owner_only = EXCLUDED.owner_only, grantable = EXCLUDED.grantable, depends_on = EXCLUDED.depends_on, sort = EXCLUDED.sort;

-- ---- Seed: os 5 papéis de sistema (rank 5..1; compat_role = o próprio papel) -------------------------------------
INSERT INTO wacrm.account_roles (account_id, key, name, description, kind, rank, compat_role) VALUES
  (NULL, 'owner',      'Proprietário',  'Dono da organização: tudo, inclusive transferir a propriedade e excluir a organização.', 'system', 5, 'owner'),
  (NULL, 'admin',      'Administrador', 'Configura a organização e gerencia membros, canais, campanhas, fluxos e IA.',              'system', 4, 'admin'),
  (NULL, 'supervisor', 'Supervisor',    'Atende e acompanha as equipes dele (monitoramento e relatórios das equipes).',            'system', 3, 'supervisor'),
  (NULL, 'agent',      'Operador',      'Atende conversas (próprias e fila da equipe) e recebe atribuições.',                       'system', 2, 'agent'),
  (NULL, 'viewer',     'Visualizador',  'Somente leitura.',                                                                         'system', 1, 'viewer')
ON CONFLICT (key) WHERE account_id IS NULL DO NOTHING;

-- ---- Seed: permissões dos papéis de sistema ---------------------------------------------------------------------
-- role_permissions dos papéis de sistema: o conjunto EXPANDIDO de src/lib/auth/permissions.ts (SYSTEM_ROLE_PERMISSIONS).
INSERT INTO wacrm.role_permissions (role_id, permission)
SELECT r.id, p.permission FROM wacrm.account_roles r CROSS JOIN unnest(ARRAY[
  'account.view', 'api_keys.view', 'channels.view', 'contacts.view',
  'conversations.scope_all', 'conversations.scope_team', 'dashboard.view', 'members.view',
  'teams.view', 'templates.view'
]::text[]) AS p(permission)
WHERE r.account_id IS NULL AND r.key = 'viewer'
ON CONFLICT (role_id, permission) DO NOTHING;

INSERT INTO wacrm.role_permissions (role_id, permission)
SELECT r.id, p.permission FROM wacrm.account_roles r CROSS JOIN unnest(ARRAY[
  'account.view', 'api_keys.view', 'automations.view', 'calls.use',
  'channels.view', 'contacts.edit', 'contacts.view', 'inbox.ai_assist',
  'inbox.close', 'inbox.receive_assignments', 'inbox.reply', 'inbox.transfer',
  'inbox.view', 'members.view', 'teams.view', 'templates.view'
]::text[]) AS p(permission)
WHERE r.account_id IS NULL AND r.key = 'agent'
ON CONFLICT (role_id, permission) DO NOTHING;

INSERT INTO wacrm.role_permissions (role_id, permission)
SELECT r.id, p.permission FROM wacrm.account_roles r CROSS JOIN unnest(ARRAY[
  'account.view', 'ai.agents.view', 'ai.tools.view', 'api_keys.view',
  'automations.view', 'calls.use', 'channels.view', 'contacts.edit',
  'contacts.view', 'conversations.scope_team', 'dashboard.view', 'flows.simulate',
  'inbox.ai_assist', 'inbox.close', 'inbox.delete_conversation', 'inbox.reply',
  'inbox.transfer', 'inbox.view', 'intelligence.personal_key', 'intelligence.use',
  'members.view', 'monitoring.view_team', 'reports.export', 'reports.view_team',
  'secrets.view_meta', 'teams.view', 'templates.view'
]::text[]) AS p(permission)
WHERE r.account_id IS NULL AND r.key = 'supervisor'
ON CONFLICT (role_id, permission) DO NOTHING;

INSERT INTO wacrm.role_permissions (role_id, permission)
SELECT r.id, p.permission FROM wacrm.account_roles r CROSS JOIN unnest(ARRAY[
  'account.view', 'ai.agents.edit', 'ai.agents.view', 'ai.config',
  'ai.tools.edit', 'ai.tools.view', 'api_keys.manage', 'api_keys.view',
  'audit.view', 'automations.edit', 'automations.view', 'calls.use',
  'campaigns.manage', 'campaigns.rate_limit', 'channels.manage', 'channels.view',
  'contacts.edit', 'contacts.import', 'contacts.view', 'conversations.scope_all',
  'conversations.scope_team', 'dashboard.view', 'exports.manage', 'flows.edit',
  'flows.simulate', 'flows.view_runs', 'inbox.ai_assist', 'inbox.close',
  'inbox.delete_conversation', 'inbox.quick_replies.manage', 'inbox.reply', 'inbox.transfer',
  'inbox.view', 'integrations.manage', 'intelligence.personal_key', 'intelligence.scope_account',
  'intelligence.use', 'members.invite', 'members.manage', 'members.view',
  'members.view_emails', 'monitoring.assign', 'monitoring.view_all', 'monitoring.view_team',
  'pipelines.manage', 'reports.export', 'reports.view_all', 'reports.view_team',
  'secrets.view_meta', 'secrets.write', 'settings.account', 'tags.manage',
  'teams.manage', 'teams.view', 'templates.manage', 'templates.view'
]::text[]) AS p(permission)
WHERE r.account_id IS NULL AND r.key = 'admin'
ON CONFLICT (role_id, permission) DO NOTHING;

INSERT INTO wacrm.role_permissions (role_id, permission)
SELECT r.id, p.permission FROM wacrm.account_roles r CROSS JOIN unnest(ARRAY[
  'account.delete', 'account.view', 'ai.agents.edit', 'ai.agents.view',
  'ai.config', 'ai.tools.edit', 'ai.tools.view', 'api_keys.manage',
  'api_keys.view', 'audit.view', 'automations.edit', 'automations.view',
  'calls.use', 'campaigns.manage', 'campaigns.rate_limit', 'campaigns.red_quality_override',
  'channels.manage', 'channels.view', 'contacts.edit', 'contacts.import',
  'contacts.view', 'conversations.scope_all', 'conversations.scope_team', 'dashboard.view',
  'exports.manage', 'flows.edit', 'flows.simulate', 'flows.view_runs',
  'inbox.ai_assist', 'inbox.close', 'inbox.delete_conversation', 'inbox.quick_replies.manage',
  'inbox.reply', 'inbox.transfer', 'inbox.view', 'integrations.manage',
  'intelligence.personal_key', 'intelligence.scope_account', 'intelligence.use', 'members.bulk_invite',
  'members.invite', 'members.manage', 'members.reset_password', 'members.view',
  'members.view_emails', 'monitoring.assign', 'monitoring.view_all', 'monitoring.view_team',
  'ownership.transfer', 'pipelines.manage', 'reports.export', 'reports.view_all',
  'reports.view_team', 'roles.manage', 'secrets.view_meta', 'secrets.write',
  'settings.account', 'tags.manage', 'teams.manage', 'teams.view',
  'templates.manage', 'templates.view'
]::text[]) AS p(permission)
WHERE r.account_id IS NULL AND r.key = 'owner'
ON CONFLICT (role_id, permission) DO NOTHING;

-- ---- profiles.role_id --------------------------------------------------------------------------------------------
ALTER TABLE wacrm.profiles
  ADD COLUMN IF NOT EXISTS role_id uuid REFERENCES wacrm.account_roles(id) ON DELETE RESTRICT;

-- ---- Guard: só o servidor/RPCs gravam role_id --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wacrm.profiles_guard_role_id()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = wacrm, public
AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;
  IF (TG_OP = 'INSERT' AND NEW.role_id IS NOT NULL)
     OR (TG_OP = 'UPDATE' AND NEW.role_id IS DISTINCT FROM OLD.role_id) THEN
    RAISE EXCEPTION 'Alteração do papel do perfil não permitida' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION wacrm.profiles_guard_role_id() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS profiles_guard_role_id ON wacrm.profiles;
CREATE TRIGGER profiles_guard_role_id
  BEFORE INSERT OR UPDATE ON wacrm.profiles
  FOR EACH ROW EXECUTE FUNCTION wacrm.profiles_guard_role_id();

-- ---- Sincronia account_role ⇄ role_id ----------------------------------------------------------------------------
-- role_id mudou  → account_role = compat_role do papel (novo caminho; role_id vence se os dois mudarem);
-- só account_role mudou → role_id = papel de SISTEMA correspondente (RPC legada: troca de papel solta o personalizado);
-- role_id NULL em UPDATE → restaurado a partir de account_role. Papel personalizado de OUTRA conta é recusado.
CREATE OR REPLACE FUNCTION wacrm.profiles_sync_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wacrm, pg_catalog
AS $$
DECLARE
  v_role_changed boolean;
  v_legacy_changed boolean;
  v_compat text;
  v_role_account uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_role_changed := NEW.role_id IS NOT NULL;
    v_legacy_changed := NEW.account_role IS NOT NULL;
  ELSE
    v_role_changed := NEW.role_id IS DISTINCT FROM OLD.role_id;
    v_legacy_changed := NEW.account_role IS DISTINCT FROM OLD.account_role;
  END IF;

  IF NOT v_role_changed AND NOT v_legacy_changed THEN
    RETURN NEW;
  END IF;

  IF NEW.role_id IS NOT NULL AND v_role_changed THEN
    SELECT r.compat_role, r.account_id INTO v_compat, v_role_account
      FROM wacrm.account_roles r WHERE r.id = NEW.role_id;
    IF v_compat IS NULL THEN
      RAISE EXCEPTION 'role_id % não existe em account_roles', NEW.role_id USING ERRCODE = '23503';
    END IF;
    IF v_role_account IS NOT NULL AND v_role_account IS DISTINCT FROM NEW.account_id THEN
      RAISE EXCEPTION 'O papel % pertence a outra organização', NEW.role_id USING ERRCODE = '42501';
    END IF;
    IF NEW.account_role IS NULL OR NEW.account_role::text <> v_compat THEN
      NEW.account_role := v_compat;   -- text → enum (conversão de E/S na atribuição do plpgsql)
    END IF;
  ELSIF NEW.account_role IS NOT NULL THEN
    SELECT r.id INTO NEW.role_id
      FROM wacrm.account_roles r
     WHERE r.account_id IS NULL AND r.key = NEW.account_role::text;
  END IF;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION wacrm.profiles_sync_role() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS profiles_sync_role ON wacrm.profiles;
CREATE TRIGGER profiles_sync_role
  BEFORE INSERT OR UPDATE ON wacrm.profiles
  FOR EACH ROW EXECUTE FUNCTION wacrm.profiles_sync_role();

-- ---- Backfill dos perfis existentes (depois do trigger: perfis criados no meio já nascem com role_id) -------------
UPDATE wacrm.profiles p
   SET role_id = r.id
  FROM wacrm.account_roles r
 WHERE p.role_id IS NULL
   AND r.account_id IS NULL
   AND r.key = p.account_role::text;

-- Sanidade: nenhum perfil pode ficar sem papel (aborta e desfaz tudo se ficar).
DO $$
DECLARE
  v_orphans bigint;
BEGIN
  SELECT count(*) INTO v_orphans FROM wacrm.profiles WHERE role_id IS NULL;
  IF v_orphans > 0 THEN
    RAISE EXCEPTION '240: % perfil(is) sem role_id após o backfill — nada foi aplicado', v_orphans;
  END IF;
END $$;

-- Registro (202): tolera banco sem a 202 ainda; idempotente.
DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('240_roles_foundation') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
