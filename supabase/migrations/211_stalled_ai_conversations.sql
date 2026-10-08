-- ============================================================
-- 211_stalled_ai_conversations.sql
--
-- Vigia de IA travada (PRD 13 — IA-09): resolver NO BANCO quem está travado.
--
-- Problema (src/lib/flows/ai-watchdog.ts): o vigia lia as 50 conversas abertas MAIS ANTIGAS da janela e só depois,
-- em código, descartava as que não interessam (heartbeat fresco, já respondida, sem run ativo, run fora de nó de IA),
-- com ~4 consultas por candidata (N+1). Conversas que nunca serão tratadas (fila humana esperando, run em botões/lista)
-- ocupavam as 50 vagas e as travadas de IA mais novas nunca entravam na varredura.
--
-- O que esta migration faz: wacrm.stalled_ai_conversations(...) devolve, numa consulta só, SÓ as conversas que o vigia
-- trata — com o MESMO critério de antes, agora aplicado antes do limite:
--   conversa: status 'open', sem atendente, última mensagem do cliente entre p_not_older_than e p_stalled_before;
--   IA não está trabalhando: ai_in_progress_at nulo ou <= p_heartbeat_after (isAiHeartbeatFresh: mais novo que 120 s = fresco);
--   ninguém respondeu: não existe mensagem não-cliente depois da última do cliente;
--   run ativo da conversa com current_node_key preenchido, parado num nó node_type = 'ai_agent'.
-- ORDER BY last_customer_message_at (as mais antigas primeiro), id; LIMIT p_limit (teto 200).
-- O resto do vigia (encerrar o run com guarda de status, mover a conversa, eventos, ai_decisions) NÃO muda.
--
-- COMPATIBILIDADE: sem a função (PGRST202/42883) o app cai no caminho antigo. Pode ser aplicada antes OU depois do deploy.
--
-- PRÉ-CHECK (rodar antes):
--   SELECT to_regclass('wacrm.conversations'), to_regclass('wacrm.flow_runs'), to_regclass('wacrm.flow_nodes'), to_regclass('wacrm.messages');
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema='wacrm' AND table_name='conversations'
--      AND column_name IN ('last_customer_message_at','ai_in_progress_at','assigned_agent_id');   -- 3 linhas (128 e 152)
--   SELECT to_regprocedure('wacrm.stalled_ai_conversations(timestamptz,timestamptz,timestamptz,integer)');   -- NULL antes
--
-- ÍNDICE DE APOIO: 211b (arquivo próprio, CONCURRENTLY). Não existe hoje índice por last_customer_message_at; os demais
-- caminhos já têm índice (messages.conversation_id; flow_runs ativos são poucos: idx_flow_runs_active_advanced).
--
-- ROLLBACK: DROP FUNCTION IF EXISTS wacrm.stalled_ai_conversations(timestamptz, timestamptz, timestamptz, integer);
--
-- Idempotente — pode rodar mais de uma vez.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.conversations') IS NULL OR to_regclass('wacrm.flow_runs') IS NULL
     OR to_regclass('wacrm.flow_nodes') IS NULL OR to_regclass('wacrm.messages') IS NULL THEN
    RAISE EXCEPTION '211: tabelas de conversas/fluxos/mensagens ausentes';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'wacrm' AND table_name = 'conversations'
         AND column_name IN ('last_customer_message_at', 'ai_in_progress_at', 'assigned_agent_id')) <> 3 THEN
    RAISE EXCEPTION '211: aplique as migrations 128 (last_customer_message_at) e 152 (ai_in_progress_at) antes';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION wacrm.stalled_ai_conversations(
  p_stalled_before timestamptz,
  p_not_older_than timestamptz,
  p_heartbeat_after timestamptz,
  p_limit integer DEFAULT 50
)
RETURNS TABLE(
  conversation_id uuid,
  account_id uuid,
  last_customer_message_at timestamptz,
  ai_in_progress_at timestamptz,
  run_id uuid,
  flow_id uuid,
  current_node_key text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT c.id, c.account_id, c.last_customer_message_at, c.ai_in_progress_at, r.id, r.flow_id, r.current_node_key
  FROM wacrm.conversations c
  JOIN LATERAL (
    SELECT fr.id, fr.flow_id, fr.current_node_key
    FROM wacrm.flow_runs fr
    WHERE fr.conversation_id = c.id AND fr.status = 'active'
    ORDER BY fr.id
    LIMIT 1
  ) r ON r.current_node_key IS NOT NULL
  WHERE c.status = 'open'
    AND c.assigned_agent_id IS NULL
    AND c.last_customer_message_at < p_stalled_before
    AND c.last_customer_message_at > p_not_older_than
    AND (c.ai_in_progress_at IS NULL OR p_heartbeat_after IS NULL OR c.ai_in_progress_at <= p_heartbeat_after)
    AND NOT EXISTS (
      SELECT 1 FROM wacrm.messages m
      WHERE m.conversation_id = c.id
        AND m.sender_type <> 'customer'
        AND m.created_at > c.last_customer_message_at
    )
    AND EXISTS (
      SELECT 1 FROM wacrm.flow_nodes n
      WHERE n.flow_id = r.flow_id AND n.node_key = r.current_node_key AND n.node_type = 'ai_agent'
    )
  ORDER BY c.last_customer_message_at, c.id
  LIMIT LEAST(200, GREATEST(1, COALESCE(p_limit, 50)));
$$;

REVOKE ALL ON FUNCTION wacrm.stalled_ai_conversations(timestamptz, timestamptz, timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.stalled_ai_conversations(timestamptz, timestamptz, timestamptz, integer) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
