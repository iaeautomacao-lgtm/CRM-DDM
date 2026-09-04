-- ============================================================
-- 071_whatsapp_config_display_phone_number.sql — Meta display
-- phone number on whatsapp_config.
--
-- Documents a column already applied directly to production
-- (confirmed live via the REST OpenAPI schema — not run by this
-- session, no prior migration file covered it): verifyPhoneNumber
-- (src/lib/whatsapp/meta-api.ts) already returns display_phone_number
-- for Meta channels, but it was only ever surfaced in the GET
-- /api/whatsapp/config response, never persisted — so nothing that
-- reads the config row directly (e.g. the Disparador campaign
-- session picker) could show the actual phone number for a Meta
-- channel without re-calling the Meta API.
--
-- Nullable, WAHA channels never populate it (name comes from
-- waha_session instead).
--
-- Idempotent — safe to run multiple times. File only, NOT applied to
-- the database by this session (already live).
-- ============================================================

SET search_path TO wacrm, public, extensions;

ALTER TABLE wacrm.whatsapp_config
  ADD COLUMN IF NOT EXISTS display_phone_number TEXT;
