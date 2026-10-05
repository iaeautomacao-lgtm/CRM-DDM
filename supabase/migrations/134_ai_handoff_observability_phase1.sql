
BEGIN;

CREATE TABLE IF NOT EXISTS wacrm.ai_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  conversation_id uuid,
  flow_run_id uuid,
  flow_id uuid,
  node_key text,
  decision_type text NOT NULL,
  intent text,
  decision jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text,
  confidence numeric(5,4),
  needs_human boolean NOT NULL DEFAULT false,
  handoff_reason text,
  handoff_subreason text,
  ai_exit_code text,
  tool_name text,
  tool_status text,
  model text,
  prompt_version text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ai_decisions_confidence_check
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);

CREATE INDEX IF NOT EXISTS idx_ai_decisions_account_created
  ON wacrm.ai_decisions(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_decisions_flow_run
  ON wacrm.ai_decisions(flow_run_id, created_at DESC)
  WHERE flow_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_decisions_handoff_reason
  ON wacrm.ai_decisions(account_id, handoff_reason, created_at DESC)
  WHERE needs_human = true;

ALTER TABLE wacrm.ai_decisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.ai_decisions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON wacrm.ai_decisions TO service_role;

-- Official flow: keep the channel-bound unified flow active and archive legacy.
UPDATE wacrm.flows
SET status = 'archived',
    updated_at = clock_timestamp()
WHERE id = '1f9d046f-bcfc-436b-9835-ce6265c6ecdf'
  AND status = 'active';

-- Structured reasons on existing handoff nodes.
UPDATE wacrm.flow_nodes
SET config = config || '{"reason_code":"AGENDAMENTO","reason_subcode":"DATA_FUTURA_INFORMADA"}'::jsonb
WHERE flow_id = '66a59213-a13f-4820-bd71-a1dd5967e646'
  AND node_key = 'handoff_agendamento';

UPDATE wacrm.flow_nodes
SET config = config || '{"reason_code":"CPF_NAO_INFORMADO","reason_subcode":"RECUSA_APOS_DUAS_TENTATIVAS"}'::jsonb
WHERE flow_id = '66a59213-a13f-4820-bd71-a1dd5967e646'
  AND node_key = 'handoff_naoenviacpf';

UPDATE wacrm.flow_nodes
SET config = config || '{"reason_code":"TOOL_ERROR","reason_subcode":"API_DDM_APOS_RETRY"}'::jsonb
WHERE flow_id = '66a59213-a13f-4820-bd71-a1dd5967e646'
  AND node_key = 'handoff_instabilidade';

UPDATE wacrm.flow_nodes
SET config = config || '{"reason_code":"RECUSA_OUTRO","reason_subcode":"TODAS_OPCOES_RECUSADAS"}'::jsonb
WHERE flow_id = '66a59213-a13f-4820-bd71-a1dd5967e646'
  AND node_key = 'handoff_recusa';

UPDATE wacrm.flow_nodes
SET config = config || '{"reason_code":"INDEFINIDO","reason_subcode":"DEFAULT_SWITCH"}'::jsonb
WHERE flow_id = '66a59213-a13f-4820-bd71-a1dd5967e646'
  AND node_key = 'handoff_equipe';

-- Dedicated handoff nodes for causes that were previously grouped together.
INSERT INTO wacrm.flow_nodes(flow_id,node_key,node_type,config,position_x,position_y)
VALUES
('66a59213-a13f-4820-bd71-a1dd5967e646','handoff_cpf_nao_localizado','handoff_team',
 '{"reason_code":"CPF_NAO_LOCALIZADO","reason_subcode":"DUAS_TENTATIVAS_SEM_CADASTRO","note":"CPF não localizado após duas tentativas válidas. Revisar identificação/cadastro."}'::jsonb,1050,-250),
('66a59213-a13f-4820-bd71-a1dd5967e646','handoff_acordo_existente','handoff_team',
 '{"reason_code":"ACORDO_EXISTENTE","reason_subcode":"ACORDO_ATIVO_ENCONTRADO","note":"Cliente possui acordo ativo. Humano deve orientar sobre o acordo existente, sem criar novo acordo."}'::jsonb,1050,-100),
('66a59213-a13f-4820-bd71-a1dd5967e646','handoff_erro_efetivacao','handoff_team',
 '{"reason_code":"ERRO_EFETIVACAO","reason_subcode":"FORMALIZACAO_NAO_CONCLUIDA","note":"IA chegou à formalização, mas não conseguiu concluir o acordo. Revisar retorno da efetivação."}'::jsonb,1050,50),
('66a59213-a13f-4820-bd71-a1dd5967e646','handoff_pedido_humano','handoff_team',
 '{"reason_code":"CLIENTE_PEDIU_HUMANO","reason_subcode":"PEDIDO_EXPLICITO","note":"Cliente confirmou que prefere atendimento humano."}'::jsonb,1050,200),
('66a59213-a13f-4820-bd71-a1dd5967e646','handoff_contestacao','handoff_team',
 '{"reason_code":"CONTESTACAO_DIVIDA","reason_subcode":"DIVIDA_CONTESTADA_OU_PAGAMENTO_ALEGADO","note":"Cliente contesta a dívida, informa pagamento prévio ou pede cancelamento/retirada. Requer análise humana."}'::jsonb,1050,350),
('66a59213-a13f-4820-bd71-a1dd5967e646','handoff_fallback','handoff_team',
 '{"reason_code":"FALLBACK_EXAURIDO","reason_subcode":"SEM_PROGRESSO_APOS_RECUPERACAO","note":"Fluxo não conseguiu progredir após as tentativas previstas. Revisar histórico antes de responder."}'::jsonb,1050,500)
ON CONFLICT (flow_id,node_key) DO UPDATE
SET config = EXCLUDED.config,
    position_x = EXCLUDED.position_x,
    position_y = EXCLUDED.position_y;

-- Add structured switch branches exactly once.
UPDATE wacrm.flow_nodes
SET config = jsonb_set(
  config,
  '{branches}',
  (config->'branches') || jsonb_build_array(
    jsonb_build_object(
      'id','branch-cliente-pediu-humano','label','CLIENTE_PEDIU_HUMANO','combinator','and',
      'conditions',jsonb_build_array(jsonb_build_object(
        'value','#CLIENTE_PEDIU_HUMANO','subject','var','operator','equals','subject_key','ai_exit_code'
      )),
      'next_node_key','handoff_pedido_humano'
    ),
    jsonb_build_object(
      'id','branch-cpf-nao-localizado','label','CPF_NAO_LOCALIZADO','combinator','and',
      'conditions',jsonb_build_array(jsonb_build_object(
        'value','#CPF_NAO_LOCALIZADO','subject','var','operator','equals','subject_key','ai_exit_code'
      )),
      'next_node_key','handoff_cpf_nao_localizado'
    ),
    jsonb_build_object(
      'id','branch-acordo-existente','label','ACORDO_EXISTENTE','combinator','and',
      'conditions',jsonb_build_array(jsonb_build_object(
        'value','#ACORDO_EXISTENTE','subject','var','operator','equals','subject_key','ai_exit_code'
      )),
      'next_node_key','handoff_acordo_existente'
    ),
    jsonb_build_object(
      'id','branch-erro-efetivacao','label','ERRO_EFETIVACAO','combinator','and',
      'conditions',jsonb_build_array(jsonb_build_object(
        'value','#ERRO_EFETIVACAO','subject','var','operator','equals','subject_key','ai_exit_code'
      )),
      'next_node_key','handoff_erro_efetivacao'
    ),
    jsonb_build_object(
      'id','branch-contestacao-divida','label','CONTESTACAO_DIVIDA','combinator','and',
      'conditions',jsonb_build_array(jsonb_build_object(
        'value','#CONTESTACAO_DIVIDA','subject','var','operator','equals','subject_key','ai_exit_code'
      )),
      'next_node_key','handoff_contestacao'
    ),
    jsonb_build_object(
      'id','branch-fallback-exaurido','label','FALLBACK_EXAURIDO','combinator','and',
      'conditions',jsonb_build_array(jsonb_build_object(
        'value','#FALLBACK_EXAURIDO','subject','var','operator','equals','subject_key','ai_exit_code'
      )),
      'next_node_key','handoff_fallback'
    )
  )
)
WHERE flow_id = '66a59213-a13f-4820-bd71-a1dd5967e646'
  AND node_key = 'switch_resultado'
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(config->'branches') b
    WHERE b->>'id' = 'branch-cliente-pediu-humano'
  );

-- Prompt replacements are idempotent: when already updated, replace is a no-op.
UPDATE wacrm.flow_nodes
SET config = jsonb_set(
  config,
  '{system_prompt_override}',
  to_jsonb(
    replace(
      replace(
        replace(
          replace(
            replace(
              replace(
                replace(
                  config->>'system_prompt_override',
                  'SE tentativas_cpf_invalido >= 2:\n  Envie: "Infelizmente não consegui localizar seu cadastro com nenhum dos CPFs informados. Vou passar seu caso para nossa equipe analisar. Um momento!"\n  Emita: #EQUIPEHUMANA',
                  'SE tentativas_cpf_invalido >= 2:\n  Envie: "Infelizmente não consegui localizar seu cadastro com nenhum dos CPFs informados. Vou passar seu caso para nossa equipe analisar. Um momento!"\n  Emita: #CPF_NAO_LOCALIZADO'
                ),
                'SE houver acordo ativo:\nEnvie: "Encontrei um acordo ativo no seu cadastro! 📋 Vou encaminhar para nossa equipe verificar os detalhes com você. Um momento!"\nEmita: #EQUIPEHUMANA',
                'SE houver acordo ativo:\nEnvie: "Encontrei um acordo ativo no seu cadastro! 📋 Vou encaminhar para nossa equipe verificar os detalhes com você. Um momento!"\nEmita: #ACORDO_EXISTENTE'
              ),
              'Envie: "Tive um problema técnico para finalizar aqui. 😕 Vou encaminhar para nossa equipe concluir o acordo com você!"\nEmita: #EQUIPEHUMANA',
              'Envie: "Tive um problema técnico para finalizar aqui. 😕 Vou encaminhar para nossa equipe concluir o acordo com você!"\nEmita: #ERRO_EFETIVACAO'
            ),
            'Envie: "Não consegui registrar o acordo por aqui. 😕 Vou chamar nossa equipe para te ajudar a finalizar!"\nEmita: #EQUIPEHUMANA',
            'Envie: "Não consegui registrar o acordo por aqui. 😕 Vou chamar nossa equipe para te ajudar a finalizar!"\nEmita: #ERRO_EFETIVACAO'
          ),
          '### Cliente pede para falar com humano:\n"Claro! Vou te encaminhar para nossa equipe agora. Um minutinho! 👋"\nEmita: #EQUIPEHUMANA',
          '### Cliente pede para falar com humano:\n"Claro! Vou te encaminhar para nossa equipe agora. Um minutinho! 👋"\nEmita: #CLIENTE_PEDIU_HUMANO'
        ),
        'Envie: "Entendo sua situação e vou garantir que a equipe certa analise seu caso. 👍 Vou encaminhar agora!"\nEmita: #EQUIPEHUMANA\nNUNCA emita #RECUSA para contestações.',
        'Envie: "Entendo sua situação e vou garantir que a equipe certa analise seu caso. 👍 Vou encaminhar agora!"\nEmita: #CONTESTACAO_DIVIDA\nNUNCA emita #RECUSA para contestações.'
      ),
      'Envie: "Estou com dificuldades para continuar por aqui. 😕 Vou chamar nossa equipe para te ajudar!"\nEmita: #EQUIPEHUMANA',
      'Envie: "Estou com dificuldades para continuar por aqui. 😕 Vou chamar nossa equipe para te ajudar!"\nEmita: #FALLBACK_EXAURIDO'
    )
  )
)
WHERE flow_id = '66a59213-a13f-4820-bd71-a1dd5967e646'
  AND node_key = 'agente_ddm';

NOTIFY pgrst, 'reload schema';
COMMIT;
