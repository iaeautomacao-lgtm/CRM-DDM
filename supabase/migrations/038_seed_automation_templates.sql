-- 038_seed_automation_templates.sql
-- Seeds default automation templates for new accounts/users to show on presentation

CREATE OR REPLACE FUNCTION wacrm.seed_automation_templates()
RETURNS TRIGGER AS $$
DECLARE
  v_automation_id UUID;
  v_wait_step_id UUID;
BEGIN
  -- 1. TEMPLATE: Auto-Encerramento por Inatividade (4 Horas)
  INSERT INTO wacrm.automations (id, user_id, account_id, name, description, trigger_type, is_active)
  VALUES (
    uuid_generate_v4(),
    NEW.user_id,
    NEW.account_id,
    'Auto-Encerramento por Inatividade',
    'Encerra a conversa automaticamente após 4 horas sem resposta do cliente se o atendimento estiver sob controle da IA.',
    'keyword_match', -- Fallback generic trigger
    false -- Seeded inactive by default
  )
  RETURNING id INTO v_automation_id;

  -- Step 1: Wait 4 hours
  INSERT INTO wacrm.automation_steps (id, automation_id, step_type, step_config, position)
  VALUES (
    uuid_generate_v4(),
    v_automation_id,
    'wait',
    '{"unit": "hours", "amount": 4}'::jsonb,
    0
  )
  RETURNING id INTO v_wait_step_id;

  -- Step 2: Check condition (Tag "Atendimento Humano" NOT present)
  -- Step 3: Send message and close (child branches can be configured on front-end)
  INSERT INTO wacrm.automation_steps (automation_id, parent_step_id, branch, step_type, step_config, position)
  VALUES (
    v_automation_id,
    v_wait_step_id,
    'yes',
    'send_message',
    '{"text": "Como você ficou um tempo sem responder, estou encerrando este atendimento. Se precisar de algo, basta mandar uma nova mensagem! 😉"}'::jsonb,
    1
  );

  INSERT INTO wacrm.automation_steps (automation_id, parent_step_id, branch, step_type, step_config, position)
  VALUES (
    v_automation_id,
    v_wait_step_id,
    'yes',
    'close_conversation',
    '{}'::jsonb,
    2
  );


  -- 2. TEMPLATE: Abordagem Inicial de Cobrança
  INSERT INTO wacrm.automations (id, user_id, account_id, name, description, trigger_type, is_active)
  VALUES (
    uuid_generate_v4(),
    NEW.user_id,
    NEW.account_id,
    'Cobrança Ativa - DDM',
    'Disparado ao adicionar a etiqueta "Cobrar Cliente", iniciando a régua de cobrança padrão.',
    'tag_added',
    false
  )
  RETURNING id INTO v_automation_id;

  INSERT INTO wacrm.automation_steps (automation_id, step_type, step_config, position)
  VALUES (
    v_automation_id,
    'send_message',
    '{"text": "Olá! Sou a assistente do Grupo DDM. Identificamos uma pendência em aberto em nosso sistema e preparamos uma proposta especial para você regularizar hoje. Gostaria de conhecer as opções?"}'::jsonb,
    0
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to seed templates automatically when a new member joins an account
-- (Checks table account_members as the anchor for workspace access)
DROP TRIGGER IF EXISTS trigger_seed_automation_templates ON wacrm.account_members;
CREATE TRIGGER trigger_seed_automation_templates
AFTER INSERT ON wacrm.account_members
FOR EACH ROW
EXECUTE FUNCTION wacrm.seed_automation_templates();
