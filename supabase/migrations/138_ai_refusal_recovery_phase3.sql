
BEGIN;

-- Main RECUSA no longer goes straight to human. It enters a constrained
-- recovery agent that can ask at most one clarification before deciding.
INSERT INTO wacrm.flow_nodes(
  flow_id,node_key,node_type,config,position_x,position_y
)
VALUES (
  '66a59213-a13f-4820-bd71-a1dd5967e646',
  'recovery_recusa',
  'ai_agent',
  jsonb_build_object(
    'mode','loop',
    'max_turns',2,
    'next_node_key','switch_recovery_recusa',
    'herdar_contexto_anterior',true,
    'tools','[]'::jsonb,
    'system_prompt_override',
'Você é o classificador de recuperação de recusa do Grupo DDM.

OBJETIVO:
Antes de encerrar uma negociação, entender se a recusa é realmente final ou se existe uma objeção recuperável.

REGRAS:
- NÃO invente desconto, parcela, prazo, condição ou autorização comercial.
- NÃO chame ferramentas.
- Use o histórico da conversa e os dados já obtidos anteriormente.
- Nunca impeça o cliente de falar com humano.
- Faça no máximo UMA pergunta curta de esclarecimento.
- Se o histórico mostrar que você JÁ fez essa pergunta de esclarecimento, não faça outra: escolha obrigatoriamente um código de saída.
- Quando emitir um código, emita SOMENTE o código, sem texto adicional.

SAÍDAS:

#RECUPERADO
Use quando o cliente demonstrar abertura para continuar negociando, por exemplo:
- valor/parcela ficou alto;
- não tem dinheiro agora;
- quer outra condição;
- pergunta se pode pagar em outra data;
- quer entender melhor uma opção;
- diz que toparia se determinada condição já disponível servir.
Não prometa essa condição aqui. O agente principal continuará a negociação.

#RECUSA_CONFIRMADA
Use quando o cliente confirmar claramente que não quer seguir, mesmo após a tentativa de entender a objeção:
- não quero;
- não vou pagar;
- não tenho interesse;
- pode encerrar;
- não quero acordo.

#CLIENTE_PEDIU_HUMANO
Use se o cliente pedir explicitamente atendente, pessoa, humano ou equipe.

#CONTESTACAO_DIVIDA
Use se o cliente disser que:
- a dívida não é dele;
- o valor está errado;
- já pagou;
- quer cancelar/retirar a cobrança;
- contesta a existência do débito.

#FALLBACK_EXAURIDO
Use somente se, mesmo após uma pergunta curta de esclarecimento, ainda não for possível classificar com segurança.

SE A PRIMEIRA RESPOSTA FOR AMBÍGUA:
Faça apenas uma pergunta curta, por exemplo:
"Entendi. O que pesa mais para você hoje: o valor, a data de pagamento ou você prefere não seguir com o acordo?"

Não emita código nessa primeira pergunta ambígua.'
  ),
  760,20
),
(
  '66a59213-a13f-4820-bd71-a1dd5967e646',
  'switch_recovery_recusa',
  'switch',
  jsonb_build_object(
    'default_next','handoff_fallback',
    'branches',jsonb_build_array(
      jsonb_build_object(
        'id','recovery-recuperado',
        'label','RECUPERADO',
        'combinator','and',
        'conditions',jsonb_build_array(jsonb_build_object(
          'subject','var','subject_key','ai_exit_code',
          'operator','equals','value','#RECUPERADO'
        )),
        'next_node_key','agente_ddm'
      ),
      jsonb_build_object(
        'id','recovery-recusa-confirmada',
        'label','RECUSA_CONFIRMADA',
        'combinator','and',
        'conditions',jsonb_build_array(jsonb_build_object(
          'subject','var','subject_key','ai_exit_code',
          'operator','equals','value','#RECUSA_CONFIRMADA'
        )),
        'next_node_key','handoff_recusa'
      ),
      jsonb_build_object(
        'id','recovery-pediu-humano',
        'label','CLIENTE_PEDIU_HUMANO',
        'combinator','and',
        'conditions',jsonb_build_array(jsonb_build_object(
          'subject','var','subject_key','ai_exit_code',
          'operator','equals','value','#CLIENTE_PEDIU_HUMANO'
        )),
        'next_node_key','handoff_pedido_humano'
      ),
      jsonb_build_object(
        'id','recovery-contestacao',
        'label','CONTESTACAO_DIVIDA',
        'combinator','and',
        'conditions',jsonb_build_array(jsonb_build_object(
          'subject','var','subject_key','ai_exit_code',
          'operator','equals','value','#CONTESTACAO_DIVIDA'
        )),
        'next_node_key','handoff_contestacao'
      ),
      jsonb_build_object(
        'id','recovery-fallback',
        'label','FALLBACK_EXAURIDO',
        'combinator','and',
        'conditions',jsonb_build_array(jsonb_build_object(
          'subject','var','subject_key','ai_exit_code',
          'operator','equals','value','#FALLBACK_EXAURIDO'
        )),
        'next_node_key','handoff_fallback'
      )
    )
  ),
  1080,20
)
ON CONFLICT (flow_id,node_key) DO UPDATE
SET config=EXCLUDED.config,
    position_x=EXCLUDED.position_x,
    position_y=EXCLUDED.position_y;

-- Re-route the existing RECUSA branch into recovery.
UPDATE wacrm.flow_nodes
SET config = jsonb_set(
  config,
  '{branches}',
  (
    SELECT jsonb_agg(
      CASE
        WHEN b->>'id'='branch-recusa'
        THEN jsonb_set(b,'{next_node_key}',to_jsonb('recovery_recusa'::text))
        ELSE b
      END
    )
    FROM jsonb_array_elements(config->'branches') b
  )
)
WHERE flow_id='66a59213-a13f-4820-bd71-a1dd5967e646'
  AND node_key='switch_resultado';

-- A human handoff now means recusa survived recovery.
UPDATE wacrm.flow_nodes
SET config = config || jsonb_build_object(
  'reason_code','RECUSA_OUTRO',
  'reason_subcode','CONFIRMADA_APOS_RECOVERY',
  'note','Cliente confirmou que não deseja seguir após a tentativa de entender a objeção.'
)
WHERE flow_id='66a59213-a13f-4820-bd71-a1dd5967e646'
  AND node_key='handoff_recusa';

-- Main agent no longer closes the conversation when it first sees a clear
-- refusal. It opens one recovery question and yields control to recovery_recusa.
UPDATE wacrm.flow_nodes
SET config = jsonb_set(
  config,
  '{system_prompt_override}',
  to_jsonb(
    replace(
      config->>'system_prompt_override',
      'SE recusa clara após TODAS as opções:
Envie: "Tudo bem, entendemos. 🤝 Quando quiser regularizar, a gente está aqui! Nossa equipe fica à disposição."
Emita: #RECUSA',
      'SE recusa clara após TODAS as opções:
Envie: "Entendo. Antes de encerrar, posso entender o que mais pesa para você hoje: o valor, a data de pagamento ou você prefere não seguir com o acordo?"
Emita: #RECUSA'
    )
  )
)
WHERE flow_id='66a59213-a13f-4820-bd71-a1dd5967e646'
  AND node_key='agente_ddm';

NOTIFY pgrst, 'reload schema';
COMMIT;
