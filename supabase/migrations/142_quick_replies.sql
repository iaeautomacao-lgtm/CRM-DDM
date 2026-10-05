-- Migration 142: respostas rápidas do Inbox.
-- APLICAR MANUALMENTE no Supabase SQL Editor ANTES do deploy.
-- Conferir o schema live antes (CLAUDE.md). Número 142: 134–138 são do PR #13
-- (IA/handoff) e 139–141 do PR #16 (supervisor); esta migration não
-- depende de nenhuma delas.
--
-- Textos prontos da conta: o atendente digita "/atalho" no campo de
-- mensagem (ou abre a lista pelo botão) e o texto entra no campo, com
-- {nome}, {primeiro_nome} e {atendente} já preenchidos, para revisar e
-- enviar. Todos os membros leem; só owner/admin cadastram (tela
-- /respostas-rapidas).

BEGIN;

CREATE TABLE IF NOT EXISTS wacrm.quick_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  -- Sem a barra: "boasvindas" → o atendente digita "/boasvindas".
  shortcut text NOT NULL CHECK (shortcut ~ '^[a-z0-9_-]{1,30}$'),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 80),
  content text NOT NULL CHECK (char_length(btrim(content)) BETWEEN 1 AND 4000),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, shortcut)
);

ALTER TABLE wacrm.quick_replies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS quick_replies_select ON wacrm.quick_replies;
CREATE POLICY quick_replies_select ON wacrm.quick_replies
  FOR SELECT USING (wacrm.is_account_member(account_id));

DROP POLICY IF EXISTS quick_replies_insert ON wacrm.quick_replies;
CREATE POLICY quick_replies_insert ON wacrm.quick_replies
  FOR INSERT WITH CHECK (wacrm.is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS quick_replies_update ON wacrm.quick_replies;
CREATE POLICY quick_replies_update ON wacrm.quick_replies
  FOR UPDATE USING (wacrm.is_account_member(account_id, 'admin'))
  WITH CHECK (wacrm.is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS quick_replies_delete ON wacrm.quick_replies;
CREATE POLICY quick_replies_delete ON wacrm.quick_replies
  FOR DELETE USING (wacrm.is_account_member(account_id, 'admin'));

GRANT SELECT, INSERT, UPDATE, DELETE ON wacrm.quick_replies TO authenticated;
GRANT ALL ON wacrm.quick_replies TO service_role;

-- Auditoria (131): criar/alterar/excluir aparece em Relatórios → Auditoria.
DROP TRIGGER IF EXISTS trg_audit_quick_replies ON wacrm.quick_replies;
CREATE TRIGGER trg_audit_quick_replies
  AFTER INSERT OR UPDATE OR DELETE ON wacrm.quick_replies
  FOR EACH ROW EXECUTE FUNCTION wacrm.audit_generic_changes(
    'quick_reply', 'Resposta rápida', 'title', 'shortcut,title,content');

NOTIFY pgrst, 'reload schema';
COMMIT;
