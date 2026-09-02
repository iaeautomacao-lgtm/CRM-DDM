/**
 * Type definitions for the Flows runtime.
 *
 * These mirror the Supabase schema added in migration 010 (`flows`,
 * `flow_nodes`, `flow_runs`, `flow_run_events`) plus the discriminated
 * unions the engine uses to typecheck node configs.
 *
 * Schema invariants enforced here that the DB CHECK constraints don't:
 *   - Each node_type maps to one config shape — adding a new node_type
 *     requires adding the matching config interface AND extending
 *     `FlowNodeConfig` so the engine's exhaustiveness checks light up.
 *   - Edges live INSIDE the config (each button row / list row carries
 *     `next_node_key`). The DB schema doesn't model this — the
 *     validator (PR #3) catches missing or orphan edges at save time.
 *
 * `next_node_key` is the stable string id stored in `flow_nodes.node_key`,
 * not a UUID, so flows can be cloned / templated without rewriting
 * references in JSONB.
 */

// ============================================================
// Node configs (discriminated union by node_type)
// ============================================================

export interface StartNodeConfig {
  /** Stable node_key of the first real node to advance to. */
  next_node_key: string;
}

export interface SendMessageNodeConfig {
  /** Plain text sent to the customer; can interpolate {{vars.X}}. */
  text: string;
  /** Auto-advance target after the message lands at Meta. */
  next_node_key: string;
}

export interface SendButtonsNodeConfig {
  text: string;
  /** Optional header / footer lines around the buttons. */
  header_text?: string;
  footer_text?: string;
  /** 1-3 buttons; Meta cap enforced in meta-api validation. */
  buttons: Array<{
    /** Stable id sent back by Meta when this button is tapped. */
    reply_id: string;
    /** Visible label (≤ 20 chars per Meta). */
    title: string;
    /** node_key the runner advances to when this button is tapped. */
    next_node_key: string;
  }>;
}

export interface SendListNodeConfig {
  text: string;
  /** Label of the tap-to-expand button on the message bubble. */
  button_label: string;
  header_text?: string;
  footer_text?: string;
  /** 1-10 rows TOTAL across sections; cap enforced in meta-api. */
  sections: Array<{
    title?: string;
    rows: Array<{
      reply_id: string;
      title: string;
      description?: string;
      next_node_key: string;
    }>;
  }>;
}

/**
 * Sends a single image / video / document via WhatsApp, then
 * auto-advances. The media file is uploaded to the `flow-media`
 * Supabase Storage bucket by the builder; `media_url` is the public
 * URL Meta fetches at send time.
 *
 * Why one node with a `media_type` discriminator (rather than three
 * separate node types): Meta's send-side payload differs only in the
 * top-level key (`image` / `video` / `document`) and the
 * filename-on-document quirk. Modeling three node types would triple
 * the builder forms, engine cases, and add-menu entries for no
 * meaningful behavioural difference.
 */
export interface SendMediaNodeConfig {
  media_type: "image" | "video" | "document";
  /** Public URL Meta will fetch. Uploaded via the builder's file picker. */
  media_url: string;
  /** Optional caption shown under the media (Meta caps at 1024 chars). */
  caption?: string;
  /**
   * Filename shown in the recipient's chat. Documents only — Meta
   * ignores it for image/video. Defaults to the file's original name
   * at upload time; the user can edit it.
   */
  filename?: string;
  /** Auto-advance target after the send lands at Meta. */
  next_node_key: string;
}

export interface HandoffNodeConfig {
  /** Optional internal note written to flow_run_events.payload.note. */
  note?: string;
  /**
   * Optional agent user_id to assign on the conversation when this
   * node fires. Leave unset to flip the status without assignment.
   */
  assign_to?: string;
  /**
   * Optional team id to route the conversation to when this node
   * fires. Independent of `assign_to` — either, both, or neither can
   * be set (same "agent and team are independent fields" model as
   * the Monitoramento transfer dialog).
   */
  team_id?: string;
}

/** 'handoff_agent' — transfers to a specific operator (or any available one). */
export interface HandoffAgentNodeConfig {
  /** Optional internal note written to flow_run_events.payload.note. */
  note?: string;
  /** Optional agent user_id to assign. Leave unset for "any available operator". */
  assign_to?: string;
}

/** 'handoff_team' — transfers to a specific team (or any team). */
export interface HandoffTeamNodeConfig {
  /** Optional internal note written to flow_run_events.payload.note. */
  note?: string;
  /** Optional team id to route to. Leave unset for "any team". */
  team_id?: string;
}

/**
 * Captures the customer's next free-text reply into
 * `flow_runs.vars[var_key]`, then advances.
 *
 * v1.5 ships without runtime validation (`validation` is accepted on
 * the config for forward compat but ignored by the runner); the
 * builder still surfaces the field so users can author flows that
 * v2 will start enforcing.
 */
export interface CollectInputNodeConfig {
  /** Prompt text sent to the customer before they reply. */
  prompt_text: string;
  /**
   * Key under which to store the captured text in
   * `flow_runs.vars`. Stable identifier — used by downstream
   * `condition` nodes and `handoff` notes via interpolation.
   */
  var_key: string;
  /**
   * Reserved for v2. Accepted on the config but ignored by the v1.5
   * runner — captures any non-empty text.
   */
  validation?: "any" | "email" | "phone" | "regex";
  /** Used only when `validation === 'regex'`. */
  regex?: string;
  /** Node to advance to after capture. */
  next_node_key: string;
}

export type ConditionOperator =
  | "equals"
  | "contains"
  | "present"
  | "absent";

export type ConditionSubject = "var" | "tag" | "contact_field";

/**
 * Routes the run based on a predicate over the contact's tags,
 * profile fields, or stored vars. Always auto-advances — no Meta
 * call, no customer-side input.
 */
export interface ConditionNodeConfig {
  subject: ConditionSubject;
  /**
   * For `var`: the key in flow_runs.vars.
   * For `tag`: the tag UUID (matched against contact_tags).
   * For `contact_field`: one of 'name' | 'email' | 'phone' | 'company'.
   */
  subject_key: string;
  operator: ConditionOperator;
  /** Compared against `subject` for `equals`/`contains`. Ignored for `present`/`absent`. */
  value?: string;
  /** Node to advance to when the predicate evaluates true. */
  true_next: string;
  /** Node to advance to when it evaluates false. */
  false_next: string;
}

/** One predicate inside a `SwitchBranch` — same shape as
 *  `ConditionNodeConfig`'s subject/subject_key/operator/value, minus
 *  the routing fields (a branch's conditions share one destination). */
export interface SwitchCondition {
  subject: ConditionSubject;
  subject_key: string;
  operator: ConditionOperator;
  value?: string;
}

/**
 * One ramo (branch) of a `switch` node: an ordered set of predicates
 * combined with a single AND/OR combinator, plus where to advance
 * when the branch matches.
 */
export interface SwitchBranch {
  /** Stable id generated client-side (crypto.randomUUID()) — used as
   *  the React key and as the `branch-<index>`-independent identity
   *  when branches are reordered/removed. Not persisted as a
   *  sourceHandle id; the handle scheme uses the branch's array index
   *  instead (see edges.ts), which is simpler for drag-to-connect but
   *  means handle ids shift if a branch is removed from the middle —
   *  acceptable since removing a branch already requires re-wiring. */
  id: string;
  label: string;
  combinator: "and" | "or";
  /** At least one — the validator rejects a branch with none. */
  conditions: SwitchCondition[];
  /** Node to advance to when this branch's conditions pass. */
  next_node_key: string;
}

/**
 * Routes the run to the first branch whose conditions pass (evaluated
 * in array order), or to `default_next` if none do. Each branch's
 * conditions combine via its own `combinator` (AND requires every
 * condition to pass; OR requires at least one). Generalizes
 * `condition` (which is exactly a switch with one branch, one
 * condition, and an implicit AND) for cases needing more than a
 * true/false fork — kept as a separate node type rather than replacing
 * `condition` so existing flows built on it don't need migrating.
 */
export interface SwitchNodeConfig {
  branches: SwitchBranch[];
  /** Node to advance to when no branch matches — the "Senão" (else). */
  default_next: string;
}

export interface SetTagNodeConfig {
  mode: "add" | "remove";
  /** Tag UUID. The builder picks from the user's existing tags. */
  tag_id: string;
  next_node_key: string;
}

// Terminal nodes carry no config — they just stop the run.
export type EndNodeConfig = Record<string, never>;

/**
 * Calls an external HTTP endpoint and (optionally) stores the response
 * in `flow_runs.vars`. `url` and `body_template` support the same
 * `{{vars.X}}` interpolation as send_message. Errors are logged (status
 * code only — never the response body, which may carry tokens/PII) and
 * the run advances to `next_node_key` regardless of success/failure, so
 * a flaky third-party API never strands a customer mid-flow.
 */
export interface HttpFetchNodeConfig {
  url: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body_template?: string;
  /** Key under which the parsed response is stored in flow_runs.vars. */
  response_var?: string;
  /** Defaults to 10s when unset; builder caps this at 30s. */
  timeout_seconds?: number;
  next_node_key: string;
}

/**
 * Writes one or more literal/interpolated values into `flow_runs.vars`
 * without waiting on customer input. Each `value` supports
 * `{{vars.X}}` interpolation against the vars captured so far.
 */
export interface SetVariableNodeConfig {
  assignments: Array<{ variable: string; value: string }>;
  next_node_key: string;
}

/**
 * Suspends the run for `delay_seconds`, optionally sending a message
 * first. The cron sweep (flows/cron route) wakes runs whose `wake_at`
 * has passed and resumes at `next_node_key`.
 */
export interface SmartDelayNodeConfig {
  delay_seconds: number;
  message?: string;
  next_node_key: string;
}

/**
 * A no-op passthrough node. Exists so `go_to` has a stable, human-named
 * landing target instead of pointing at an arbitrary mid-flow node key
 * that might get reshuffled as the flow is edited.
 */
export interface AnchorNodeConfig {
  label: string;
  next_node_key: string;
}

/**
 * Unconditional jump to another node in the SAME flow (typically an
 * `anchor`). Guarded by `flow_runs.hops_count` (MAX 50) so a cyclical
 * go_to chain fails the run instead of looping forever.
 */
export interface GoToNodeConfig {
  target_node_key: string;
}

/**
 * Ends the current run with status='transferred' and starts a new run
 * on `flow_id` for the same contact/conversation. `pass_vars` copies
 * the current run's `vars` into the new run's initial vars.
 */
export interface GoToFlowNodeConfig {
  flow_id: string;
  pass_vars: boolean;
}

/**
 * Sends a Meta HSM template. WAHA has no template concept — when the
 * run's provider is WAHA, `fallback_text` is sent as plain text instead
 * (if set; otherwise the node is a no-op send and just advances).
 */
export interface SendTemplateNodeConfig {
  template_name: string;
  language_code: string;
  components?: unknown[];
  fallback_text?: string;
  next_node_key: string;
}

/**
 * Writes an internal note (not delivered to the customer) onto the
 * conversation, e.g. for agents picking up a handoff later. Supports
 * `{{vars.X}}` interpolation.
 */
export interface AddNoteNodeConfig {
  note_text: string;
  next_node_key: string;
}

/**
 * Suspends awaiting a media message from the customer. Optionally
 * prompts first. `var_name` is where the attachment URL lands in
 * `flow_runs.vars`; `allowed_types` restricts which media kinds are
 * accepted (unset = any).
 */
export interface ReceiveAttachmentNodeConfig {
  prompt_text?: string;
  var_name: string;
  allowed_types?: Array<"image" | "video" | "audio" | "document">;
  next_node_key: string;
}

/**
 * Invokes `handleAiAutoResponse` (src/lib/ai/responder.ts) against the
 * account's `ai_config`, using the customer's latest inbound message as
 * input. Three operating modes:
 *   - `once`: answers a single time, then advances to `next_node_key`.
 *   - `loop`: answers, then suspends on THIS node again — each new
 *     customer reply re-enters the node instead of advancing. Guarded
 *     by `max_turns` (default 20); once hit, advances to
 *     `next_node_key` regardless of what the customer said.
 *   - `takeover`: answers once, then ends the run with
 *     status='handed_off' — the AI's reply is the last thing the bot
 *     says before a human (or the standalone AI auto-responder) takes
 *     over the conversation. No `next_node_key`; nothing to advance to.
 */
export interface AiAgentNodeConfig {
  mode: "once" | "loop" | "takeover";
  /** Overrides ai_config.system_prompt for this node's call, when set. */
  system_prompt_override?: string;
  /** Required for `once` and `loop`; ignored for `takeover`. */
  next_node_key?: string;
  /** Safety cap for `loop` mode. Defaults to 20 when unset. */
  max_turns?: number;
  tools?: AiAgentTool[]; // ← novo campo
}

export interface AiAgentToolParameter {
  type: string;
  description: string;
  enum?: string[];
}

export interface AiAgentTool {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, AiAgentToolParameter>;
    required?: string[];
  };
  http: {
    url: string;
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    headers?: Record<string, string>;
    body?: string; // JSON template com {{param}} placeholders
  };
}

/**
 * Total union — every concrete node_type the v1 engine understands.
 * Add new node types here and the engine's switch will flag missing
 * cases via TypeScript's exhaustiveness check.
 *
 * v1.5+ additions (collect_input, condition, set_tag, http_fetch) will
 * extend this union — out-of-scope for the v1 engine PR.
 */
export type FlowNodeConfig =
  | { node_type: "start"; config: StartNodeConfig }
  | { node_type: "send_message"; config: SendMessageNodeConfig }
  | { node_type: "send_buttons"; config: SendButtonsNodeConfig }
  | { node_type: "send_list"; config: SendListNodeConfig }
  | { node_type: "send_media"; config: SendMediaNodeConfig }
  | { node_type: "collect_input"; config: CollectInputNodeConfig }
  | { node_type: "condition"; config: ConditionNodeConfig }
  | { node_type: "switch"; config: SwitchNodeConfig }
  | { node_type: "set_tag"; config: SetTagNodeConfig }
  | { node_type: "handoff"; config: HandoffNodeConfig }
  | { node_type: "handoff_agent"; config: HandoffAgentNodeConfig }
  | { node_type: "handoff_team"; config: HandoffTeamNodeConfig }
  | { node_type: "end"; config: EndNodeConfig }
  | { node_type: "http_fetch"; config: HttpFetchNodeConfig }
  | { node_type: "set_variable"; config: SetVariableNodeConfig }
  | { node_type: "smart_delay"; config: SmartDelayNodeConfig }
  | { node_type: "anchor"; config: AnchorNodeConfig }
  | { node_type: "go_to"; config: GoToNodeConfig }
  | { node_type: "go_to_flow"; config: GoToFlowNodeConfig }
  | { node_type: "send_template"; config: SendTemplateNodeConfig }
  | { node_type: "add_note"; config: AddNoteNodeConfig }
  | { node_type: "receive_attachment"; config: ReceiveAttachmentNodeConfig }
  | { node_type: "ai_agent"; config: AiAgentNodeConfig };

export type FlowNodeType = FlowNodeConfig["node_type"];

// ============================================================
// Triggers (matches `flows.trigger_type` + `trigger_config`)
// ============================================================

export interface KeywordTriggerConfig {
  /** One or more keywords. Match is case-insensitive by default. */
  keywords: string[];
  match_type?: "exact" | "contains";
  case_sensitive?: boolean;
}

// No knobs in v1 — the trigger has a single semantic. Kept as a type
// alias (not an empty interface) for forward compat without tripping
// the no-empty-object-type lint rule.
export type FirstInboundTriggerConfig = Record<string, never>;

/**
 * No knobs — a flow with this trigger never auto-starts from an
 * inbound message (mirrors `manual` in the engine's dispatch switch).
 * It's only ever entered via another flow's `go_to_flow` node.
 */
export type CalledByFlowTriggerConfig = Record<string, never>;

export type FlowTriggerConfig =
  | { trigger_type: "keyword"; config: KeywordTriggerConfig }
  | { trigger_type: "first_inbound_message"; config: FirstInboundTriggerConfig }
  | { trigger_type: "manual"; config: Record<string, never> }
  | { trigger_type: "called_by_flow"; config: CalledByFlowTriggerConfig };

// ============================================================
// DB-row shapes (read by the engine via supabaseAdmin)
// ============================================================

export interface FlowRow {
  id: string;
  /** Account tenancy (NOT NULL post-017). The engine looks up active
   *  flows for inbound dispatch using this field. */
  account_id: string;
  /** Author. Used as a default sender-of-record on engine sends and
   *  preserved on flow_runs for log/audit display. */
  user_id: string;
  name: string;
  description: string | null;
  status: "draft" | "active" | "archived";
  trigger_type: "keyword" | "first_inbound_message" | "manual" | "called_by_flow";
  trigger_config: KeywordTriggerConfig | FirstInboundTriggerConfig | Record<string, unknown>;
  entry_node_id: string | null;
  fallback_policy: FlowFallbackPolicy;
  execution_count: number;
  last_executed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FlowNodeRow {
  id: string;
  flow_id: string;
  node_key: string;
  node_type: FlowNodeType;
  config: Record<string, unknown>;
  position_x: number;
  position_y: number;
  created_at: string;
}

export interface FlowRunRow {
  id: string;
  flow_id: string;
  /** Tenancy. Matches flows.account_id; NOT NULL post-017. */
  account_id: string;
  /** Audit. Matches the parent flow.user_id. */
  user_id: string;
  contact_id: string | null;
  conversation_id: string | null;
  status:
    | "active"
    | "completed"
    | "handed_off"
    | "timed_out"
    | "paused_by_agent"
    | "failed"
    /** go_to hit MAX_HOPS (50) without reaching a stopping node. */
    | "error"
    /** Ended via go_to_flow — a new run was started on another flow. */
    | "transferred"
    /** Suspended by a smart_delay node; wake_at holds the resume time. */
    | "delayed";
  current_node_key: string | null;
  last_prompt_message_id: string | null;
  vars: Record<string, unknown>;
  reprompt_count: number;
  started_at: string;
  last_advanced_at: string;
  ended_at: string | null;
  end_reason: string | null;
  /**
   * wacrm.whatsapp_config the run started on (migration 057). NULL for
   * runs started before this migration, or when the webhook didn't
   * pass a configId (Meta). The engine's send wrappers use this to
   * pick Meta vs WAHA and, for WAHA, which line.
   */
  config_id: string | null;
  /** When status='delayed', the time the cron should resume this run (migration 058). */
  wake_at: string | null;
  /** go_to jump counter (migration 058) — capped at MAX_HOPS (50) to catch cycles. */
  hops_count: number;
}

// ============================================================
// Fallback policy (matches flows.fallback_policy JSONB)
// ============================================================

export interface FlowFallbackPolicy {
  /** What to do when the customer reply doesn't match any option. */
  on_unknown_reply: "reprompt" | "handoff" | "ignore";
  /** Max reprompts before applying `on_exhaust`. */
  max_reprompts: number;
  /** Stale-run sweep cutoff. */
  on_timeout_hours: number;
  /** What to do once max_reprompts has been hit. */
  on_exhaust: "handoff" | "end";
}

export const DEFAULT_FALLBACK_POLICY: FlowFallbackPolicy = {
  on_unknown_reply: "reprompt",
  max_reprompts: 2,
  on_timeout_hours: 24,
  on_exhaust: "handoff",
};

// ============================================================
// Engine input — what `dispatchInboundToFlows` accepts
// ============================================================

/**
 * Normalised view of an inbound message that the runner needs. The
 * webhook lifts this out of the raw Meta payload before invoking the
 * runner; keeps the runner free of any WhatsApp-API specifics.
 */
export type ParsedInbound =
  | {
      kind: "text";
      /** The user's typed message body. */
      text: string;
      /** Meta's `messages[0].id` — used for idempotency. */
      meta_message_id: string;
      /**
       * Generic alias of `meta_message_id`, added for the WAHA webhook
       * (whose message ids aren't from Meta). The engine reads
       * `message_id ?? meta_message_id`; Meta's own webhook only ever
       * sets `meta_message_id`.
       */
      message_id?: string;
    }
  | {
      kind: "interactive_reply";
      /** The reply_id of the tapped button or list row. */
      reply_id: string;
      /** The visible title of the tapped option (for logging). */
      reply_title: string;
      meta_message_id: string;
      /** See the `text` variant's `message_id` for why this exists. */
      message_id?: string;
    }
  | {
      kind: "attachment";
      /** Public URL the runner can hand to a receive_attachment node. */
      url: string;
      mime_type: string;
      message_id: string;
      meta_message_id: string;
    };

export interface DispatchInboundInput {
  /** Account tenancy key. Drives the lookup of active flows and the
   *  idempotency check for previously-seen inbound message_ids. */
  accountId: string;
  /** Sender-of-record for the bot's outbound prompts on engine
   *  sends. Set by the webhook to the WhatsApp config owner. */
  userId: string;
  contactId: string;
  conversationId: string;
  message: ParsedInbound;
  /**
   * The wacrm.whatsapp_config row this inbound arrived on. Both the
   * Meta and WAHA webhooks pass it — an account can have several
   * configs of either provider (multiple Meta numbers, multiple WAHA
   * lines). Optional only for callers outside the two webhooks.
   * Drives provider selection (getConfigProvider), per-channel flow
   * binding (findEntryFlow), and scoping outbound sends back to the
   * same number the contact messaged (meta-send.ts) — see engine.ts.
   */
  configId?: string;
}

export interface DispatchInboundResult {
  /**
   * True iff the runner handled the message — it either advanced an
   * existing run or started a new one matching a flow trigger.
   * Webhook uses this to decide whether to also fire automations.
   */
  consumed: boolean;
  /** For diagnostics / logging — null when not consumed. */
  flow_run_id?: string;
  /** For diagnostics. */
  outcome?:
    | "advanced"
    | "started"
    | "completed"
    | "handed_off"
    | "fallback_fired"
    | "duplicate_inbound_ignored"
    | "no_match"
    /** Ended via go_to_flow — a new run was started on another flow. */
    | "transferred";
}

// ============================================================
// Helpers — exhaustiveness assertions
// ============================================================

/**
 * Throws a typed compile-time error if the switch over a discriminated
 * union forgets a case. Used in the engine's node-type switch.
 */
export function assertNever(x: never): never {
  throw new Error(`Unhandled node type: ${JSON.stringify(x)}`);
}
