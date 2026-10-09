-- ============================================================
-- 292_import_lists.sql   (PRD 24, item 8 — listas importadas reutilizáveis no Disparador)
--
-- Uma importação concluída (job da 197) passa a poder ser uma LISTA com nome, listada e reutilizada em outra campanha:
--   dispatch_import_jobs.name           nome da lista (opcional; até 120 caracteres). Sem nome a tela mostra pela data.
--   wacrm.duplicate_import_list(...)    cópia ATÔMICA e set-based da lista para um rascunho NOVO: os vínculos (disp_import_contacts, 132) e as
--                                       VAR1–VAR3 (contact_import_variables, 079). Necessária porque a campanha lê as variáveis por campaign_id: o
--                                       startCampaign liga as do rascunho à 1ª campanha e uma 2ª campanha que reutilizasse o MESMO rascunho ficaria
--                                       sem variáveis. Com o rascunho novo, a 2ª campanha usa import_draft_id = <rascunho novo> como qualquer
--                                       importação do assistente. Não copia links UTM (são por campanha) nem altera a lista de origem.
-- As contagens da lista vêm do próprio job (totals, linked, rows_total): nada novo é calculado aqui.
--
-- COMPATIBILIDADE: sem a migration, o nome é ignorado (a importação segue) e as rotas de listas/reuso respondem 503 `unavailable`.
-- ANTES ou DEPOIS do deploy. ADD COLUMN nula, sem DEFAULT (só catálogo); sem índice novo (idx_dispatch_import_jobs_account cobre a listagem).
--
-- PRÉ-CHECK:  SELECT column_name FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='dispatch_import_jobs' AND column_name='name'; -- 0 linhas
-- ROLLBACK:   DROP FUNCTION IF EXISTS wacrm.duplicate_import_list(uuid, uuid, uuid, uuid);
--             ALTER TABLE wacrm.dispatch_import_jobs DROP CONSTRAINT IF EXISTS dispatch_import_jobs_name_len, DROP COLUMN IF EXISTS name;
-- Idempotente — pode rodar mais de uma vez.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.dispatch_import_jobs') IS NULL THEN
    RAISE EXCEPTION '292: falta wacrm.dispatch_import_jobs (migration 197)';
  END IF;
  IF to_regclass('wacrm.disp_import_contacts') IS NULL OR to_regclass('wacrm.contact_import_variables') IS NULL THEN
    RAISE EXCEPTION '292: faltam wacrm.disp_import_contacts (132) / wacrm.contact_import_variables (079)';
  END IF;
END $$;

ALTER TABLE wacrm.dispatch_import_jobs ADD COLUMN IF NOT EXISTS name text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dispatch_import_jobs_name_len' AND conrelid = 'wacrm.dispatch_import_jobs'::regclass) THEN
    ALTER TABLE wacrm.dispatch_import_jobs
      ADD CONSTRAINT dispatch_import_jobs_name_len CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 120);
  END IF;
END $$;

COMMENT ON COLUMN wacrm.dispatch_import_jobs.name IS 'Nome da lista importada (reutilizável em outra campanha). NULL = sem nome.';

-- Copia a lista (vínculos + variáveis) de um rascunho OU de uma campanha de origem para um rascunho NOVO da MESMA conta.
-- Devolve {"contacts": n, "variables": n}. Idempotente (chamar de novo com o mesmo rascunho novo não duplica). Rascunho novo que já pertence a
-- outra conta é recusado (mesma regra do draftBelongsToOtherAccount do import).
CREATE OR REPLACE FUNCTION wacrm.duplicate_import_list(
  p_account_id uuid,
  p_source_draft uuid,
  p_source_campaign uuid,
  p_new_draft uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_contacts integer := 0;
  v_vars integer := 0;
BEGIN
  IF p_account_id IS NULL OR p_new_draft IS NULL OR (p_source_draft IS NULL AND p_source_campaign IS NULL) THEN
    RETURN jsonb_build_object('contacts', 0, 'variables', 0);
  END IF;
  IF EXISTS (SELECT 1 FROM wacrm.disp_import_contacts WHERE draft_id = p_new_draft AND account_id <> p_account_id)
     OR EXISTS (SELECT 1 FROM wacrm.campaigns WHERE import_draft_id = p_new_draft AND account_id <> p_account_id) THEN
    RAISE EXCEPTION 'rascunho de destino pertence a outra conta' USING ERRCODE = '42501';
  END IF;

  INSERT INTO wacrm.disp_import_contacts (account_id, contact_id, campaign_id, draft_id)
  SELECT p_account_id, i.contact_id, NULL, p_new_draft
    FROM wacrm.disp_import_contacts i
   WHERE i.account_id = p_account_id
     AND ((p_source_draft IS NOT NULL AND i.draft_id = p_source_draft)
          OR (p_source_draft IS NULL AND i.campaign_id = p_source_campaign))
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_contacts = ROW_COUNT;

  INSERT INTO wacrm.contact_import_variables (contact_id, campaign_id, draft_id, var_index, value)
  SELECT v.contact_id, NULL, p_new_draft, v.var_index, v.value
    FROM wacrm.contact_import_variables v
    JOIN wacrm.contacts c ON c.id = v.contact_id AND c.account_id = p_account_id
   WHERE (p_source_draft IS NOT NULL AND v.draft_id = p_source_draft)
      OR (p_source_draft IS NULL AND v.campaign_id = p_source_campaign)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_vars = ROW_COUNT;

  RETURN jsonb_build_object('contacts', v_contacts, 'variables', v_vars);
END;
$$;

REVOKE ALL ON FUNCTION wacrm.duplicate_import_list(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.duplicate_import_list(uuid, uuid, uuid, uuid) TO service_role;

-- Registro (migration 202). Tolerante a banco sem a 202.
DO $$
BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('292_import_lists') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
