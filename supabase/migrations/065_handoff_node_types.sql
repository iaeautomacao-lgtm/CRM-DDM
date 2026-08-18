-- ============================================================
-- 065_handoff_node_types.sql — split 'handoff' into 'handoff_agent'
-- and 'handoff_team'.
--
-- 'handoff' let a single node set both an agent (assign_to) and a
-- team (team_id) at once. The two new types are single-purpose:
--   - 'handoff_agent' ("Transferir para Operador") only ever sets
--     assigned_agent_id — team_id is not part of its config.
--   - 'handoff_team'  ("Transferir para Equipe") only ever sets
--     team_id — assign_to is not part of its config.
--
-- 'handoff' is NOT removed — existing flows using it keep working
-- unchanged (executeHandoff in engine.ts is untouched); the three
-- node types coexist.
--
-- No new columns needed — config.assign_to / config.team_id / config.note
-- live in flow_nodes.config (JSONB), same as every other node type's shape.
--
-- Idempotent — safe to run multiple times. Not applied to the DB by
-- this session; file only.
-- ============================================================

SET search_path TO wacrm, public, extensions;

-- ------------------------------------------------------------
-- flow_nodes.node_type — add 'handoff_agent' and 'handoff_team',
-- preserving the 21 values added across 010_flows.sql,
-- 016_flow_media.sql, 058_flow_new_node_types.sql,
-- 060_flow_ai_agent_node.sql, and 064_switch_node_type.sql.
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
    'switch',
    'handoff_agent',
    'handoff_team'
  ));
