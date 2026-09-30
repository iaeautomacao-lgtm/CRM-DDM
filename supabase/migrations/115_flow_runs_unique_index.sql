-- Migration 115: amplia idx_one_active_run_per_contact para cobrir
-- também 'paused_by_agent', não só 'active'.
-- APLICAR MANUALMENTE no Supabase SQL Editor ANTES do deploy.

-- Por quê: um run pausado por um agente (send/route.ts marca
-- flow_runs.status = 'paused_by_agent' quando o agente responde
-- manualmente) não contava para o índice único parcial original
-- (017_account_sharing.sql), então nada no banco impedia um segundo
-- run 'active' de ser inserido para o mesmo contato enquanto o
-- primeiro ficava pausado e órfão — a única proteção era um guard de
-- aplicação em dispatchInboundToFlows/loadActiveRunForContact
-- (engine.ts), sujeito à mesma janela de corrida que o índice existe
-- pra fechar em primeiro lugar. Isso amplia a garantia pro nível do
-- banco: "no máximo um run active-ou-paused por (account_id,
-- contact_id)" — startNewRun já trata 23505 (unique_violation) como
-- "outro webhook está iniciando o run", então nenhuma mudança de
-- código é necessária ali além da própria checagem de aplicação já
-- adicionada em engine.ts.
DROP INDEX IF EXISTS wacrm.idx_one_active_run_per_contact;

CREATE UNIQUE INDEX idx_one_active_run_per_contact
  ON wacrm.flow_runs (account_id, contact_id)
  WHERE status IN ('active', 'paused_by_agent');
