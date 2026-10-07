-- 180 — API transacional de perfis. Aplicar manualmente ANTES do deploy da API.
-- PRÉ-CHECK: SELECT to_regclass('wacrm.ai_agents'), to_regclass('wacrm.ai_tools'),
--   to_regclass('wacrm.knowledge_base_files'), to_regclass('wacrm.flow_nodes');
-- Detectar órfãos antes: SELECT t.* FROM wacrm.ai_agent_tools t LEFT JOIN
-- wacrm.ai_tools c ON c.account_id=t.account_id AND c.id=t.tool_id WHERE c.id IS NULL;
-- Requer 176/177. Não aplica backfill nem altera snapshots de runs (179).
BEGIN;
DO $$ BEGIN
  IF to_regclass('wacrm.ai_agents') IS NULL OR to_regclass('wacrm.ai_tools') IS NULL
    OR to_regclass('wacrm.knowledge_base_files') IS NULL OR to_regclass('wacrm.flow_nodes') IS NULL THEN
    RAISE EXCEPTION '180: faltam tabelas de perfis, tools, KB ou fluxos';
  END IF;
  IF EXISTS (SELECT 1 FROM wacrm.ai_agent_tools t LEFT JOIN wacrm.ai_tools c
    ON c.account_id=t.account_id AND c.id=t.tool_id WHERE c.id IS NULL) THEN
    RAISE EXCEPTION '180: vínculos de tools órfãos/entre contas; corrigir antes de aplicar';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='wacrm.ai_tools'::regclass AND conname='ai_tools_account_id_id_unique') THEN
    ALTER TABLE wacrm.ai_tools ADD CONSTRAINT ai_tools_account_id_id_unique UNIQUE(account_id,id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='wacrm.ai_agent_tools'::regclass AND conname='ai_agent_tools_catalog_fk') THEN
    ALTER TABLE wacrm.ai_agent_tools ADD CONSTRAINT ai_agent_tools_catalog_fk
      FOREIGN KEY(account_id,tool_id) REFERENCES wacrm.ai_tools(account_id,id);
  END IF;
END $$;

-- A escrita só ocorre em service_role após a guarda de papel e conta na API.
-- INVOKER: nenhuma elevação de privilégios nem acesso do navegador.
CREATE OR REPLACE FUNCTION wacrm.publish_ai_agent(
  p_account_id uuid, p_created_by uuid, p_agent_id uuid, p_name text, p_payload jsonb
) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE aid uuid; vid uuid := gen_random_uuid(); n integer; r jsonb; t jsonb; k jsonb;
BEGIN
  IF p_agent_id IS NULL THEN
    INSERT INTO wacrm.ai_agents(account_id,name) VALUES(p_account_id,p_name) RETURNING id INTO aid;
  ELSE
    SELECT id INTO aid FROM wacrm.ai_agents WHERE account_id=p_account_id AND id=p_agent_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Agente não encontrado' USING ERRCODE='P0002'; END IF;
  END IF;
  IF p_payload->>'composition' IS DISTINCT FROM 'sections_v1' THEN
    RAISE EXCEPTION 'Publicação exige sections_v1' USING ERRCODE='22023';
  END IF;
  -- Serialização pela linha do agente: não há corrida no MAX(version)+1.
  SELECT coalesce(max(version),0)+1 INTO n FROM wacrm.ai_agent_versions WHERE account_id=p_account_id AND agent_id=aid;
  k := p_payload #> '{config,knowledge}';
  IF k->>'selection_mode'='explicit' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(coalesce(k->'file_ids','[]'::jsonb)) f(id)
    WHERE NOT EXISTS(SELECT 1 FROM wacrm.knowledge_base_files WHERE account_id=p_account_id AND id=f.id::uuid)
  ) THEN RAISE EXCEPTION 'Arquivo fora da conta' USING ERRCODE='22023'; END IF;
  INSERT INTO wacrm.ai_agent_versions(id,account_id,agent_id,version,config,prompt_content,composition,config_hash,created_by)
    VALUES(vid,p_account_id,aid,n,p_payload->'config',p_payload->>'prompt_content','sections_v1',p_payload->>'config_hash',p_created_by);
  FOR r IN SELECT * FROM jsonb_array_elements(p_payload->'rules') LOOP
    INSERT INTO wacrm.ai_rules(id,account_id,name) VALUES((r->>'rule_id')::uuid,p_account_id,'regra_' || (r->>'rule_id'));
    INSERT INTO wacrm.ai_rule_versions(id,account_id,rule_id,version,content,created_by)
      VALUES((r->>'rule_version_id')::uuid,p_account_id,(r->>'rule_id')::uuid,1,r->>'content',p_created_by);
    INSERT INTO wacrm.ai_agent_rules(account_id,agent_version_id,rule_version_id,position,enabled)
      VALUES(p_account_id,vid,(r->>'rule_version_id')::uuid,(r->>'position')::integer,(r->>'enabled')::boolean);
  END LOOP;
  FOR t IN SELECT value || jsonb_build_object('position',ordinality-1)
    FROM jsonb_array_elements(p_payload #> '{config,tools}') WITH ORDINALITY LOOP
    INSERT INTO wacrm.ai_agent_tools(account_id,agent_version_id,tool_id,position,enabled)
      VALUES(p_account_id,vid,(t->>'tool_id')::uuid,(t->>'position')::integer,(t->>'enabled')::boolean);
  END LOOP;
  INSERT INTO wacrm.ai_agent_knowledge(account_id,agent_version_id,selection_mode,file_ids)
    VALUES(p_account_id,vid,k->>'selection_mode',CASE WHEN k->>'selection_mode'='explicit' THEN
      ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(coalesce(k->'file_ids','[]'::jsonb)) x) ELSE NULL END);
  UPDATE wacrm.ai_agents SET published_version_id=vid,updated_at=now() WHERE account_id=p_account_id AND id=aid;
  RETURN jsonb_build_object('agent_id',aid,'version_id',vid,'version',n);
END $$;

CREATE OR REPLACE FUNCTION wacrm.rollback_ai_agent(
  p_account_id uuid, p_created_by uuid, p_agent_id uuid, p_version_id uuid
) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE source wacrm.ai_agent_versions; vid uuid := gen_random_uuid(); n integer;
BEGIN
  PERFORM 1 FROM wacrm.ai_agents WHERE account_id=p_account_id AND id=p_agent_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Agente não encontrado' USING ERRCODE='P0002'; END IF;
  SELECT * INTO source FROM wacrm.ai_agent_versions WHERE account_id=p_account_id AND agent_id=p_agent_id AND id=p_version_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Versão não encontrada' USING ERRCODE='P0002'; END IF;
  IF EXISTS (SELECT 1 FROM wacrm.ai_agent_knowledge k CROSS JOIN LATERAL unnest(k.file_ids) f(id)
    WHERE k.account_id=p_account_id AND k.agent_version_id=source.id AND NOT EXISTS (
      SELECT 1 FROM wacrm.knowledge_base_files WHERE account_id=p_account_id AND id=f.id)
  ) THEN RAISE EXCEPTION 'Arquivo da versão não existe na conta' USING ERRCODE='22023'; END IF;
  SELECT coalesce(max(version),0)+1 INTO n FROM wacrm.ai_agent_versions WHERE account_id=p_account_id AND agent_id=p_agent_id;
  INSERT INTO wacrm.ai_agent_versions(id,account_id,agent_id,version,config,prompt_content,composition,config_hash,created_by)
    VALUES(vid,p_account_id,p_agent_id,n,source.config,source.prompt_content,source.composition,source.config_hash,p_created_by);
  INSERT INTO wacrm.ai_agent_rules SELECT account_id,vid,rule_version_id,position,enabled FROM wacrm.ai_agent_rules WHERE account_id=p_account_id AND agent_version_id=source.id;
  INSERT INTO wacrm.ai_agent_tools SELECT account_id,vid,tool_id,position,enabled FROM wacrm.ai_agent_tools WHERE account_id=p_account_id AND agent_version_id=source.id;
  INSERT INTO wacrm.ai_agent_knowledge SELECT account_id,vid,selection_mode,file_ids FROM wacrm.ai_agent_knowledge WHERE account_id=p_account_id AND agent_version_id=source.id;
  UPDATE wacrm.ai_agents SET published_version_id=vid,updated_at=now() WHERE account_id=p_account_id AND id=p_agent_id;
  RETURN jsonb_build_object('version_id',vid,'version',n);
END $$;

CREATE OR REPLACE FUNCTION wacrm.delete_ai_agent(p_account_id uuid,p_agent_id uuid)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE used boolean := false;
BEGIN
  PERFORM 1 FROM wacrm.ai_agents WHERE account_id=p_account_id AND id=p_agent_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Agente não encontrado' USING ERRCODE='P0002'; END IF;
  -- Agente já fixado em algum run (179): preserva o histórico; a API orienta a desligar em vez de excluir.
  IF to_regclass('wacrm.flow_run_agent_bindings') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM wacrm.flow_run_agent_bindings WHERE account_id=$1 AND agent_id=$2)'
      INTO used USING p_account_id,p_agent_id;
    IF used THEN RAISE EXCEPTION 'agent_used_in_runs' USING ERRCODE='23503'; END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM wacrm.flow_nodes n JOIN wacrm.flows f ON f.id=n.flow_id
    WHERE f.account_id=p_account_id AND n.node_type='ai_agent' AND n.config->>'agent_id'=p_agent_id::text)
  THEN RAISE EXCEPTION 'Agente em uso: remova dos fluxos antes de excluir' USING ERRCODE='23503'; END IF;
  DELETE FROM wacrm.ai_agents WHERE account_id=p_account_id AND id=p_agent_id;
END $$;
REVOKE ALL ON FUNCTION wacrm.publish_ai_agent(uuid,uuid,uuid,text,jsonb),
  wacrm.rollback_ai_agent(uuid,uuid,uuid,uuid),wacrm.delete_ai_agent(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION wacrm.publish_ai_agent(uuid,uuid,uuid,text,jsonb),
  wacrm.rollback_ai_agent(uuid,uuid,uuid,uuid),wacrm.delete_ai_agent(uuid,uuid) TO service_role;
COMMIT;
NOTIFY pgrst,'reload schema';
