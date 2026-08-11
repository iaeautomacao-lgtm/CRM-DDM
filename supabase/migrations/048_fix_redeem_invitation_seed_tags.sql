-- ============================================================
-- 048_fix_redeem_invitation_seed_tags.sql
--
-- Fixes a bug in wacrm.redeem_invitation (migration 019) that made
-- EVERY invite redemption by a brand-new account fail. The RPC's
-- "does the caller's account already have data?" safety check counts
-- ALL rows in `tags` for the account, with no distinction between
-- user-created tags and the ~77 tabulação/outcome tags that migration
-- 041's seed_tabulacao_tags_on_account_insert trigger seeds
-- automatically and synchronously the instant a new account is
-- created at signup — before the user has done anything at all.
--
-- Effect of the bug: v_has_data was TRUE for 100% of brand-new
-- accounts (the seeded tags alone satisfy the EXISTS), so
-- redeem_invitation always raised "Your account already contains
-- data" (SQLSTATE 23505 -> HTTP 409 in the redeem route), blocking
-- every invite accepted by someone signing up fresh. Confirmed against
-- production.
--
-- Fix: exclude kind = 'outcome' tags from the tags branch of the
-- EXISTS check. kind = 'contact' tags (the column's default, and what
-- a user creates/applies manually — see migration 041) still count as
-- real data; only the system-seeded tabulação dictionary is excluded.
--
-- Other tables in the same check were investigated and do NOT need
-- the same treatment:
--   - pipelines / pipeline_stages are lazily created client-side on
--     first visit to /pipelines (src/app/(dashboard)/pipelines/page.tsx),
--     never at signup — a truly untouched account already has zero
--     rows there, and neither is in this check's table list anyway.
--   - contacts, conversations, broadcasts, flows, message_templates,
--     custom_fields, contact_notes, whatsapp_config have no
--     signup-time seed anywhere in the migration history. The only
--     `AFTER INSERT` triggers tied to account/user creation are
--     `on_auth_user_created` -> handle_new_user (creates the account +
--     profile row themselves, migration 017) and migration 041's tags
--     seed — neither touches these tables.
--   - automations has a *candidate* seed (migration 038,
--     seed_automation_templates), but its trigger is wired to
--     `AFTER INSERT ON wacrm.account_members` — a table that does not
--     exist anywhere in this schema (the account model uses
--     profiles.account_id / account_role, not a separate membership
--     table; see migration 017's "locked design decision — single
--     membership"). That trigger therefore cannot fire and
--     automations is not actually auto-seeded today — left unfiltered
--     here. Worth a follow-up cleanup, but out of scope for this fix.
--
-- No schema changes. CREATE OR REPLACE on the existing function body,
-- byte-for-byte identical to what's deployed (see
-- wacrm.redeem_invitation in all_migrations.sql) except for the single
-- added `AND kind != 'outcome'` clause below.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE OR REPLACE FUNCTION wacrm.redeem_invitation(
  p_token_hash TEXT
) RETURNS UUID  -- the joined account_id
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wacrm, public, extensions
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_inv account_invitations%ROWTYPE;
  v_old_account_id UUID;
  v_old_account_owner UUID;
  v_has_data BOOLEAN;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv
  FROM account_invitations
  WHERE token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = '22023';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has already been redeemed'
      USING ERRCODE = '22023';
  END IF;
  IF v_inv.expires_at <= NOW() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;

  -- Caller's current account + its owner.
  SELECT p.account_id, a.owner_user_id
  INTO v_old_account_id, v_old_account_owner
  FROM profiles p
  JOIN accounts a ON a.id = p.account_id
  WHERE p.user_id = v_caller_id;

  IF v_old_account_id IS NULL THEN
    -- Defensive — every authenticated user has a profile post-017.
    RAISE EXCEPTION 'Caller has no profile' USING ERRCODE = '42501';
  END IF;

  -- Edge case: the inviter sent themselves a link, or the
  -- caller is somehow already in the inviter's account.
  IF v_old_account_id = v_inv.account_id THEN
    RAISE EXCEPTION 'You are already a member of this account'
      USING ERRCODE = '23505';
  END IF;

  -- Safety: the caller must be the SOLE OWNER of their current
  -- account (i.e. their fresh personal account from signup or a
  -- prior removal). Any other state means they're either:
  --   - a member of another shared account (joining a second
  --     would silently orphan their access to the first), or
  --   - the owner of an account with teammates (they'd abandon
  --     their team to join the inviter's).
  -- Either way, the safe answer is "make a different login".
  IF v_old_account_owner <> v_caller_id THEN
    RAISE EXCEPTION 'You are already in a shared account; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  -- Belt: even if they own their account, refuse if it has any
  -- domain data — joining would orphan their contacts, deals,
  -- broadcasts, automations, flows, templates, etc.
  --
  -- `tags` excludes kind = 'outcome': those ~77 rows are seeded
  -- automatically by migration 041's trigger the instant the account
  -- is created, before the user does anything, so they don't count as
  -- "the user's data" — only manually-created/applied tags
  -- (kind = 'contact', the default) do.
  SELECT EXISTS (
    SELECT 1 FROM contacts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM conversations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM broadcasts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flows WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM pipelines WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM message_templates WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM tags WHERE account_id = v_old_account_id AND kind != 'outcome'
    UNION ALL SELECT 1 FROM custom_fields WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM contact_notes WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM whatsapp_config WHERE account_id = v_old_account_id
    LIMIT 1
  ) INTO v_has_data;

  IF v_has_data THEN
    RAISE EXCEPTION 'Your account already contains data; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  -- Move the profile first so the cascade-on-delete of the old
  -- account doesn't try to nuke this user's profile too.
  UPDATE profiles
  SET account_id = v_inv.account_id,
      account_role = v_inv.role
  WHERE user_id = v_caller_id;

  UPDATE account_invitations
  SET accepted_at = NOW(),
      accepted_by_user_id = v_caller_id
  WHERE id = v_inv.id;

  -- Clean up the orphan personal account. Empty by the checks
  -- above, so this is purely housekeeping — no cascades fire
  -- because no other rows reference it.
  DELETE FROM accounts WHERE id = v_old_account_id;

  RETURN v_inv.account_id;
END;
$$;

ALTER FUNCTION wacrm.redeem_invitation(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION wacrm.redeem_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wacrm.redeem_invitation(TEXT) TO authenticated;
