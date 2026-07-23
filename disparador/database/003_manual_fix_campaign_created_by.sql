-- ============================================================
-- 003_manual_fix_campaign_created_by
--
-- DO NOT RUN AS-IS. This is a one-off data fix, not an automated
-- migration — it contains placeholder values that MUST be replaced
-- with a real, confirmed user UUID for each campaign before running.
--
-- Background: campaigns.created_by was never set by the app until
-- commit 8d5a89a (fix(security): set created_by on campaign creation).
-- Every campaign created before that fix has created_by = NULL, which
-- means:
--   - The ownership check in the campaign start/stop routes (commit
--     9ee19e5: `campaign.created_by !== user.id`) rejects everyone for
--     these rows, since NULL never equals a real user id.
--   - The account_id backfill in
--     supabase/migrations/040_disparador_account_scoping.sql can't
--     resolve these rows either (it depends on created_by), so they'd
--     be left with account_id NULL and become invisible under RLS once
--     that migration is applied.
--
-- As of 2026-07-22, exactly 2 campaigns are affected (read-only count,
-- nothing changed):
--
--   id: c9133837-6b65-4f10-be99-ee17ad7612f3
--   nome: "123"
--   status: encerrada
--   created_at: 2026-07-21T17:13:17Z
--
--   id: e820e26b-de79-493a-9f49-8f6f0eecbf75
--   nome: "Teste - gaby"
--   status: em_execucao
--   created_at: 2026-07-22T19:29:00Z
--
-- Before running: confirm with the team who actually created/owns
-- each of these two campaigns, replace the
-- 'REPLACE_WITH_CONFIRMED_USER_UUID' placeholders below with that
-- user's real auth.users id, then run the two UPDATEs individually
-- (not the placeholder as-is — it will fail cast to uuid, by design,
-- so this can't accidentally run unmodified).
-- ============================================================

-- Campaign "123" (encerrada, created 2026-07-21)
UPDATE wacrm.campaigns
SET created_by = 'REPLACE_WITH_CONFIRMED_USER_UUID'::uuid
WHERE id = 'c9133837-6b65-4f10-be99-ee17ad7612f3'
  AND created_by IS NULL;

-- Campaign "Teste - gaby" (em_execucao, created 2026-07-22)
UPDATE wacrm.campaigns
SET created_by = 'REPLACE_WITH_CONFIRMED_USER_UUID'::uuid
WHERE id = 'e820e26b-de79-493a-9f49-8f6f0eecbf75'
  AND created_by IS NULL;

-- ------------------------------------------------------------
-- Verification — run after both UPDATEs above to confirm no campaign
-- was left behind.
-- ------------------------------------------------------------
-- SELECT id, nome, status, created_by FROM wacrm.campaigns WHERE created_by IS NULL;
