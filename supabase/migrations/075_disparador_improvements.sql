-- Migration 075: melhorias no disparador (claim atômico, stats agregadas)
-- APLICAR MANUALMENTE no Supabase SQL Editor ANTES do deploy.
--
-- Schema verificado ao vivo em 2026-09-16 via
-- GET {SUPABASE_URL}/rest/v1/ (Accept-Profile: wacrm) antes de escrever
-- este arquivo. Achados relevantes:
--   - wacrm.disp_message_queue JÁ TEM `tentativas integer default 0` e
--     `updated_at timestamptz default now()` — não recriadas aqui.
--   - wacrm.disp_message_queue NÃO TEM `erro_permanente` — adicionada abaixo.
--   - A coluna de mensagem de erro se chama `erro` (não `log`).
--   - Nem claim_queue_item nem get_campaign_stats existem ainda.
--   - wacrm.increment_campaign_metric já existe (usada por processQueue.ts,
--     não mexida aqui).
--
-- O código em src/lib/disparador/processQueue.ts e
-- src/app/(dashboard)/disparador/page.tsx já funciona SEM esta migration
-- (fallback via SELECT+UPDATE condicional e agregação no cliente,
-- respectivamente) — aplicar isto é uma melhoria de performance/concorrência,
-- não um requisito de correção.

-- Coluna adicional (a única que falta — tentativas já existe)
ALTER TABLE wacrm.disp_message_queue
  ADD COLUMN IF NOT EXISTS erro_permanente boolean NOT NULL DEFAULT false;

-- Claim atômico do próximo item agendado de uma campanha (CREATE OR REPLACE
-- é idempotente). FOR UPDATE SKIP LOCKED evita que dois pollers concorrentes
-- (worker.ts / cron) fiquem bloqueados esperando a mesma linha — cada um
-- pula para o próximo candidato livre em vez de travar.
CREATE OR REPLACE FUNCTION wacrm.claim_queue_item(p_campaign_id uuid)
RETURNS wacrm.disp_message_queue
LANGUAGE plpgsql
AS $$
DECLARE
  v_item wacrm.disp_message_queue;
BEGIN
  SELECT * INTO v_item
  FROM wacrm.disp_message_queue
  WHERE campaign_id = p_campaign_id
    AND status = 'agendado'
    AND (scheduled_at IS NULL OR scheduled_at <= now())
    AND COALESCE(erro_permanente, false) = false
  ORDER BY scheduled_at ASC NULLS FIRST
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_item IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE wacrm.disp_message_queue
  SET status = 'enviando', updated_at = now()
  WHERE id = v_item.id;

  v_item.status := 'enviando';
  RETURN v_item;
END;
$$;

-- RPC de estatísticas agregadas — evita trazer todas as linhas da fila para
-- o cliente só para contar por status (ver disparador/page.tsx).
CREATE OR REPLACE FUNCTION wacrm.get_campaign_stats(p_campaign_ids uuid[])
RETURNS TABLE(campaign_id uuid, status text, qty bigint)
LANGUAGE sql
AS $$
  SELECT campaign_id, status, COUNT(*) as qty
  FROM wacrm.disp_message_queue
  WHERE campaign_id = ANY(p_campaign_ids)
  GROUP BY campaign_id, status;
$$;
