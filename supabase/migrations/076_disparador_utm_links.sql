-- Migration 076: persiste o mapeamento telefone -> link UTM personalizado
-- gerado no wizard de campanhas, para que start/route.ts consiga resolver
-- um valor por-contato ao montar template_variable_map (ver
-- src/app/(dashboard)/disparador/campanhas/page.tsx: handleGerarUTM).
-- APLICAR MANUALMENTE no Supabase SQL Editor ANTES do deploy.
--
-- Schema verificado ao vivo em 2026-09-16 via
-- GET {SUPABASE_URL}/rest/v1/ (Accept-Profile: wacrm):
--   - wacrm.contacts não tem coluna de CPF, então a chave de junção aqui é
--     telefone, não CPF. Usa o mesmo valor de wacrm.contacts.phone_normalized
--     (coluna gerada, digits-only — ver comentário em
--     src/lib/contacts/dedupe.ts) via normalizePhone() de
--     src/lib/whatsapp/phone-utils.ts, para casar exatamente com o que
--     start/route.ts já lê da tabela contacts.
--   - Nenhuma tabela `disparador_utm_links` existe ainda.
--   - migration 075 (claim_queue_item / get_campaign_stats) já está
--     aplicada em produção.
--
-- Por que campaign_id é nullable + draft_id: o wizard gera os links no
-- Step 2 (import de CSV), antes de a campanha existir como linha em
-- wacrm.campaigns (isso só acontece no submit do Step 3). draft_id é um
-- uuid gerado no cliente para a sessão de criação; assim que a campanha é
-- de fato criada, o cliente atualiza campaign_id via draft_id (ver
-- handleSubmit). Ao editar uma campanha já existente (editingId), o
-- campaign_id real já é conhecido e draft_id fica null.
CREATE TABLE IF NOT EXISTS wacrm.disparador_utm_links (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  campaign_id uuid REFERENCES wacrm.campaigns(id) ON DELETE CASCADE,
  draft_id uuid,
  phone_normalized text NOT NULL,
  link_curto text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_disparador_utm_links_campaign_phone
  ON wacrm.disparador_utm_links (campaign_id, phone_normalized);

CREATE INDEX IF NOT EXISTS idx_disparador_utm_links_draft
  ON wacrm.disparador_utm_links (draft_id)
  WHERE draft_id IS NOT NULL;

-- Sem RLS própria — mesmo modelo hoje aplicado a wacrm.campaigns e
-- wacrm.disp_message_queue (ver comentários "has no RLS yet" no código),
-- não uma regressão introduzida por esta migration.
