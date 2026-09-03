-- ============================================================
-- 070_disp_message_queue_template_fields.sql — Meta template
-- fields on the Disparador queue.
--
-- Documents 3 columns already applied directly to production
-- (confirmed live via the REST OpenAPI schema — not run by this
-- session, no prior migration file covered them): a campaign
-- targeting a Meta channel needs to send a pre-approved template
-- (business-initiated / outside the 24h window), which has no
-- equivalent in the WAHA-only `tipo`/`mensagem_final`/`media_url`
-- shape the queue already had.
--
-- template_name/template_language mirror sendTemplateMessage's
-- required args (src/lib/whatsapp/meta-api.ts). template_variables
-- is jsonb (a JSON array of body params, ["valor1", "valor2", ...]),
-- not a Postgres array — matches how it's already stored live and
-- how processQueue.ts reads it (Array.isArray check, no PG array
-- parsing needed).
--
-- All three nullable — existing WAHA-only queue items are
-- unaffected; processQueue.ts's sendViaMeta only takes the template
-- path when template_name is set.
--
-- Idempotent — safe to run multiple times. File only, NOT applied to
-- the database by this session (already live).
-- ============================================================

SET search_path TO wacrm, public, extensions;

ALTER TABLE wacrm.disp_message_queue
  ADD COLUMN IF NOT EXISTS template_name TEXT;

ALTER TABLE wacrm.disp_message_queue
  ADD COLUMN IF NOT EXISTS template_language TEXT DEFAULT 'pt_BR';

ALTER TABLE wacrm.disp_message_queue
  ADD COLUMN IF NOT EXISTS template_variables JSONB;
