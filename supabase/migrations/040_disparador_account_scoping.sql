-- ============================================================
-- 040_disparador_account_scoping
--
-- ██ DO NOT APPLY THIS MIGRATION until BOTH of the following are true: ██
--
--   1. The app's INSERT code paths for wacrm.campaigns,
--      wacrm.blacklist, and wacrm.disp_message_queue (and wherever
--      wacrm.campaign_metrics rows get created) set account_id
--      directly at insert time. As of this writing, only
--      disparador/campanhas/page.tsx sets created_by (commit
--      8d5a89a) — that is NOT enough on its own: the INSERT policies
--      added in step 3 below check the account_id column, not
--      created_by, so a campaign insert that sets created_by but not
--      account_id would still be rejected by RLS the moment this
--      migration is applied. blacklist's insert page and the
--      disp_message_queue inserts in the campaign start route /
--      cron route don't set either field yet.
--   2. Whether wacrm.blacklist should become per-account at all has
--      been decided WITH CAIO. This is a product decision, not a
--      technical detail this migration can resolve on its own —
--      blacklist is currently a single shared list across every
--      account on the instance; scoping it per-account means a number
--      one account blocks would no longer block sends from a
--      *different* account on the same instance. See the blacklist
--      bullet under "KNOWN DATA ISSUE" below before deciding. Do not
--      apply the blacklist portion of this migration (or apply it at
--      all) until that call is made.
--
-- Neither of the above has happened yet. This file is written for
-- review only.
--
-- Written in response to a security finding: wacrm.campaigns,
-- wacrm.blacklist, wacrm.disp_message_queue, and wacrm.campaign_metrics
-- have no account_id column and had RLS explicitly disabled by
-- disparador_schema.sql ("Desativar RLS nas tabelas do disparador para
-- compatibilidade"). Every page under /disparador queries these tables
-- directly from the browser with the anon-key client (not through an
-- API route), so with RLS off ANY authenticated user on ANY account —
-- not just this instance's account — can read, insert, update, and
-- delete every other account's campaigns, queue items, metrics, and
-- blacklist entries.
--
-- This migration, in order:
--   1. Adds a nullable `account_id` column (+ index) to all four
--      tables, matching the `accounts(id)` FK pattern used everywhere
--      else in this schema (see 017_account_sharing.sql).
--   2. Backfills account_id:
--        campaigns.account_id           <- profiles.account_id
--                                           WHERE profiles.user_id = campaigns.created_by
--        disp_message_queue.account_id  <- campaigns.account_id (via campaign_id)
--        campaign_metrics.account_id    <- campaigns.account_id (via campaign_id)
--        blacklist.account_id           <- campaigns.account_id (via campaign_id, nullable FK)
--      Rows that can't be resolved this way are left NULL — see the
--      "KNOWN DATA ISSUE" and "IMPORTANT" notes below. Nothing is
--      guessed or defaulted.
--   3. Re-enables RLS on all four tables with the same
--      is_account_member(account_id, min_role) policy shape used by
--      every other tenant-scoped table in this schema.
--   4. Does NOT set account_id NOT NULL — see "IMPORTANT" below.
--
-- KNOWN DATA ISSUE (found while writing this migration, via a
-- read-only count against the live database on 2026-07-22):
--   - BOTH existing rows in wacrm.campaigns have created_by = NULL.
--     campaigns.created_by is now set on new inserts (commit 8d5a89a,
--     disparador/campanhas/page.tsx), but that only fixes campaigns
--     created from now on — these 2 pre-existing rows (and everything
--     that hangs off them: all 72 existing disp_message_queue rows and
--     both campaign_metrics rows) still have no creator to backfill
--     from, and are NOT touched by this migration. A separate,
--     not-yet-run script — disparador/database/003_manual_fix_campaign_created_by.sql —
--     has placeholders to set created_by on those 2 rows once the
--     team confirms who actually owns each one. Run that script (with
--     real UUIDs filled in) BEFORE this migration if you want those 2
--     campaigns to survive the backfill with a real account_id instead
--     of being left NULL.
--   - Setting created_by is also not sufficient by itself to satisfy
--     the INSERT policies added in step 3 below — see the "DO NOT
--     APPLY" checklist at the top of this file. account_id must be set
--     directly at insert time for campaigns/blacklist/disp_message_queue,
--     which the app does not do yet.
--   - wacrm.blacklist currently has 0 rows on the live database, so
--     the backfill orphans nothing today. But blacklist.campaign_id
--     has no FK constraint and is optional by design (a number can be
--     blacklisted from a reply/opt-out with no campaign in play), so
--     backfilling it via campaign_id will structurally orphan any
--     blacklist entry that isn't tied to a campaign — which may be
--     most of them once the table is actually used. Whether blacklist
--     should even become per-account is a PRODUCT decision pending
--     confirmation with Caio (see the checklist at the top of this
--     file) — a number blacklisted by one account would then no
--     longer block sends from a *different* account on the same
--     instance. This migration does not decide that question; it only
--     implements the per-account schema so the decision can be
--     acted on once made.
--
-- IMPORTANT — read before running this file:
--   - account_id is left NULLABLE on purpose. Once RLS is enabled
--     (step 3), is_account_member(NULL) is never true for anyone
--     (SQL: `x = NULL` is never true), so any row left with
--     account_id IS NULL becomes invisible to EVERY user, including
--     its rightful owner — not deleted, just permanently hidden until
--     someone manually sets its account_id. Confirm the orphan counts
--     are acceptable (or fixed) before running this in an environment
--     anyone depends on.
--   - The app's INSERT code paths for these four tables
--     (disparador/campanhas/page.tsx, disparador/blacklist/page.tsx,
--     the campaign start route's disp_message_queue/campaign_metrics
--     inserts, etc.) do not currently set account_id. Once the INSERT
--     policies below are enforced, any insert that omits account_id
--     will be rejected by RLS (is_account_member(NULL, ...) is false).
--     Those code paths must be updated to set account_id (from the
--     caller's resolved account) BEFORE this migration is applied to
--     an environment serving real traffic, or campaign creation,
--     contact import blacklist checks, and queue processing will
--     start failing.
--   - This file has not been executed. Review the counts reported
--     alongside this migration, decide on the blacklist scoping
--     question, and patch the INSERT call sites first.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Add account_id (nullable) to the four disparador tables.
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
-- 2. Backfill. Every UPDATE below only ever fills in rows where
--    account_id IS NULL and a value can be resolved — nothing is
--    guessed, and re-running this migration is safe (idempotent).
-- ------------------------------------------------------------

-- campaigns: resolve via created_by -> profiles.user_id -> profiles.account_id.
-- Rows with created_by NULL, or created_by not matching any profile, or a
-- matching profile with a NULL account_id, are left untouched (NULL).
UPDATE wacrm.campaigns c
SET account_id = p.account_id
FROM wacrm.profiles p
WHERE c.account_id IS NULL
  AND c.created_by IS NOT NULL
  AND p.user_id = c.created_by
  AND p.account_id IS NOT NULL;

-- disp_message_queue: resolve via campaign_id -> campaigns.account_id
-- (post-backfill). Rows whose campaign_id is NULL, or whose campaign's
-- account_id is still NULL (see campaigns backfill above), are left NULL.
UPDATE wacrm.disp_message_queue q
SET account_id = c.account_id
FROM wacrm.campaigns c
WHERE q.account_id IS NULL
  AND q.campaign_id IS NOT NULL
  AND c.id = q.campaign_id
  AND c.account_id IS NOT NULL;

-- campaign_metrics: same resolution path as disp_message_queue.
UPDATE wacrm.campaign_metrics m
SET account_id = c.account_id
FROM wacrm.campaigns c
WHERE m.account_id IS NULL
  AND m.campaign_id IS NOT NULL
  AND c.id = m.campaign_id
  AND c.account_id IS NOT NULL;

-- blacklist: same resolution path, but campaign_id has no FK constraint
-- and is optional by design — see the "KNOWN DATA ISSUE" note above.
UPDATE wacrm.blacklist b
SET account_id = c.account_id
FROM wacrm.campaigns c
WHERE b.account_id IS NULL
  AND b.campaign_id IS NOT NULL
  AND c.id = b.campaign_id
  AND c.account_id IS NOT NULL;

-- ------------------------------------------------------------
-- 2b. Report orphan counts at run time (does not modify data). Run
--     this migration with client_min_messages set to notice (or check
--     the SQL Editor's log output) to see these when it actually runs.
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

  RAISE NOTICE 'Backfill complete. Rows left with account_id IS NULL (invisible under RLS once step 3 runs): campaigns=%, blacklist=%, disp_message_queue=%, campaign_metrics=%',
    v_campaigns_orphaned, v_blacklist_orphaned, v_queue_orphaned, v_metrics_orphaned;
END $$;

-- ------------------------------------------------------------
-- 3. Re-enable RLS with the same is_account_member(account_id, min_role)
--    shape used across the rest of this schema (017_account_sharing.sql).
--    'agent' is the write floor used for comparable resources
--    (contacts, deals, broadcasts); adjust per the team's call on who
--    should be allowed to launch/stop sends and edit the blacklist.
--
--    NOT NULL is intentionally NOT added to account_id here — see the
--    "IMPORTANT" note at the top of this file. Add it in a follow-up
--    migration once orphaned rows are resolved (or accepted as
--    permanently hidden) and the app's INSERT paths set account_id.
-- ------------------------------------------------------------
ALTER TABLE wacrm.campaigns            ENABLE ROW LEVEL SECURITY;
ALTER TABLE wacrm.blacklist             ENABLE ROW LEVEL SECURITY;
ALTER TABLE wacrm.disp_message_queue    ENABLE ROW LEVEL SECURITY;
ALTER TABLE wacrm.campaign_metrics      ENABLE ROW LEVEL SECURITY;

-- Re-runnable: CREATE POLICY has no IF NOT EXISTS, so drop first.
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
CREATE POLICY blacklist_insert ON wacrm.blacklist FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
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
-- 4. Refresh PostgREST's schema cache so the new column/policies are
--    picked up immediately instead of waiting for the next auto-reload.
-- ------------------------------------------------------------
NOTIFY pgrst, 'reload schema';
