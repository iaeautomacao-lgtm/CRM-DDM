-- 046_translate_default_pipeline_stages.sql
-- Translate the default pipeline/stage names (seeded in English) to
-- pt-BR. This CRM is Brazil-only; English was always the wrong
-- default copy. Only touches display `name` columns — no id/slug/
-- position/color changes, so nothing that references a stage by id
-- (deals.stage_id, deal_aging_rules.*_stage_id) is affected.
--
-- pipeline_stages has no marker distinguishing "system default" from
-- a user-renamed custom stage (no slug/is_default column), so this
-- matches defensively on name + expected default position together.

UPDATE wacrm.pipeline_stages SET name = 'Novo Lead'            WHERE name = 'New Lead'      AND position = 0;
UPDATE wacrm.pipeline_stages SET name = 'Qualificado'          WHERE name = 'Qualified'     AND position = 1;
UPDATE wacrm.pipeline_stages SET name = 'Proposta Enviada'     WHERE name = 'Proposal Sent' AND position = 2;
UPDATE wacrm.pipeline_stages SET name = U&'Negocia\00E7\00E3o' WHERE name = 'Negotiation'   AND position = 3;
UPDATE wacrm.pipeline_stages SET name = 'Ganho'                WHERE name = 'Won'           AND position = 4;

-- Default pipeline name, seeded once per account on first load.
UPDATE wacrm.pipelines SET name = 'Pipeline de Vendas' WHERE name = 'Sales Pipeline';
