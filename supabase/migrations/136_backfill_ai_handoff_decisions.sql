
BEGIN;

ALTER TABLE wacrm.ai_decisions
  ADD COLUMN IF NOT EXISTS source_event_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'wacrm.ai_decisions'::regclass
      AND conname = 'ai_decisions_source_event_id_key'
  ) THEN
    ALTER TABLE wacrm.ai_decisions
      ADD CONSTRAINT ai_decisions_source_event_id_key UNIQUE (source_event_id);
  END IF;
END;
$$;

INSERT INTO wacrm.ai_decisions (
  source_event_id,
  account_id,
  conversation_id,
  flow_run_id,
  flow_id,
  node_key,
  decision_type,
  decision,
  reason,
  needs_human,
  handoff_reason,
  handoff_subreason,
  ai_exit_code,
  ai_node,
  created_at
)
SELECT
  e.id,
  COALESCE(e.account_id, r.account_id),
  r.conversation_id,
  e.flow_run_id,
  COALESCE(e.flow_id, r.flow_id),
  e.node_key,
  'handoff',
  jsonb_build_object(
    'historical_backfill', true,
    'legacy_note', e.payload->>'note'
  ),
  'historical_backfill',
  true,
  COALESCE(
    NULLIF(e.payload->>'reason_code',''),
    CASE e.node_key
      WHEN 'transferir_para_equipe' THEN 'CPF_NAO_LOCALIZADO'
      WHEN 'transferir_para_equipe_3' THEN 'CLIENTE_PEDIU_HUMANO'
      WHEN 'handoff_recusa' THEN 'RECUSA_OUTRO'
      WHEN 'handoff_agendamento' THEN 'AGENDAMENTO'
      WHEN 'handoff_naoenviacpf' THEN 'CPF_NAO_INFORMADO'
      WHEN 'handoff_instabilidade' THEN 'TOOL_ERROR'
      WHEN 'handoff_cpf_nao_localizado' THEN 'CPF_NAO_LOCALIZADO'
      WHEN 'handoff_acordo_existente' THEN 'ACORDO_EXISTENTE'
      WHEN 'handoff_erro_efetivacao' THEN 'ERRO_EFETIVACAO'
      WHEN 'handoff_pedido_humano' THEN 'CLIENTE_PEDIU_HUMANO'
      WHEN 'handoff_contestacao' THEN 'CONTESTACAO_DIVIDA'
      WHEN 'handoff_fallback' THEN 'FALLBACK_EXAURIDO'
      ELSE 'INDEFINIDO'
    END
  ),
  COALESCE(
    NULLIF(e.payload->>'reason_subcode',''),
    CASE e.node_key
      WHEN 'transferir_para_equipe' THEN 'LEGACY_NAO_LOCALIZADO'
      WHEN 'transferir_para_equipe_3' THEN 'LEGACY_PEDIDO_HUMANO'
      WHEN 'handoff_recusa' THEN 'LEGACY_TODAS_OPCOES_RECUSADAS'
      WHEN 'handoff_agendamento' THEN 'LEGACY_DATA_FUTURA'
      WHEN 'handoff_naoenviacpf' THEN 'LEGACY_CPF_NAO_INFORMADO'
      WHEN 'handoff_naolocalizado' THEN 'LEGACY_CPF_ERRO_OU_HUMANO'
      WHEN 'handoff_equipe' THEN 'LEGACY_ACORDO_ERRO_OU_HUMANO'
      WHEN 'transferir_para_equipe_2' THEN 'LEGACY_SEM_NOTA'
      WHEN 'agente_de_ia' THEN 'LEGACY_SEM_NOTA'
      ELSE NULL
    END
  ),
  NULLIF(e.payload->>'ai_exit_code',''),
  ai.ai_node,
  e.created_at
FROM wacrm.flow_run_events e
JOIN wacrm.flow_runs r ON r.id = e.flow_run_id
LEFT JOIN LATERAL (
  SELECT prior.node_key AS ai_node
  FROM wacrm.flow_run_events prior
  WHERE prior.flow_run_id = e.flow_run_id
    AND prior.created_at <= e.created_at
    AND prior.node_type = 'ai_agent'
    AND prior.node_key IS NOT NULL
  ORDER BY prior.created_at DESC
  LIMIT 1
) ai ON true
WHERE e.event_type = 'handoff'
  AND COALESCE(e.account_id, r.account_id) IS NOT NULL
ON CONFLICT (source_event_id) DO NOTHING;

COMMIT;
