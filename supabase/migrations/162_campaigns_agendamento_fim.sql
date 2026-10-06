-- Migration 162: wacrm.campaigns.agendamento_fim — data e hora final
-- escolhidas no assistente "Nova campanha" (V2).
--
-- O assistente pede data/hora inicial e data/hora final (horário de
-- Brasília). A hora inicial e a final viram a janela diária
-- (janela_inicio/janela_fim) e o envio acontece só em dia útil
-- (dias_envio = seg–sex). A data final é REFERÊNCIA: se a base não terminar
-- até lá, o envio continua no próximo dia útil, no mesmo intervalo de horas
-- (decisão de 06/10). A coluna só guarda o que foi escolhido, para a edição
-- e a comparação com a previsão de término. O motor não lê esta coluna.
--
-- APLICAR MANUALMENTE no Supabase SQL Editor, de preferência ANTES do
-- deploy. O código tolera a coluna ausente (criação/edição gravam sem ela e
-- a edição sugere a data final pela previsão), mas a data escolhida se perde.
-- Idempotente.

BEGIN;

ALTER TABLE wacrm.campaigns
  ADD COLUMN IF NOT EXISTS agendamento_fim timestamptz NULL;

COMMENT ON COLUMN wacrm.campaigns.agendamento_fim IS
  'Data/hora final escolhida no assistente (referência). O envio continua no próximo dia útil, na mesma janela, se a base não terminar até lá.';

COMMIT;

NOTIFY pgrst, 'reload schema';
