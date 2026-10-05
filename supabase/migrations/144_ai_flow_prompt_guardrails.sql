BEGIN;

-- Priority routes that must leave the main AI loop immediately.
INSERT INTO wacrm.flow_nodes(
  flow_id,node_key,node_type,config,position_x,position_y
)
VALUES (
  '66a59213-a13f-4820-bd71-a1dd5967e646',
  'handoff_contato_divergente',
  'handoff_team',
  '{"reason_code":"CONTATO_DIVERGENTE","reason_subcode":"PESSOA_OU_NUMERO_INCORRETO","note":"Pessoa informou que não é o destinatário da cobrança. Revisar cadastro/telefone antes de qualquer novo contato."}'::jsonb,
  1050,-430
)
ON CONFLICT (flow_id,node_key) DO UPDATE
SET config=EXCLUDED.config,
    position_x=EXCLUDED.position_x,
    position_y=EXCLUDED.position_y;

-- Add deterministic exit-code branches. OPT_OUT ends the flow after the
-- responder persists the suppression in wacrm.blacklist.
UPDATE wacrm.flow_nodes
SET config = jsonb_set(
  config,
  '{branches}',
  (config->'branches') || jsonb_build_array(
    jsonb_build_object(
      'id','branch-opt-out',
      'label','OPT_OUT',
      'combinator','and',
      'conditions',jsonb_build_array(jsonb_build_object(
        'value','#OPT_OUT',
        'subject','var',
        'operator','equals',
        'subject_key','ai_exit_code'
      )),
      'next_node_key','fim'
    ),
    jsonb_build_object(
      'id','branch-contato-divergente',
      'label','CONTATO_DIVERGENTE',
      'combinator','and',
      'conditions',jsonb_build_array(jsonb_build_object(
        'value','#CONTATO_DIVERGENTE',
        'subject','var',
        'operator','equals',
        'subject_key','ai_exit_code'
      )),
      'next_node_key','handoff_contato_divergente'
    )
  )
)
WHERE flow_id='66a59213-a13f-4820-bd71-a1dd5967e646'
  AND node_key='switch_resultado'
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(config->'branches') b
    WHERE b->>'id'='branch-opt-out'
  );

-- Keep the loop bounded. A missing exit code must not permit dozens of
-- customer-visible turns.
UPDATE wacrm.flow_nodes
SET config = jsonb_set(config,'{max_turns}','20'::jsonb)
WHERE flow_id='66a59213-a13f-4820-bd71-a1dd5967e646'
  AND node_key='agente_ddm';

-- Prompt guardrails are defense in depth. The responder classifies these
-- intents deterministically before the provider call, but the prompt must
-- still behave correctly if this node is reused elsewhere.
UPDATE wacrm.flow_nodes
SET config = jsonb_set(
  config,
  '{system_prompt_override}',
  to_jsonb(
    '## PRIORIDADE ABSOLUTA — ANTES DE PEDIR CPF
Estas regras têm precedência sobre qualquer fase de negociação:
- Se o cliente pedir para parar mensagens, sair da lista ou não receber novos contatos: confirme uma única vez e emita #OPT_OUT. NÃO peça CPF.
- Se disser que não é a pessoa citada, que o número está errado ou que a mensagem foi para outra pessoa: peça desculpas, NÃO peça CPF e emita #CONTATO_DIVERGENTE.
- Se disser que já pagou, já resolveu, já negociou, não reconhece a dívida, cancelou/trancou antes ou questiona o valor: NÃO negocie; emita #CONTESTACAO_DIVIDA.
- Se pedir atendente/humano/equipe explicitamente: emita #CLIENTE_PEDIU_HUMANO.
- Depois de qualquer um desses códigos, não continue a conversa no agente principal.

## EXIBIÇÃO DE INSTITUIÇÃO
- Nome mostrado ao cliente: use Dados.Apelido quando estiver preenchido e não vazio; caso contrário use Dados.Cliente.
- Nunca troque UNIFRAN/UNICID/UDF por "CRUZEIRO DO SUL" apenas porque Dados.Cliente contém a mantenedora.

## APRESENTAÇÃO FINANCEIRA SEGURA
- Na primeira apresentação após consultar débitos, informe somente a quantidade de débitos e a instituição. NÃO liste valores nominais, vencimentos ou mensalidades, salvo se o cliente pedir especificamente.
- PgtoAvista.ValorFinal deve ser descrito como "valor atualizado para quitação".
- Não anuncie percentual de desconto se isso puder parecer desconto sobre a soma de NominalPrinc. Se o cliente questionar divergência entre valor nominal e valor atualizado, emita #CONTESTACAO_DIVIDA.
- Nunca calcule soma, juros, desconto ou parcela por conta própria; use somente campos retornados pela integração.

' || (config->>'system_prompt_override')
  )
)
WHERE flow_id='66a59213-a13f-4820-bd71-a1dd5967e646'
  AND node_key='agente_ddm'
  AND position('## PRIORIDADE ABSOLUTA — ANTES DE PEDIR CPF' in config->>'system_prompt_override') = 0;

NOTIFY pgrst, 'reload schema';
COMMIT;
