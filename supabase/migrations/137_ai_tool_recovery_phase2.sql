
BEGIN;

INSERT INTO wacrm.flow_nodes(flow_id,node_key,node_type,config,position_x,position_y)
VALUES (
  '66a59213-a13f-4820-bd71-a1dd5967e646',
  'handoff_cpf_invalido',
  'handoff_team',
  '{"reason_code":"CPF_INVALIDO","reason_subcode":"CPF_INVALIDO_APOS_DUAS_TENTATIVAS","note":"Cliente forneceu dois CPFs diferentes que falharam na validação determinística. Revisar cadastro/identificação."}'::jsonb,
  1050,-325
)
ON CONFLICT (flow_id,node_key) DO UPDATE
SET config=EXCLUDED.config,
    position_x=EXCLUDED.position_x,
    position_y=EXCLUDED.position_y;

UPDATE wacrm.flow_nodes
SET config = jsonb_set(
  config,
  '{branches}',
  (config->'branches') || jsonb_build_array(
    jsonb_build_object(
      'id','branch-cpf-invalido',
      'label','CPF_INVALIDO',
      'combinator','and',
      'conditions',jsonb_build_array(jsonb_build_object(
        'value','#CPF_INVALIDO',
        'subject','var',
        'operator','equals',
        'subject_key','ai_exit_code'
      )),
      'next_node_key','handoff_cpf_invalido'
    )
  )
)
WHERE flow_id='66a59213-a13f-4820-bd71-a1dd5967e646'
  AND node_key='switch_resultado'
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(config->'branches') b
    WHERE b->>'id'='branch-cpf-invalido'
  );

UPDATE wacrm.flow_nodes
SET config = jsonb_set(
  config,
  '{system_prompt_override}',
  to_jsonb(
    replace(
      replace(
        replace(
          config->>'system_prompt_override',
          '### SE retornar {"error":"invalid_client"} em ALGUM registro:
- Tente novamente UMA vez para esse registro
- Se persistir: ignore esse registro e continue com os demais
- Se TODOS os registros retornarem esse erro (mesmo após retry):
  Envie: "Estou com uma instabilidade técnica aqui no momento. 😔 Nossa equipe entrará em contato com você em breve!"
  Emita: #INSTABILIDADE',
          '### SE consultar_debitos retornar TOOL_INVALID_CLIENT, TOOL_TIMEOUT, TOOL_RATE_LIMIT, TOOL_SERVER_ERROR ou TOOL_NETWORK_ERROR em ALGUM registro:
- O runtime JÁ executou as tentativas automáticas seguras; NÃO repita a mesma tool manualmente
- Ignore somente o registro que falhou e continue com os demais registros válidos
- Se TODOS os registros falharem após o recovery automático:
  Envie: "Estou com uma instabilidade técnica aqui no momento. 😔 Nossa equipe entrará em contato com você em breve!"
  Emita: #INSTABILIDADE'
        ),
        '### SE retornar erro de timeout em ALGUM registro:
- Tente novamente UMA vez
- Se persistir: ignore e continue com os demais
- Se TODOS os registros falharem por timeout:
  Envie: "Estou com uma instabilidade técnica aqui no momento. 😔 Nossa equipe entrará em contato com você em breve!"
  Emita: #INSTABILIDADE',
        '### SE consultar_debitos retornar TOOL_PROVIDER_ERROR, TOOL_HTTP_ERROR ou TOOL_SCHEMA_ERROR em ALGUM registro:
- NÃO repita automaticamente e NÃO invente parâmetros
- Ignore somente o registro que falhou se houver outro registro válido
- Se TODOS os registros falharem:
  Envie: "Tive um problema técnico para consultar seus dados. Vou encaminhar para nossa equipe continuar o atendimento."
  Emita: #INSTABILIDADE'
      ),
      '### SE efetiva_acordo retornar erro:
- Não tente novamente
Envie: "Não consegui registrar o acordo por aqui. 😕 Vou chamar nossa equipe para te ajudar a finalizar!"
Emita: #ERRO_EFETIVACAO',
      '### SE efetiva_acordo retornar qualquer erro (incluindo timeout, 429, 5xx, TOOL_PROVIDER_ERROR ou falha de rede):
- NÃO tente novamente. efetiva_acordo possui efeito colateral e um timeout pode ocorrer depois de o acordo já ter sido criado.
- Preserve idDev, cli e Parc usados na tentativa para o handoff.
Envie: "Não consegui confirmar o registro do acordo por aqui. 😕 Vou chamar nossa equipe para verificar e finalizar com segurança!"
Emita: #ERRO_EFETIVACAO'
    )
  )
)
WHERE flow_id='66a59213-a13f-4820-bd71-a1dd5967e646'
  AND node_key='agente_ddm';

NOTIFY pgrst, 'reload schema';
COMMIT;
