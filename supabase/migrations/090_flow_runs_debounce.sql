-- Migration 090: debounce do ai_agent (BEN/Aleh) coordenado via banco.
-- APLICAR MANUALMENTE ANTES DO DEPLOY.

-- aiAgentReplyDebounceTimers (src/lib/flows/engine.ts) era um Map em
-- memória de módulo — só coordena duas mensagens do mesmo cliente
-- chegando poucos segundos uma da outra se ambas as requisições HTTP
-- caírem no MESMO processo Node. Com mais de um worker Phusion
-- Passenger, cada processo tem seu próprio Map vazio e a IA pode
-- responder duas vezes à mesma janela de mensagens. debounce_until
-- move essa coordenação pro banco, visível a todos os workers.
ALTER TABLE wacrm.flow_runs
  ADD COLUMN IF NOT EXISTS debounce_until timestamptz;

-- "Bump" atômico do fim da janela de debounce — chamado a cada
-- mensagem inbound que cai num run em ai_agent. Sempre grava um novo
-- debounce_until (sem condição no WHERE), replicando o comportamento
-- original de "cada mensagem nova reinicia o relógio, cancelando quem
-- estava esperando": o caller compara o valor retornado aqui com o que
-- está gravado no banco depois de esperar AI_AGENT_REPLY_DEBOUNCE_MS
-- (engine.ts) — se ninguém regravou debounce_until nesse meio-tempo,
-- este caller foi a última mensagem da janela e prossegue; senão,
-- uma mensagem mais nova o superou e ele desiste.
CREATE OR REPLACE FUNCTION wacrm.bump_ai_agent_debounce(p_run_id uuid)
RETURNS timestamptz
LANGUAGE sql
AS $$
  UPDATE wacrm.flow_runs
  SET debounce_until = now() + interval '4 seconds'
  WHERE id = p_run_id
  RETURNING debounce_until;
$$;
