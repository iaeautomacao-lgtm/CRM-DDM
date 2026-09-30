-- Migration 114: wacrm.campaigns.batch_percent — suporte ao modo de
-- disparo "Segmentado" (envia um percentual da lista por rodada, em vez
-- de uma contagem fixa de batch_size).
-- APLICAR MANUALMENTE no Supabase SQL Editor ANTES do deploy.

-- Nullable — só populado quando o modo "Segmentado" é escolhido no
-- wizard (campanhas/page.tsx); toda campanha existente e todo outro
-- modo de disparo (imediato/balanceado/cauteloso/personalizado)
-- continua com batch_percent = NULL. startCampaign.ts resolve o
-- percentual contra o total real de contatos NO MOMENTO DO INÍCIO
-- (não na criação), e grava o batch_size absoluto resultante de volta
-- em campaigns.batch_size — o cron (cron/route.ts) e o resto do
-- pipeline de agendamento continuam lendo só batch_size, sem precisar
-- saber que "Segmentado" existe.
--
-- Não há coluna dispatch_mode nem CHECK constraint associado no schema
-- hoje — DispatchMode ("imediato"/"balanceado"/"cauteloso"/
-- "personalizado", e agora "segmentado") é só um conceito de UI,
-- inferido a partir de batch_size/batch_pause_seconds/intervalo_min/
-- intervalo_max (ver inferDispatchMode em campanhas/page.tsx). Por
-- isso não há nada para "adicionar 'segmentado' a" aqui — confirmado
-- antes de escrever esta migration (grep por "dispatch_mode" em todo o
-- repo não encontra nenhuma coluna com esse nome). startCampaign.ts
-- detecta o modo Segmentado por batch_percent IS NOT NULL, não por um
-- valor de enum.
ALTER TABLE wacrm.campaigns
  ADD COLUMN IF NOT EXISTS batch_percent INTEGER;
