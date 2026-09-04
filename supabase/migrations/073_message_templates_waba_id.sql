-- ============================================================
-- 073_message_templates_waba_id.sql — WABA ownership on
-- wacrm.message_templates.
--
-- Documents a column already applied directly to production
-- (confirmed live via the REST OpenAPI schema — not run by this
-- session, no prior migration file covered it): an account can have
-- more than one Meta channel (each with its own waba_id), but until
-- now a synced template row had no way to say which WABA it came
-- from. templates/sync/route.ts now stamps waba_id on every row it
-- writes, and the Disparador's template picker (message-template-
-- picker.tsx) uses it to scope the catalog to the WABA of whichever
-- Meta channel is selected in the campaign, instead of mixing
-- templates from every WABA the account has ever synced.
--
-- Nullable — pre-existing rows synced before this change have no
-- waba_id until the next sync backfills them (sync always overwrites
-- this column now, see 1b in the accompanying code change).
--
-- Idempotent — safe to run multiple times. File only, NOT applied to
-- the database by this session (already live).
-- ============================================================

SET search_path TO wacrm, public, extensions;

ALTER TABLE wacrm.message_templates
  ADD COLUMN IF NOT EXISTS waba_id TEXT;
