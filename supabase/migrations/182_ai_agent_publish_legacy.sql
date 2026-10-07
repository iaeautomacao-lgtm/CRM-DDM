-- 182: publicação de agentes legacy_v1 + ferramentas inline (Fase 4 — TASK15).
-- Depende da 177 e da 180. Idempotente (CREATE OR REPLACE). Aplicar no SQL Editor após a 180.
-- Antes: a RPC só aceitava sections_v1 e falhava (tool_id NULL) em agentes com ferramentas inline.
-- Agora: nova versão de agente legacy_v1 mantém legacy_v1; inline ficam no config e não geram vínculo.

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
  IF p_payload->>'composition' NOT IN ('sections_v1','legacy_v1') THEN
    RAISE EXCEPTION 'Composição inválida' USING ERRCODE='22023';
  END IF;
  -- legacy_v1 só ao publicar NOVA versão de agente cuja versão publicada já é legacy_v1 (sem regras separadas).
  IF p_payload->>'composition' = 'legacy_v1' THEN
    IF p_agent_id IS NULL OR jsonb_array_length(coalesce(p_payload->'rules','[]'::jsonb)) > 0 OR NOT EXISTS (
      SELECT 1 FROM wacrm.ai_agents a JOIN wacrm.ai_agent_versions v
        ON v.account_id=a.account_id AND v.agent_id=a.id AND v.id=a.published_version_id
      WHERE a.account_id=p_account_id AND a.id=aid AND v.composition='legacy_v1'
    ) THEN RAISE EXCEPTION 'legacy_v1 só vale para nova versão de agente legacy_v1, sem regras' USING ERRCODE='22023'; END IF;
  END IF;
  -- Serialização pela linha do agente: não há corrida no MAX(version)+1.
  SELECT coalesce(max(version),0)+1 INTO n FROM wacrm.ai_agent_versions WHERE account_id=p_account_id AND agent_id=aid;
  k := p_payload #> '{config,knowledge}';
  IF k->>'selection_mode'='explicit' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(coalesce(k->'file_ids','[]'::jsonb)) f(id)
    WHERE NOT EXISTS(SELECT 1 FROM wacrm.knowledge_base_files WHERE account_id=p_account_id AND id=f.id::uuid)
  ) THEN RAISE EXCEPTION 'Arquivo fora da conta' USING ERRCODE='22023'; END IF;
  INSERT INTO wacrm.ai_agent_versions(id,account_id,agent_id,version,config,prompt_content,composition,config_hash,created_by)
    VALUES(vid,p_account_id,aid,n,p_payload->'config',p_payload->>'prompt_content',p_payload->>'composition',p_payload->>'config_hash',p_created_by);
  FOR r IN SELECT * FROM jsonb_array_elements(p_payload->'rules') LOOP
    INSERT INTO wacrm.ai_rules(id,account_id,name) VALUES((r->>'rule_id')::uuid,p_account_id,'regra_' || (r->>'rule_id'));
    INSERT INTO wacrm.ai_rule_versions(id,account_id,rule_id,version,content,created_by)
      VALUES((r->>'rule_version_id')::uuid,p_account_id,(r->>'rule_id')::uuid,1,r->>'content',p_created_by);
    INSERT INTO wacrm.ai_agent_rules(account_id,agent_version_id,rule_version_id,position,enabled)
      VALUES(p_account_id,vid,(r->>'rule_version_id')::uuid,(r->>'position')::integer,(r->>'enabled')::boolean);
  END LOOP;
  FOR t IN SELECT value || jsonb_build_object('position',ordinality-1)
    FROM jsonb_array_elements(p_payload #> '{config,tools}') WITH ORDINALITY LOOP
    -- Ferramentas inline (definition, sem tool_id) vivem só no config; só o catálogo tem vínculo.
    IF t ? 'tool_id' THEN
      INSERT INTO wacrm.ai_agent_tools(account_id,agent_version_id,tool_id,position,enabled)
        VALUES(p_account_id,vid,(t->>'tool_id')::uuid,(t->>'position')::integer,(t->>'enabled')::boolean);
    END IF;
  END LOOP;
  INSERT INTO wacrm.ai_agent_knowledge(account_id,agent_version_id,selection_mode,file_ids)
    VALUES(p_account_id,vid,k->>'selection_mode',CASE WHEN k->>'selection_mode'='explicit' THEN
      ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(coalesce(k->'file_ids','[]'::jsonb)) x) ELSE NULL END);
  UPDATE wacrm.ai_agents SET published_version_id=vid,updated_at=now() WHERE account_id=p_account_id AND id=aid;
  RETURN jsonb_build_object('agent_id',aid,'version_id',vid,'version',n);
END $$;


NOTIFY pgrst, 'reload schema';
