-- ============================================================
-- 056_whatsapp_config_channel_settings.sql — Canais: flow_id,
-- receptivo, habilitado on wacrm.whatsapp_config.
--
-- Passo 0 confirmed: the flows table is wacrm.flows (bare `flows` in
-- the CREATE TABLE, lives in wacrm by the schema's usual convention),
-- columns include `id` and `name` (not `nome`) — 010_flows.sql.
-- None of flow_id/receptivo/habilitado existed anywhere in
-- whatsapp_config's history (checked 001/013/015/017/027/039).
--
-- Idempotent — safe to run multiple times. Not applied to the DB by
-- this session; file only.
-- ============================================================

SET search_path TO wacrm, public, extensions;

ALTER TABLE wacrm.whatsapp_config
  ADD COLUMN IF NOT EXISTS flow_id    UUID REFERENCES wacrm.flows(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS receptivo  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS habilitado BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS whatsapp_config_flow_id
  ON wacrm.whatsapp_config(flow_id)
  WHERE flow_id IS NOT NULL;
