-- Migration 152: heartbeat "IA trabalhando" + prompt da recuperação de recusa.
-- APLICAR MANUALMENTE no Supabase SQL Editor ANTES do deploy.
-- Conferir o schema live antes (CLAUDE.md). Idempotente.
--
-- 1. conversations.ai_in_progress_at
--    O responder (src/lib/ai/heartbeat.ts) grava o horário ao reservar a
--    mensagem do cliente e a cada etapa (tool, envio) e limpa ao terminar.
--    O vigia de IA travada (src/lib/flows/ai-watchdog.ts) não transfere a
--    conversa para humano enquanto a marca tiver menos de 2 min.
--    Sem a coluna o app continua funcionando (heartbeat é best-effort e o
--    vigia cai para a consulta antiga), só sem essa proteção.
--
-- 2. recovery_recusa (migration 138, fluxo 66a59213-…)
--    O engine agora estaciona no nó de recuperação e só o roda com a
--    PRÓXIMA mensagem do cliente. A pergunta "o que pesa mais…?" já foi
--    feita pelo agente principal (agente_ddm) junto com o #RECUSA; o prompt
--    passa a tratá-la como a pergunta de esclarecimento, para a recuperação
--    decidir com a resposta do cliente em vez de perguntar de novo.

BEGIN;

ALTER TABLE wacrm.conversations
  ADD COLUMN IF NOT EXISTS ai_in_progress_at timestamptz;

COMMENT ON COLUMN wacrm.conversations.ai_in_progress_at IS
  'Heartbeat da IA gerando resposta (responder.ts). Vigia de IA travada ignora a conversa enquanto < 2 min. NULL = IA parada.';

UPDATE wacrm.flow_nodes
SET config = jsonb_set(
  config,
  '{system_prompt_override}',
  to_jsonb(
    replace(
      config->>'system_prompt_override',
      '- Se o histórico mostrar que você JÁ fez essa pergunta de esclarecimento, não faça outra: escolha obrigatoriamente um código de saída.',
      '- Se o histórico mostrar que você JÁ fez essa pergunta de esclarecimento, não faça outra: escolha obrigatoriamente um código de saída.
- A pergunta do agente anterior logo antes da recusa ("o que mais pesa para você hoje: o valor, a data de pagamento ou você prefere não seguir com o acordo?" ou parecida) CONTA como a sua pergunta de esclarecimento. A última mensagem do cliente é a resposta a ela: classifique com um código de saída. Só pergunte de novo se essa resposta for realmente ambígua.'
    )
  )
)
WHERE flow_id = '66a59213-a13f-4820-bd71-a1dd5967e646'
  AND node_key = 'recovery_recusa'
  AND position('CONTA como a sua pergunta de esclarecimento' IN config->>'system_prompt_override') = 0
  AND position('- Se o histórico mostrar que você JÁ fez essa pergunta de esclarecimento, não faça outra: escolha obrigatoriamente um código de saída.' IN config->>'system_prompt_override') > 0;

NOTIFY pgrst, 'reload schema';
COMMIT;
