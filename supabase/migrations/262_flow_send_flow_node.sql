-- ============================================================
-- 262_flow_send_flow_node.sql   (PRD 21, PR 21.4 — novo tipo de nó 'send_flow': convite para um WhatsApp Flow)
--
-- A constraint flow_nodes_node_type_check lista os tipos aceitos (010 → 065, e talvez ajustes manuais depois: as migrations NÃO são a fonte
-- de verdade do schema vivo). Em vez de reescrever a lista inteira (e apagar um tipo que exista só no banco), esta migration LÊ a definição
-- atual da constraint e acrescenta 'send_flow' logo depois de 'start', preservando todo o resto. Já tem 'send_flow'? não faz nada.
-- Config do nó (flow_nodes.config jsonb): flow_id, cta_text, body_text, header_text?, footer_text?, screen_id?, flow_action, fallback_text?,
-- next_node_key — validada por src/lib/flows/validate.ts; nenhuma coluna nova.
--
-- PRÉ-CHECK:  SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'flow_nodes_node_type_check' AND conrelid = 'wacrm.flow_nodes'::regclass;
--             -- deve conter 'start'::text e NÃO conter 'send_flow'
-- ORDEM: pode rodar antes ou depois do deploy (sem ela, salvar um fluxo com o nó novo falha no banco; o resto segue igual). Idempotente.
-- ROLLBACK:   (só se NENHUM nó send_flow existir) BEGIN;
--             DO $$ DECLARE d text; BEGIN
--               SELECT pg_get_constraintdef(oid) INTO d FROM pg_constraint WHERE conname = 'flow_nodes_node_type_check' AND conrelid = 'wacrm.flow_nodes'::regclass;
--               ALTER TABLE wacrm.flow_nodes DROP CONSTRAINT flow_nodes_node_type_check;
--               EXECUTE format('ALTER TABLE wacrm.flow_nodes ADD CONSTRAINT flow_nodes_node_type_check %s', replace(d, '''send_flow''::text, ', ''));
--             END $$;
--             DELETE FROM wacrm.schema_migrations WHERE version = '262_flow_send_flow_node'; COMMIT;
-- ============================================================

BEGIN;

DO $$
DECLARE
  v_def text;
  v_new text;
BEGIN
  IF to_regclass('wacrm.flow_nodes') IS NULL THEN
    RAISE EXCEPTION '262: falta wacrm.flow_nodes (migration 010) — confira o schema vivo';
  END IF;

  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conname = 'flow_nodes_node_type_check' AND conrelid = 'wacrm.flow_nodes'::regclass;

  IF v_def IS NULL THEN
    RAISE EXCEPTION '262: a constraint flow_nodes_node_type_check não existe — confira o schema vivo (nada foi alterado)';
  END IF;
  IF position('''send_flow''' IN v_def) > 0 THEN
    RETURN; -- já aceita o tipo
  END IF;
  IF position('''start''::text' IN v_def) = 0 THEN
    RAISE EXCEPTION '262: formato inesperado da constraint (%): nada foi alterado', v_def;
  END IF;

  v_new := replace(v_def, '''start''::text', '''start''::text, ''send_flow''::text');
  ALTER TABLE wacrm.flow_nodes DROP CONSTRAINT flow_nodes_node_type_check;
  EXECUTE format('ALTER TABLE wacrm.flow_nodes ADD CONSTRAINT flow_nodes_node_type_check %s', v_new);
END $$;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('262_flow_send_flow_node') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
