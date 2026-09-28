-- Migration 113: adiciona 'warning' ao CHECK constraint de
-- wacrm.whatsapp_config.status — terceiro estado entre 'connected' e
-- 'disconnected', para um canal tecnicamente ativo mas com sinais de
-- degradação (token válido porém last_registration_error não nulo no
-- Meta; sessão WORKING porém sem atividade de mensagens há mais de
-- 24h no WAHA).
-- APLICAR MANUALMENTE no Supabase SQL Editor ANTES do deploy.

-- Schema only: GET /api/whatsapp/config já computa esse terceiro
-- estado ao vivo a cada request (ver route.ts) e o retorna como
-- `status`/`warning_reason`/`warning_message` por canal — nada aqui
-- passa a escrever 'warning' na coluna automaticamente. Os únicos
-- INSERT/UPDATE que gravam `status` (POST, na criação/registro Meta)
-- continuam só conhecendo 'connected'/'disconnected' no momento do
-- save; esta migration apenas destrava o valor no schema, mesmo
-- padrão de 015_whatsapp_config_registration.sql (colunas
-- diagnósticas que a UI computa por cima, não que todo write path já
-- preenche).
ALTER TABLE wacrm.whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_status_check;

ALTER TABLE wacrm.whatsapp_config
  ADD CONSTRAINT whatsapp_config_status_check
  CHECK (status IN ('connected', 'disconnected', 'warning'));
