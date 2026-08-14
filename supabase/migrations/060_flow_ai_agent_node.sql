-- ============================================================
-- 060_flow_ai_agent_node.sql — 'ai_agent' Flow node type.
--
-- Lets a flow node invoke the account's AI auto-responder
-- (handleAiAutoResponse, src/lib/ai/responder.ts) mid-flow, in one of
-- three modes (config.mode):
--   - 'once'     — answers the customer's last message once, then
--                  advances to config.next_node_key.
--   - 'loop'     — answers, then suspends on the SAME node so each new
--                  customer reply re-enters it, up to config.max_turns
--                  (engine default 20) before advancing.
--   - 'takeover' — answers once, then ends the run with
--                  status='handed_off' (no next_node_key).
--
-- No new columns needed — config.max_turns / config.mode /
-- config.system_prompt_override live in flow_nodes.config (JSONB), and
-- the loop mode's turn counter is stored in flow_runs.vars.__ai_turns__
-- (JSONB), the same place every other node's captured/derived state
-- already lives.
--
-- Idempotent — safe to run multiple times. Not applied to the DB by
-- this session; file only.
-- ============================================================

SET search_path TO wacrm, public, extensions;

-- ------------------------------------------------------------
-- flow_nodes.node_type — add 'ai_agent', preserving the 19 values
-- added across 010_flows.sql, 016_flow_media.sql, and
-- 058_flow_new_node_types.sql.
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
    'ai_agent'
  ));
