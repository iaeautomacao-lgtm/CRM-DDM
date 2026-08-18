-- ============================================================
-- 064_switch_node_type.sql — 'switch' Flow node type.
--
-- Generalizes 'condition' (which is exactly a switch with one branch,
-- one condition, and an implicit AND) for flows needing more than a
-- true/false fork: N branches, each an ordered list of subject/
-- operator/value predicates combined by the branch's own AND/OR
-- combinator, evaluated in order — the first branch whose predicates
-- pass wins; none passing falls through to config.default_next.
--
-- No new columns needed — config.branches / config.default_next live
-- in flow_nodes.config (JSONB), same as every other node type's shape.
-- 'condition' is untouched and keeps working exactly as before; the
-- two node types coexist.
--
-- Idempotent — safe to run multiple times. Not applied to the DB by
-- this session; file only.
-- ============================================================

SET search_path TO wacrm, public, extensions;

-- ------------------------------------------------------------
-- flow_nodes.node_type — add 'switch', preserving the 20 values added
-- across 010_flows.sql, 016_flow_media.sql, 058_flow_new_node_types.sql,
-- and 060_flow_ai_agent_node.sql.
-- ------------------------------------------------------------
ALTER TABLE wacrm.flow_nodes
  DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;

ALTER TABLE wacrm.flow_nodes
  ADD CONSTRAINT flow_nodes_node_type_check
  CHECK (node_type IN (
    'start',
    'send_buttons',
    'send_list',
    'send_message',
    'collect_input',
    'condition',
    'set_tag',
    'handoff',
    'http_fetch',
    'end',
    'send_media',
    'set_variable',
    'smart_delay',
    'anchor',
    'go_to',
    'go_to_flow',
    'send_template',
    'add_note',
    'receive_attachment',
    'ai_agent',
    'switch'
  ));
