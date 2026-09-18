-- ============================================================
-- Migration 085: habilita RLS nas 4 tabelas do Disparador
-- (campaigns, blacklist, disp_message_queue, campaign_metrics).
--
-- ██ APLICAR MANUALMENTE APÓS DEPLOY DO CÓDIGO — NÃO ANTES ██
--
-- Diferente das outras migrations deste projeto: esta só pode rodar
-- DEPOIS que o código que seta account_id nos INSERTs dessas 4 tabelas
-- já estiver em produção — campanhas/page.tsx (insert de campaigns),
-- v1/disparador/campaigns/route.ts (insert de campaigns via API
-- pública), startCampaign.ts (queueRows/disp_message_queue e upsert de
-- campaign_metrics) e blacklist/page.tsx (insert de blacklist). Rodar
-- esta migration antes desse deploy reproduz o mesmo problema que
-- bloqueou a 040: linhas novas entrariam com account_id NULL e, com RLS
-- ligado, ficariam invisíveis pro próprio dono (is_account_member(NULL)
-- nunca é true — ver nota "IMPORTANT" da 040 original).
--
-- Supersede supabase/migrations/040_disparador_account_scoping.sql
-- (nunca aplicada, marcada "DO NOT APPLY" pelo mesmo motivo acima). Não
-- precisa rodar a 040 antes desta — todo ADD COLUMN/CREATE INDEX aqui
-- usa IF NOT EXISTS, então esta migration é segura de rodar mesmo se a
-- 040 tiver sido aplicada parcialmente por engano em algum ambiente.
--
-- O que esta migration faz, em ordem:
--   1. Adiciona account_id (nullable) às 4 tabelas + índice.
--   2. Backfill: campaigns via created_by -> profiles.account_id; as
--      outras 3 via campaign_id -> campaigns.account_id (já backfillado
--      no passo 1). Idempotente — só toca linhas com account_id IS NULL.
--   3. Reporta contagem de órfãos (account_id ainda NULL após backfill)
--      via RAISE NOTICE — confira o log antes de assumir que deu tudo
--      certo. Não modifica dados.
--   4. Habilita RLS + policies is_account_member(account_id[, 'agent'])
--      nas 4 tabelas — mesmo piso de escrita ('agent') usado no resto
--      do schema (ver 017_account_sharing.sql). SELECT fica liberado
--      pra qualquer membro (min_role default 'viewer'); INSERT/UPDATE/
--      DELETE exigem 'agent'+.
--   5. blacklist_insert exige account_id IS NOT NULL EXPLICITAMENTE,
--      além de is_account_member — blacklist era uma lista única
--      compartilhada entre todas as contas da instância até agora (sem
--      account_id nenhum); este é o ponto em que esse comportamento
--      muda de vez, então a policy não deixa nenhuma linha nova cair de
--      volta no "compartilhado com a instância inteira" por engano
--      (ex: um insert direto via service role mal configurado).
--
-- account_id continua NULLABLE nas 4 colunas (não vira NOT NULL aqui) —
-- linhas órfãs (contagem no passo 3) ficam invisíveis sob RLS até
-- alguém setar o account_id manualmente; nada é apagado.
--
-- Idempotente — segura pra rodar mais de uma vez.
-- ============================================================

-- ------------------------------------------------------------
-- 1. account_id (nullable) + índice nas 4 tabelas.
-- ------------------------------------------------------------
ALTER TABLE wacrm.campaigns
  ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES wacrm.accounts(id) ON DELETE CASCADE;

ALTER TABLE wacrm.blacklist
  ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES wacrm.accounts(id) ON DELETE CASCADE;

ALTER TABLE wacrm.disp_message_queue
  ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES wacrm.accounts(id) ON DELETE CASCADE;

ALTER TABLE wacrm.campaign_metrics
  ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES wacrm.accounts(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_campaigns_account           ON wacrm.campaigns(account_id);
CREATE INDEX IF NOT EXISTS idx_blacklist_account            ON wacrm.blacklist(account_id);
CREATE INDEX IF NOT EXISTS idx_disp_message_queue_account   ON wacrm.disp_message_queue(account_id);
CREATE INDEX IF NOT EXISTS idx_campaign_metrics_account     ON wacrm.campaign_metrics(account_id);

-- ------------------------------------------------------------
-- 2. Backfill. Cada UPDATE só toca linhas com account_id IS NULL —
--    idempotente, seguro rodar de novo.
-- ------------------------------------------------------------

-- campaigns: resolve via created_by -> profiles.user_id -> profiles.account_id.
UPDATE wacrm.campaigns c
SET account_id = p.account_id
FROM wacrm.profiles p
WHERE c.account_id IS NULL
  AND c.created_by IS NOT NULL
  AND p.user_id = c.created_by
  AND p.account_id IS NOT NULL;

-- disp_message_queue: resolve via campaign_id -> campaigns.account_id
-- (já backfillado acima).
UPDATE wacrm.disp_message_queue q
SET account_id = c.account_id
FROM wacrm.campaigns c
WHERE q.account_id IS NULL
  AND q.campaign_id IS NOT NULL
  AND c.id = q.campaign_id
  AND c.account_id IS NOT NULL;

-- campaign_metrics: mesma resolução.
UPDATE wacrm.campaign_metrics m
SET account_id = c.account_id
FROM wacrm.campaigns c
WHERE m.account_id IS NULL
  AND m.campaign_id IS NOT NULL
  AND c.id = m.campaign_id
  AND c.account_id IS NOT NULL;

-- blacklist: mesma resolução — mas campaign_id não tem FK e é opcional
-- por design (bloqueio manual/opt-out não passa por campanha nenhuma),
-- então a maioria das linhas hoje provavelmente fica órfã aqui mesmo
-- (ver contagem no passo 3) — não há outra fonte pra resolver
-- retroativamente o account_id dessas.
UPDATE wacrm.blacklist b
SET account_id = c.account_id
FROM wacrm.campaigns c
WHERE b.account_id IS NULL
  AND b.campaign_id IS NOT NULL
  AND c.id = b.campaign_id
  AND c.account_id IS NOT NULL;

-- ------------------------------------------------------------
-- 3. Reporta órfãos em log (RAISE NOTICE) — não modifica dados. Rode
--    com client_min_messages = notice (ou cheque o log do SQL Editor)
--    pra ver isso quando a migration rodar de verdade.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_campaigns_orphaned INTEGER;
  v_blacklist_orphaned INTEGER;
  v_queue_orphaned INTEGER;
  v_metrics_orphaned INTEGER;
BEGIN
  SELECT count(*) INTO v_campaigns_orphaned FROM wacrm.campaigns WHERE account_id IS NULL;
  SELECT count(*) INTO v_blacklist_orphaned FROM wacrm.blacklist WHERE account_id IS NULL;
  SELECT count(*) INTO v_queue_orphaned FROM wacrm.disp_message_queue WHERE account_id IS NULL;
  SELECT count(*) INTO v_metrics_orphaned FROM wacrm.campaign_metrics WHERE account_id IS NULL;

  RAISE NOTICE 'Backfill complete. Rows left with account_id IS NULL (invisible under RLS once policies below apply): campaigns=%, blacklist=%, disp_message_queue=%, campaign_metrics=%',
    v_campaigns_orphaned, v_blacklist_orphaned, v_queue_orphaned, v_metrics_orphaned;
END $$;

-- ------------------------------------------------------------
-- 4. Habilita RLS + policies. Re-runnable: CREATE POLICY não tem
--    IF NOT EXISTS, então cada uma é precedida de DROP POLICY IF EXISTS.
-- ------------------------------------------------------------
ALTER TABLE wacrm.campaigns            ENABLE ROW LEVEL SECURITY;
ALTER TABLE wacrm.blacklist             ENABLE ROW LEVEL SECURITY;
ALTER TABLE wacrm.disp_message_queue    ENABLE ROW LEVEL SECURITY;
ALTER TABLE wacrm.campaign_metrics      ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS campaigns_select ON wacrm.campaigns;
DROP POLICY IF EXISTS campaigns_insert ON wacrm.campaigns;
DROP POLICY IF EXISTS campaigns_update ON wacrm.campaigns;
DROP POLICY IF EXISTS campaigns_delete ON wacrm.campaigns;

CREATE POLICY campaigns_select ON wacrm.campaigns FOR SELECT USING (is_account_member(account_id));
CREATE POLICY campaigns_insert ON wacrm.campaigns FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY campaigns_update ON wacrm.campaigns FOR UPDATE USING (is_account_member(account_id, 'agent'));
CREATE POLICY campaigns_delete ON wacrm.campaigns FOR DELETE USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS blacklist_select ON wacrm.blacklist;
DROP POLICY IF EXISTS blacklist_insert ON wacrm.blacklist;
DROP POLICY IF EXISTS blacklist_update ON wacrm.blacklist;
DROP POLICY IF EXISTS blacklist_delete ON wacrm.blacklist;

CREATE POLICY blacklist_select ON wacrm.blacklist FOR SELECT USING (is_account_member(account_id));
-- account_id IS NOT NULL explícito (além de is_account_member) — ver
-- item 5 do cabeçalho: fecha de vez a porta de "lista compartilhada com
-- a instância inteira" pra qualquer insert novo.
CREATE POLICY blacklist_insert ON wacrm.blacklist FOR INSERT WITH CHECK (account_id IS NOT NULL AND is_account_member(account_id, 'agent'));
CREATE POLICY blacklist_update ON wacrm.blacklist FOR UPDATE USING (is_account_member(account_id, 'agent'));
CREATE POLICY blacklist_delete ON wacrm.blacklist FOR DELETE USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS disp_message_queue_select ON wacrm.disp_message_queue;
DROP POLICY IF EXISTS disp_message_queue_insert ON wacrm.disp_message_queue;
DROP POLICY IF EXISTS disp_message_queue_update ON wacrm.disp_message_queue;
DROP POLICY IF EXISTS disp_message_queue_delete ON wacrm.disp_message_queue;

CREATE POLICY disp_message_queue_select ON wacrm.disp_message_queue FOR SELECT USING (is_account_member(account_id));
CREATE POLICY disp_message_queue_insert ON wacrm.disp_message_queue FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY disp_message_queue_update ON wacrm.disp_message_queue FOR UPDATE USING (is_account_member(account_id, 'agent'));
CREATE POLICY disp_message_queue_delete ON wacrm.disp_message_queue FOR DELETE USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS campaign_metrics_select ON wacrm.campaign_metrics;
DROP POLICY IF EXISTS campaign_metrics_insert ON wacrm.campaign_metrics;
DROP POLICY IF EXISTS campaign_metrics_update ON wacrm.campaign_metrics;
DROP POLICY IF EXISTS campaign_metrics_delete ON wacrm.campaign_metrics;

CREATE POLICY campaign_metrics_select ON wacrm.campaign_metrics FOR SELECT USING (is_account_member(account_id));
CREATE POLICY campaign_metrics_insert ON wacrm.campaign_metrics FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY campaign_metrics_update ON wacrm.campaign_metrics FOR UPDATE USING (is_account_member(account_id, 'agent'));
CREATE POLICY campaign_metrics_delete ON wacrm.campaign_metrics FOR DELETE USING (is_account_member(account_id, 'agent'));

-- ------------------------------------------------------------
-- 5. Refresh do schema cache do PostgREST, pra pegar coluna/policies
--    novas imediatamente em vez de esperar o auto-reload.
-- ------------------------------------------------------------
NOTIFY pgrst, 'reload schema';
