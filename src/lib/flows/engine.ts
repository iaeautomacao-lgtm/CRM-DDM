/**
 * Flow runner.
 *
 * The single entry point `dispatchInboundToFlows` is called by the
 * WhatsApp webhook on every inbound message *for an account that has
 * opted into the Flows beta*. It decides whether the message belongs
 * to an active conversation flow (advance it) or matches the entry
 * trigger of an active flow (start a new run) — and reports back to
 * the webhook so the webhook knows whether to also fire automations.
 *
 * Architecture in a sentence: the runner walks the customer through
 * a DB-stored node graph, suspending only at nodes that need
 * customer input. Each tap or text reply wakes it back up.
 *
 * What lives here vs elsewhere:
 *   - Pure decision logic (which button matched, where to advance to,
 *     when to fallback) — here.
 *   - DB shape (table reads/writes) — here.
 *   - Meta API calls — `meta-send.ts` (engineSendInteractive*).
 *   - Policy resolution (reprompt vs handoff vs end) — `fallback.ts`.
 *   - Type definitions — `types.ts`.
 *
 * Concurrency model:
 *   - Idempotency on `meta_message_id`: the runner refuses to advance
 *     an active run twice for the same Meta message — protects against
 *     Meta's retries.
 *   - Optimistic UPDATE with `current_node_key` precondition: two
 *     simultaneous taps for the same run collide at the DB layer; the
 *     second is a no-op.
 *   - Partial unique index `idx_one_active_run_per_contact`: two
 *     simultaneous starts for the same contact collide; the second
 *     INSERT raises 23505 and the runner catches & exits.
 */

import { handleAiAutoResponse } from "@/lib/ai/responder";
import { supabaseAdmin } from "./admin-client";
import {
  engineMetaSendTemplate,
  engineSendInteractiveButtons,
  engineSendInteractiveList,
  engineSendMedia,
  engineSendText,
} from "./meta-send";
import {
  engineWahaSendButtons,
  engineWahaSendList,
  engineWahaSendMedia,
  engineWahaSendText,
} from "./waha-send";
import { decideFallback, resolveFallbackPolicy } from "./fallback";
import {
  type AddNoteNodeConfig,
  type AiAgentNodeConfig,
  type AnchorNodeConfig,
  type CollectInputNodeConfig,
  type ConditionNodeConfig,
  type DispatchInboundInput,
  type DispatchInboundResult,
  type FlowNodeRow,
  type FlowRow,
  type FlowRunRow,
  type GoToFlowNodeConfig,
  type GoToNodeConfig,
  type HttpFetchNodeConfig,
  type ParsedInbound,
  type ReceiveAttachmentNodeConfig,
  type SendButtonsNodeConfig,
  type SendListNodeConfig,
  type SendMediaNodeConfig,
  type SendMessageNodeConfig,
  type SendTemplateNodeConfig,
  type SetTagNodeConfig,
  type SetVariableNodeConfig,
  type SmartDelayNodeConfig,
  type StartNodeConfig,
  type SwitchBranch,
  type SwitchNodeConfig,
  type KeywordTriggerConfig,
} from "./types";

/** go_to's jump cap — catches cyclical anchor chains without spinning forever. */
const MAX_HOPS = 50;

// ============================================================
// Pure helpers — extracted so engine.test.ts can exercise them
// without a Supabase / Meta mock.
// ============================================================

/**
 * Given a node + the customer's reply_id, return the next_node_key
 * to advance to, or `null` if no option matches.
 */
export function matchReplyId(
  node: { node_type: string; config: Record<string, unknown> },
  reply_id: string,
): string | null {
  if (node.node_type === "send_buttons") {
    const cfg = node.config as unknown as SendButtonsNodeConfig;
    const hit = cfg.buttons?.find((b) => b.reply_id === reply_id);
    return hit?.next_node_key ?? null;
  }
  if (node.node_type === "send_list") {
    const cfg = node.config as unknown as SendListNodeConfig;
    for (const section of cfg.sections ?? []) {
      const hit = section.rows?.find((r) => r.reply_id === reply_id);
      if (hit) return hit.next_node_key;
    }
    return null;
  }
  return null;
}

/**
 * Case-insensitive contains/exact match against a list of keywords.
 * Used by the trigger evaluator. Stable enough that the v3 builder
 * UI can preview matches by passing canned strings.
 */
export function matchesKeywordTrigger(
  text: string,
  cfg: KeywordTriggerConfig,
): boolean {
  if (!text || !cfg.keywords?.length) return false;
  const matchType = cfg.match_type ?? "contains";
  const haystack = cfg.case_sensitive ? text : text.toLowerCase();
  for (const raw of cfg.keywords) {
    if (!raw) continue;
    const needle = cfg.case_sensitive ? raw : raw.toLowerCase();
    if (matchType === "exact" ? haystack === needle : haystack.includes(needle)) {
      return true;
    }
  }
  return false;
}

/** Nodes that advance to a next_node_key without waiting for input. */
export function isAutoAdvancing(node_type: string): boolean {
  return (
    node_type === "start" ||
    node_type === "send_message" ||
    node_type === "send_media" ||
    node_type === "condition" ||
    node_type === "set_tag"
  );
}

/** Nodes that send a prompt and suspend awaiting a customer reply. */
export function isSuspending(node_type: string): boolean {
  return (
    node_type === "send_buttons" ||
    node_type === "send_list" ||
    node_type === "collect_input"
  );
}

/** Nodes that end the run. */
export function isTerminal(node_type: string): boolean {
  return node_type === "handoff" || node_type === "end";
}

/**
 * Canonical inbound message id, regardless of provider. Meta's
 * webhook only ever sets `meta_message_id`; the WAHA webhook sets
 * both (message_id mirrors meta_message_id) — this is the one place
 * that decides which one wins so idempotency/logging don't need to
 * know about providers at all.
 */
export function inboundMessageId(message: ParsedInbound): string {
  return message.message_id ?? message.meta_message_id;
}

/**
 * Evaluate a `condition` node's predicate against the current run
 * state. Exported pure for unit testing — the engine wraps it with a
 * DB lookup for `tag` / `contact_field` subjects.
 */
export function evaluateConditionPredicate(args: {
  operator: ConditionNodeConfig["operator"];
  /**
   * Resolved value of the subject. `undefined` means the subject is
   * absent (no var with that key / no such tag / contact field is
   * null). Pure function: caller does the DB lookup.
   */
  subjectValue: string | undefined;
  /** The configured comparison value, when applicable. */
  configValue: string | undefined;
}): boolean {
  switch (args.operator) {
    case "present":
      return args.subjectValue !== undefined && args.subjectValue !== "";
    case "absent":
      return args.subjectValue === undefined || args.subjectValue === "";
    case "equals":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue === (args.configValue ?? "");
    case "contains":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue.includes(args.configValue ?? "");
  }
}

// ============================================================
// DB I/O — wrapped in tiny helpers so the dispatch flow stays
// readable. Errors surface as thrown — the entry point catches.
// ============================================================

type AdminClient = ReturnType<typeof supabaseAdmin>;

async function loadActiveRunForContact(
  db: AdminClient,
  accountId: string,
  contactId: string,
): Promise<FlowRunRow | null> {
  // The partial unique index `idx_one_active_run_per_contact` was
  // rebuilt in migration 017 over `(account_id, contact_id)` — so
  // "two active runs for one contact in one account" is impossible
  // by design. But a future migration glitch or manual SQL could
  // create one, and .maybeSingle() throws on >1 row — which would
  // kill dispatch for that contact's webhook entirely. .limit(1) is
  // forgiving: pick the newest, let the cron sweep clean up the
  // stale one.
  const { data, error } = await db
    .from("flow_runs")
    .select("*")
    .eq("account_id", accountId)
    .eq("contact_id", contactId)
    .eq("status", "active")
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) {
    console.error("[flows] loadActiveRunForContact error:", error.message);
    return null;
  }
  const rows = (data as FlowRunRow[] | null) ?? [];
  const run = rows[0] ?? null;
  if (!run) return null;

  // A human agent taking over the conversation should silence the flow —
  // nothing else clears `current_node_key`/`status='active'` on the run
  // row when that happens (e.g. handleAiAutoResponse's tag-triggered
  // handoff in responder.ts, or a manual assign from the inbox), so
  // without this check the engine would keep feeding the customer's
  // replies to the AI even after a human has been assigned.
  if (run.conversation_id) {
    const { data: conv } = await db
      .from("conversations")
      .select("assigned_agent_id")
      .eq("id", run.conversation_id)
      .maybeSingle();
    if ((conv as { assigned_agent_id: string | null } | null)?.assigned_agent_id) {
      return null;
    }
  }
  return run;
}

async function loadFlow(
  db: AdminClient,
  flowId: string,
): Promise<FlowRow | null> {
  const { data, error } = await db
    .from("flows")
    .select("*")
    .eq("id", flowId)
    .maybeSingle();
  if (error) {
    console.error("[flows] loadFlow error:", error.message);
    return null;
  }
  return (data as FlowRow | null) ?? null;
}

/**
 * Load every node of a flow in one round trip and key them by
 * `node_key`. The advance loop is then in-memory — a 5-node
 * auto-advancing chain costs one SELECT, not five.
 *
 * Returns an empty map on error so the caller can still dispatch
 * cleanly (every subsequent .get() returns undefined → the run
 * fails with node_not_found, same as the old per-node lookup).
 */
export async function loadAllNodes(
  db: AdminClient,
  flowId: string,
): Promise<Map<string, FlowNodeRow>> {
  const { data, error } = await db
    .from("flow_nodes")
    .select("*")
    .eq("flow_id", flowId);
  if (error) {
    console.error("[flows] loadAllNodes error:", error.message);
    return new Map();
  }
  const map = new Map<string, FlowNodeRow>();
  for (const row of (data ?? []) as FlowNodeRow[]) {
    map.set(row.node_key, row);
  }
  return map;
}

async function logEvent(
  db: AdminClient,
  flowRunId: string,
  event_type:
    | "started"
    | "node_entered"
    | "message_sent"
    | "reply_received"
    | "fallback_fired"
    | "handoff"
    | "timeout"
    | "error"
    | "completed",
  node_key: string | null,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await db.from("flow_run_events").insert({
    flow_run_id: flowRunId,
    event_type,
    node_key,
    payload,
  });
  if (error) {
    // Logging failure is non-fatal — surface but don't throw.
    console.error("[flows] logEvent error:", error.message);
  }
}

/**
 * Richer sibling of `logEvent` (migration 061) — used for the
 * run-history viewer (`/flows/[id]/runs`), not the idempotency /
 * fallback bookkeeping `logEvent` exists for. Carries flow_id/
 * account_id so the viewer's API can query without joining back
 * through flow_runs, plus node_type/status/duration_ms/error_message
 * for the per-node timeline. Never carries message content — only
 * node_key, node_type, status, timing (no PII).
 */
async function logRunEvent(
  db: AdminClient,
  event: {
    run_id: string;
    flow_id: string;
    account_id: string;
    node_key?: string | null;
    node_type?: string | null;
    event_type:
      | "run_started"
      | "node_completed"
      | "node_error"
      | "run_completed"
      | "run_error";
    status?: "success" | "error" | "skipped" | null;
    payload?: Record<string, unknown>;
    error_message?: string | null;
    duration_ms?: number | null;
  },
): Promise<void> {
  const { error } = await db.from("flow_run_events").insert({
    flow_run_id: event.run_id,
    flow_id: event.flow_id,
    account_id: event.account_id,
    node_key: event.node_key ?? null,
    node_type: event.node_type ?? null,
    event_type: event.event_type,
    status: event.status ?? null,
    payload: event.payload ?? {},
    error_message: event.error_message ?? null,
    duration_ms: event.duration_ms ?? null,
  });
  if (error) {
    // Logging failure is non-fatal — surface but don't throw.
    console.error("[flows] logRunEvent error:", error.message);
  }
}

/**
 * Builds the rich `node_error` payload shared by every failure path —
 * the loop's own `nodeError` closure AND `endRun`'s `errorContext`
 * (most "fatal" node failures end the run via `endRun` directly and
 * never reach `nodeError`, so both need the same shape). `input` is
 * the run.vars snapshot taken at node entry, reused as `input_at_error`
 * per the debug-payload spec — the node's vars didn't change between
 * "entered" and "errored" since the failure happened mid-execution.
 */
function buildErrorPayload(
  input: Record<string, unknown>,
  error_message: string,
  err: unknown,
  node_type: string | null,
  output: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    input,
    input_at_error: input,
    output,
    error_message,
    error_stack: err instanceof Error ? (err.stack ?? null) : null,
    node_type,
  };
}

/**
 * api_provider → the hardcoded model string `handleAiAutoResponse`
 * (src/lib/ai/responder.ts) actually calls for that provider. Kept
 * here (not imported) because responder.ts doesn't return which model
 * it used — this is a best-effort mirror for the debug timeline, not
 * a guarantee; if responder.ts's model strings change this drifts
 * stale until updated to match.
 */
const MODEL_BY_PROVIDER: Record<string, string> = {
  gemini: "gemini-1.5-flash",
  openai: "gpt-4o-mini",
  claude: "claude-3-5-sonnet-20241022",
  hermes: "nousresearch/hermes-3-llama-3.1-405b",
};

/**
 * Idempotency check — has a `reply_received` event with this Meta
 * message_id already been recorded for any of the contact's flow
 * runs? If yes, the inbound is a duplicate (Meta retry) and we
 * exit without re-advancing.
 *
 * Implementation note: scoped to runs belonging to this user/contact
 * so the lookup is cheap (the index on flow_run_events(flow_run_id,
 * event_type) plus the small set of runs per contact).
 */
async function isDuplicateInbound(
  db: AdminClient,
  accountId: string,
  contactId: string,
  metaMessageId: string,
): Promise<boolean> {
  // Fetch ALL run ids for this contact in this account (active +
  // historical). Bounded by how many flows the customer has been
  // through — small.
  const { data: runs } = await db
    .from("flow_runs")
    .select("id")
    .eq("account_id", accountId)
    .eq("contact_id", contactId);
  if (!runs?.length) return false;
  const runIds = runs.map((r) => (r as { id: string }).id);

  const { count } = await db
    .from("flow_run_events")
    .select("id", { count: "exact", head: true })
    .in("flow_run_id", runIds)
    .eq("event_type", "reply_received")
    .filter("payload->>meta_message_id", "eq", metaMessageId);
  return (count ?? 0) > 0;
}

async function findEntryFlow(
  db: AdminClient,
  accountId: string,
  message: ParsedInbound,
  isFirstInbound: boolean,
  configId?: string,
): Promise<FlowRow | null> {
  // Only text messages can match an entry trigger. Interactive replies
  // are responses to existing prompts; they never start a new flow.
  if (message.kind !== "text") return null;

  // A channel with a bound flow_id (set via /canais — migration 056)
  // always starts that one flow on any inbound text, bypassing
  // keyword/first-inbound trigger matching entirely — the binding IS
  // the trigger. flow_id set but not active → no match (don't fall
  // through to the account-wide scan; a paused/archived binding
  // should not silently reroute to some other flow).
  if (configId) {
    const { data: config } = await db
      .from("whatsapp_config")
      .select("flow_id")
      .eq("id", configId)
      .maybeSingle();
    const boundFlowId = (config as { flow_id: string | null } | null)?.flow_id ?? null;
    if (boundFlowId) {
      const flow = await loadFlow(db, boundFlowId);
      return flow && flow.status === "active" ? flow : null;
    }
    // flow_id null → fall through to the account-wide scan below.
  }

  // Pull all active flows for this account. Active set is bounded
  // (the builder discourages double-trigger overlap; partial index
  // makes the lookup index-supported).
  const { data: flows, error } = await db
    .from("flows")
    .select("*")
    .eq("account_id", accountId)
    .eq("status", "active")
    .order("created_at", { ascending: true });
  if (error || !flows) return null;

  const typed = flows as FlowRow[];
  for (const flow of typed) {
    if (flow.trigger_type === "keyword") {
      if (matchesKeywordTrigger(
        message.text,
        flow.trigger_config as KeywordTriggerConfig,
      )) {
        return flow;
      }
    } else if (flow.trigger_type === "first_inbound_message" && isFirstInbound) {
      return flow;
    }
    // 'manual' and 'called_by_flow' triggers do not auto-start from
    // inbound messages — the latter only starts via go_to_flow.
  }
  return null;
}

// ============================================================
// Provider dispatch — every outbound send from the runner goes
// through one of these four, which pick Meta or WAHA based on the
// run's own config_id (migration 057) and, for buttons/lists,
// persist the WAHA numbered-reply map onto flow_runs.vars so the
// customer's next text reply can be matched back to a button tap
// (see handleReplyForActiveRun's __waha_button_map check).
//
// getConfigProvider is a single, uncached lookup per call — a run's
// provider can't change mid-flight (config_id is fixed at start), so
// caching would only save one indexed SELECT per send; not worth the
// staleness risk if a channel is ever repointed.
// ============================================================

async function getConfigProvider(
  configId: string,
): Promise<"meta" | "waha" | null> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("whatsapp_config")
    .select("provider")
    .eq("id", configId)
    .maybeSingle();
  if (error || !data) return null;
  return (data as { provider: "meta" | "waha" }).provider;
}

async function sendTextViaProvider(
  run: FlowRunRow,
  args: { text: string },
): Promise<{ whatsapp_message_id: string }> {
  const provider = run.config_id ? await getConfigProvider(run.config_id) : "meta";
  if (provider === "waha") {
    return engineWahaSendText({
      accountId: run.account_id,
      configId: run.config_id!,
      conversationId: run.conversation_id!,
      contactId: run.contact_id!,
      text: args.text,
    });
  }
  return engineSendText({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    text: args.text,
    configId: run.config_id ?? undefined,
  });
}

async function sendMediaViaProvider(
  run: FlowRunRow,
  args: {
    kind: SendMediaNodeConfig["media_type"];
    link: string;
    caption?: string;
    filename?: string;
  },
): Promise<{ whatsapp_message_id: string }> {
  const provider = run.config_id ? await getConfigProvider(run.config_id) : "meta";
  if (provider === "waha") {
    return engineWahaSendMedia({
      accountId: run.account_id,
      configId: run.config_id!,
      conversationId: run.conversation_id!,
      contactId: run.contact_id!,
      mediaUrl: args.link,
      caption: args.caption,
    });
  }
  return engineSendMedia({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    kind: args.kind,
    link: args.link,
    caption: args.caption,
    filename: args.filename,
    configId: run.config_id ?? undefined,
  });
}

async function sendButtonsViaProvider(
  db: AdminClient,
  run: FlowRunRow,
  cfg: SendButtonsNodeConfig,
): Promise<{ whatsapp_message_id: string }> {
  const provider = run.config_id ? await getConfigProvider(run.config_id) : "meta";
  if (provider === "waha") {
    const { whatsapp_message_id, buttonMap } = await engineWahaSendButtons({
      accountId: run.account_id,
      configId: run.config_id!,
      conversationId: run.conversation_id!,
      contactId: run.contact_id!,
      body: cfg.text,
      buttons: cfg.buttons.map((b) => ({ id: b.reply_id, title: b.title })),
    });
    const newVars = { ...run.vars, __waha_button_map: buttonMap };
    const { error } = await db
      .from("flow_runs")
      .update({ vars: newVars })
      .eq("id", run.id);
    if (!error) run.vars = newVars;
    return { whatsapp_message_id };
  }
  return engineSendInteractiveButtons({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: cfg.text,
    headerText: cfg.header_text,
    footerText: cfg.footer_text,
    buttons: cfg.buttons.map((b) => ({ id: b.reply_id, title: b.title })),
    configId: run.config_id ?? undefined,
  });
}

async function sendListViaProvider(
  db: AdminClient,
  run: FlowRunRow,
  cfg: SendListNodeConfig,
): Promise<{ whatsapp_message_id: string }> {
  const provider = run.config_id ? await getConfigProvider(run.config_id) : "meta";
  // waha-send.ts has no separate "list" primitive — WAHA gets the same
  // numbered-plain-text treatment as buttons, just flattened across
  // sections (engineWahaSendList, not a nonexistent
  // engineWahaInteractiveList).
  if (provider === "waha") {
    const { whatsapp_message_id, buttonMap } = await engineWahaSendList({
      accountId: run.account_id,
      configId: run.config_id!,
      conversationId: run.conversation_id!,
      contactId: run.contact_id!,
      body: cfg.text,
      sections: cfg.sections.map((s) => ({
        title: s.title,
        rows: s.rows.map((r) => ({
          id: r.reply_id,
          title: r.title,
          description: r.description,
        })),
      })),
    });
    const newVars = { ...run.vars, __waha_button_map: buttonMap };
    const { error } = await db
      .from("flow_runs")
      .update({ vars: newVars })
      .eq("id", run.id);
    if (!error) run.vars = newVars;
    return { whatsapp_message_id };
  }
  return engineSendInteractiveList({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: cfg.text,
    buttonLabel: cfg.button_label,
    headerText: cfg.header_text,
    footerText: cfg.footer_text,
    sections: cfg.sections.map((s) => ({
      title: s.title,
      rows: s.rows.map((r) => ({
        id: r.reply_id,
        title: r.title,
        description: r.description,
      })),
    })),
    configId: run.config_id ?? undefined,
  });
}

// ============================================================
// Node executors — each handles ONE node type. send_buttons and
// send_list also persist `last_prompt_message_id` so the inbox
// thread can quote the prompt the customer is replying to.
// ============================================================

async function sendButtonsAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ outcome: "advanced"; node_key: string }> {
  const cfg = node.config as unknown as SendButtonsNodeConfig;
  const { whatsapp_message_id } = await sendButtonsViaProvider(db, run, cfg);
  await logEvent(db, run.id, "message_sent", node.node_key, {
    node_type: "send_buttons",
    whatsapp_message_id,
  });
  // Look up our internal message id so we can stash it on the run.
  // Cheap — indexed on `messages.message_id`.
  const { data: msg } = await db
    .from("messages")
    .select("id")
    .eq("message_id", whatsapp_message_id)
    .maybeSingle();
  await db
    .from("flow_runs")
    .update({
      last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
    })
    .eq("id", run.id);
  return { outcome: "advanced", node_key: node.node_key };
}

async function sendListAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ outcome: "advanced"; node_key: string }> {
  const cfg = node.config as unknown as SendListNodeConfig;
  const { whatsapp_message_id } = await sendListViaProvider(db, run, cfg);
  await logEvent(db, run.id, "message_sent", node.node_key, {
    node_type: "send_list",
    whatsapp_message_id,
  });
  const { data: msg } = await db
    .from("messages")
    .select("id")
    .eq("message_id", whatsapp_message_id)
    .maybeSingle();
  await db
    .from("flow_runs")
    .update({
      last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
    })
    .eq("id", run.id);
  return { outcome: "advanced", node_key: node.node_key };
}

async function executeHandoff(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<void> {
  const startedAt = Date.now();
  const input = { ...run.vars };
  const cfg = node.config as { assign_to?: string; team_id?: string; note?: string };
  try {
    const convUpdate: Record<string, unknown> = {
      status: "pending",
      updated_at: new Date().toISOString(),
    };
    if (cfg.assign_to) convUpdate.assigned_agent_id = cfg.assign_to;
    if (cfg.team_id) convUpdate.team_id = cfg.team_id;
    if (run.conversation_id) {
      await db
        .from("conversations")
        .update(convUpdate)
        .eq("id", run.conversation_id);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await endRun(db, run, "failed", "handoff_failed", {
      node_key: node.node_key,
      node_type: node.node_type,
      error_message: detail,
      err,
      input,
      output: { assigned_to: cfg.assign_to ?? null, team_id: cfg.team_id ?? null },
    });
    return;
  }
  await logEvent(db, run.id, "handoff", node.node_key, {
    note: cfg.note ?? null,
    assigned_to: cfg.assign_to ?? null,
    team_id: cfg.team_id ?? null,
  });
  await logRunEvent(db, {
    run_id: run.id,
    flow_id: run.flow_id,
    account_id: run.account_id,
    node_key: node.node_key,
    node_type: node.node_type,
    event_type: "node_completed",
    status: "success",
    duration_ms: Date.now() - startedAt,
    payload: {
      input,
      output: { assigned_to: cfg.assign_to ?? null, team_id: cfg.team_id ?? null },
    },
  });
  await endRun(db, run, "handed_off", "handoff_node");
}

/**
 * 'handoff_agent' — same as `executeHandoff`, but only ever sets
 * `assigned_agent_id`; `team_id` is not part of this node's config and
 * is never touched.
 */
async function executeHandoffAgent(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<void> {
  const startedAt = Date.now();
  const input = { ...run.vars };
  const cfg = node.config as { assign_to?: string; note?: string };
  try {
    const convUpdate: Record<string, unknown> = {
      status: "pending",
      updated_at: new Date().toISOString(),
    };
    if (cfg.assign_to) convUpdate.assigned_agent_id = cfg.assign_to;
    if (run.conversation_id) {
      await db
        .from("conversations")
        .update(convUpdate)
        .eq("id", run.conversation_id);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await endRun(db, run, "failed", "handoff_failed", {
      node_key: node.node_key,
      node_type: node.node_type,
      error_message: detail,
      err,
      input,
      output: { assigned_to: cfg.assign_to ?? null },
    });
    return;
  }
  await logEvent(db, run.id, "handoff", node.node_key, {
    note: cfg.note ?? null,
    assigned_to: cfg.assign_to ?? null,
    team_id: null,
  });
  await logRunEvent(db, {
    run_id: run.id,
    flow_id: run.flow_id,
    account_id: run.account_id,
    node_key: node.node_key,
    node_type: node.node_type,
    event_type: "node_completed",
    status: "success",
    duration_ms: Date.now() - startedAt,
    payload: { input, output: { assigned_to: cfg.assign_to ?? null } },
  });
  await endRun(db, run, "handed_off", "handoff_node");
}

/**
 * 'handoff_team' — same as `executeHandoff`, but only ever sets
 * `team_id`; `assign_to` is not part of this node's config and is
 * never touched.
 */
async function executeHandoffTeam(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<void> {
  const startedAt = Date.now();
  const input = { ...run.vars };
  const cfg = node.config as { team_id?: string; note?: string };
  try {
    const convUpdate: Record<string, unknown> = {
      status: "pending",
      updated_at: new Date().toISOString(),
    };
    if (cfg.team_id) convUpdate.team_id = cfg.team_id;
    if (run.conversation_id) {
      await db
        .from("conversations")
        .update(convUpdate)
        .eq("id", run.conversation_id);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await endRun(db, run, "failed", "handoff_failed", {
      node_key: node.node_key,
      node_type: node.node_type,
      error_message: detail,
      err,
      input,
      output: { assigned_to: cfg.team_id ?? null },
    });
    return;
  }
  await logEvent(db, run.id, "handoff", node.node_key, {
    note: cfg.note ?? null,
    assigned_to: null,
    team_id: cfg.team_id ?? null,
  });
  await logRunEvent(db, {
    run_id: run.id,
    flow_id: run.flow_id,
    account_id: run.account_id,
    node_key: node.node_key,
    node_type: node.node_type,
    event_type: "node_completed",
    status: "success",
    duration_ms: Date.now() - startedAt,
    payload: { input, output: { assigned_to: cfg.team_id ?? null } },
  });
  await endRun(db, run, "handed_off", "handoff_node");
}

/**
 * Resolve a condition node's subject value from DB / run state, then
 * call the pure `evaluateConditionPredicate`. Splits out so the
 * predicate itself stays unit-testable without a Supabase mock.
 *
 * Subject sources:
 *   - `var` → `flow_runs.vars[subject_key]` (captured by collect_input
 *     or http_fetch in v2).
 *   - `tag` → present iff `contact_tags(contact_id, tag_id)` exists.
 *     `subject_key` IS the tag UUID; the SELECT returns 1 row or 0.
 *   - `contact_field` → one of name/email/phone/company on `contacts`.
 */
/**
 * Resolves a `condition`/`switch` predicate's subject to a comparable
 * string (or `undefined` for "absent"). Shared by `evaluateConditionNode`
 * (one predicate) and `evaluateSwitchBranch` (N predicates across a
 * branch) so the var/tag/contact_field lookup logic lives in exactly
 * one place.
 */
async function resolveSubjectValue(
  db: AdminClient,
  run: FlowRunRow,
  subject: ConditionNodeConfig["subject"],
  subjectKey: string,
): Promise<string | undefined> {
  if (subject === "var") {
    const v = run.vars[subjectKey];
    return typeof v === "string" ? v : v === undefined ? undefined : String(v);
  } else if (subject === "tag") {
    const { count } = await db
      .from("contact_tags")
      .select("contact_id", { count: "exact", head: true })
      .eq("contact_id", run.contact_id!)
      .eq("tag_id", subjectKey);
    // For tags, "present" really is the only meaningful test — the
    // `present`/`absent` operators are the natural fit. equals/contains
    // against a tag UUID would still work mechanically (compare its
    // existence to the value).
    return (count ?? 0) > 0 ? subjectKey : undefined;
  } else {
    const ALLOWED = ["name", "email", "phone", "company"] as const;
    type AllowedField = (typeof ALLOWED)[number];
    if (!ALLOWED.includes(subjectKey as AllowedField)) {
      throw new Error(`unsupported contact_field: ${subjectKey}`);
    }
    const { data } = await db
      .from("contacts")
      .select(subjectKey)
      .eq("id", run.contact_id!)
      .maybeSingle();
    const raw = (data as Record<string, unknown> | null)?.[subjectKey];
    return typeof raw === "string" && raw.length > 0 ? raw : undefined;
  }
}

/**
 * Evaluates one `switch` branch: resolves every condition's subject,
 * then combines the results with the branch's own AND/OR combinator.
 * Conditions are resolved sequentially (not Promise.all) — branches
 * are already evaluated in order and most flows have few conditions
 * per branch, so the simplicity outweighs the parallelism.
 */
interface SwitchBranchEvaluation {
  passed: boolean;
  conditions: Array<{
    subject_key: string;
    resolved_value: string | null;
    operator: string;
    value: string | null;
    passed: boolean;
  }>;
}

async function evaluateSwitchBranch(
  db: AdminClient,
  run: FlowRunRow,
  branch: SwitchBranch,
): Promise<SwitchBranchEvaluation> {
  const results: boolean[] = [];
  const conditions: SwitchBranchEvaluation["conditions"] = [];
  for (const cond of branch.conditions) {
    const subjectValue = await resolveSubjectValue(
      db,
      run,
      cond.subject,
      cond.subject_key,
    );
    const passed = evaluateConditionPredicate({
      operator: cond.operator,
      subjectValue,
      configValue: cond.value,
    });
    results.push(passed);
    conditions.push({
      subject_key: cond.subject_key,
      resolved_value: subjectValue ?? null,
      operator: cond.operator,
      value: cond.value ?? null,
      passed,
    });
  }
  const passed =
    results.length === 0
      ? false
      : branch.combinator === "or"
        ? results.some(Boolean)
        : results.every(Boolean);
  return { passed, conditions };
}

/**
 * Tiny `{{vars.foo}}` interpolation. Used by send_message + collect_input
 * prompt text so a captured `name` can show up in the next prompt
 * ("Thanks {{vars.name}}, what's your email?"). Missing vars render as
 * empty string — the same behavior as the automations engine.
 */
function interpolateVars(template: string, vars: Record<string, unknown>): string {
  if (!template) return "";
  return template.replace(/\{\{vars\.([a-zA-Z0-9_]+)\}\}/g, (_, key) => {
    const v = vars[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

/**
 * Merge `patch` into `run.vars`, persist, and mirror the merge back
 * onto the in-memory `run` — same "write once, keep the local copy in
 * sync" pattern as the collect_input capture and the WAHA button-map
 * writes in sendButtonsViaProvider/sendListViaProvider.
 */
async function updateRunVars(
  db: AdminClient,
  run: FlowRunRow,
  patch: Record<string, unknown>,
): Promise<void> {
  const newVars = { ...run.vars, ...patch };
  const { error } = await db
    .from("flow_runs")
    .update({ vars: newVars })
    .eq("id", run.id);
  if (!error) run.vars = newVars;
}

/** Classify a MIME type into receive_attachment's allowed_types buckets. */
function mimeToAttachmentKind(
  mime: string,
): "image" | "video" | "audio" | "document" | null {
  if (!mime) return null;
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
}

/**
 * Ends a run and, alongside the existing status update, emits the
 * run-level `run_completed`/`run_error` event (migration 061) for the
 * run-history viewer. Every `endRun` call site in this file already
 * knows the run's outcome, so this single choke point is enough to
 * cover "run_completed — quando o run termina" without instrumenting
 * every caller separately.
 *
 * `errorContext`, when passed, means THIS run ended because a specific
 * node threw/failed — logs a `node_error` event for that node in
 * addition to the run-level event. Omit it for normal terminations
 * (end node, handoff, fallback exhaustion, go_to_flow transfer) where
 * nothing actually errored.
 */
async function endRun(
  db: AdminClient,
  run: Pick<FlowRunRow, "id" | "flow_id" | "account_id">,
  status:
    | "completed"
    | "handed_off"
    | "timed_out"
    | "failed"
    | "error"
    | "transferred",
  reason: string,
  errorContext?: {
    node_key: string | null;
    node_type?: string | null;
    error_message: string;
    /** Raw caught error, when available — unwrapped into `error_stack`. */
    err?: unknown;
    /** run.vars snapshot at node entry — becomes `input`/`input_at_error`. */
    input?: Record<string, unknown>;
    /** Whatever the node produced before failing, if anything. */
    output?: Record<string, unknown>;
  },
): Promise<void> {
  await db
    .from("flow_runs")
    .update({
      status,
      ended_at: new Date().toISOString(),
      end_reason: reason,
    })
    .eq("id", run.id);

  if (errorContext) {
    await logRunEvent(db, {
      run_id: run.id,
      flow_id: run.flow_id,
      account_id: run.account_id,
      node_key: errorContext.node_key,
      node_type: errorContext.node_type,
      event_type: "node_error",
      status: "error",
      error_message: errorContext.error_message,
      payload: {
        reason,
        ...buildErrorPayload(
          errorContext.input ?? {},
          errorContext.error_message,
          errorContext.err,
          errorContext.node_type ?? null,
          errorContext.output ?? {},
        ),
      },
    });
  }

  const isFailure = status === "failed" || status === "error" || status === "timed_out";
  await logRunEvent(db, {
    run_id: run.id,
    flow_id: run.flow_id,
    account_id: run.account_id,
    event_type: isFailure ? "run_error" : "run_completed",
    status: isFailure ? "error" : "success",
    error_message: errorContext?.error_message ?? null,
    payload: { end_reason: reason, run_status: status },
  });
}

/**
 * Ends the active flow run for a conversation, if one exists — for
 * callers outside the webhook dispatch path (inbox/monitoramento close
 * actions, the `close_conversation` automation step) that need to stop
 * an automated flow from continuing to process a conversation a human
 * just wrapped up. A no-op (not an error) when there's no active run —
 * every call site here is a best-effort side effect of closing, not a
 * precondition for it.
 *
 * `status: 'completed'` — `flow_runs.status` has no 'ended' value (see
 * FlowRunRow in types.ts); 'completed' is the closest first-class
 * terminal status for "run finished normally," which fits a human
 * resolving/tabulating the conversation better than 'failed'/'error'.
 */
export async function endActiveRunForConversation(
  conversationId: string,
  reason: string,
): Promise<void> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("flow_runs")
    .select("id, flow_id, account_id")
    .eq("conversation_id", conversationId)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("[flows] endActiveRunForConversation lookup error:", error.message);
    return;
  }
  if (data) {
    await endRun(
      db,
      data as Pick<FlowRunRow, "id" | "flow_id" | "account_id">,
      "completed",
      reason,
    );
    return;
  }

  // Fallback — a contact can have more than one conversation (e.g. two
  // WAHA lines), but only one active run per (account_id, contact_id).
  // If that run's conversation_id doesn't match the one being closed
  // (started on a different conversation than the one the agent is
  // wrapping up now, or already nulled out by a `conversations`/
  // `contacts` ON DELETE SET NULL elsewhere), resolve via the contact
  // instead. Best-effort: if the conversation row itself is gone (the
  // delete that orphaned the run also deleted it), there's nothing left
  // to resolve from and this quietly no-ops, same as the primary lookup.
  const { data: conv, error: convError } = await db
    .from("conversations")
    .select("contact_id, account_id")
    .eq("id", conversationId)
    .maybeSingle();
  if (convError) {
    console.error("[flows] endActiveRunForConversation conversation lookup error:", convError.message);
    return;
  }
  if (!conv?.contact_id) return;

  const { data: fallbackRun, error: fallbackError } = await db
    .from("flow_runs")
    .select("id, flow_id, account_id")
    .eq("account_id", conv.account_id)
    .eq("contact_id", conv.contact_id)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  if (fallbackError) {
    console.error("[flows] endActiveRunForConversation fallback lookup error:", fallbackError.message);
    return;
  }
  if (!fallbackRun) return;
  await endRun(
    db,
    fallbackRun as Pick<FlowRunRow, "id" | "flow_id" | "account_id">,
    "completed",
    reason,
  );
}

/**
 * Shared core of an ai_agent node's per-turn logic: reads the AI
 * config, calls handleAiAutoResponse with the conversation's last
 * customer message, reads back the bot's reply (scoped by
 * `received_at` — our own server clock on both sides, see
 * migration 043_messages_received_at.sql; `created_at` would be wrong
 * here since an inbound message's created_at is copied from the
 * provider's own clock), and extracts a #TAG exit code if present.
 *
 * Used both when a run first enters an ai_agent node
 * (`advanceFromNodeKey` below) and when a reply arrives while parked
 * in loop mode (`handleReplyForActiveRun`) — both cases are "the
 * customer's last message needs an AI turn," so both re-query the
 * same way rather than one trusting a passed-in value the other
 * doesn't have.
 */
async function runAiAgentCore(
  db: AdminClient,
  run: FlowRunRow,
  systemPromptOverride?: string,
  incomingTextOverride?: string,
  historyAfter?: string,
): Promise<
  | {
      ok: true;
      lastReply: string;
      exitCodeFound: string | null;
      modelUsed: string | null;
      aiConfigUsable: boolean;
      baseOutput: Record<string, unknown>;
    }
  | {
      ok: false;
      detail: string;
      err: unknown;
      lastReply: string;
      exitCodeFound: string | null;
      modelUsed: string | null;
      aiConfigUsable: boolean;
    }
> {
  let lastReply = "";
  let exitCodeFound: string | null = null;
  let modelUsed: string | null = null;
  let aiConfigUsable = false;
  try {
    // Best-effort — mirrors ai_config.api_provider to the model
    // string handleAiAutoResponse actually calls (see
    // MODEL_BY_PROVIDER's own comment on the duplication risk).
    // Also doubles as the "is there even a usable config" check
    // for the output.error_reason below — same row, no extra query.
    const { data: aiConfigRow } = await db
      .from("ai_config")
      .select("api_provider, enabled")
      .eq("account_id", run.account_id)
      .maybeSingle();
    const configRow = aiConfigRow as
      | { api_provider: string; enabled: boolean }
      | null;
    aiConfigUsable = !!configRow?.enabled;
    modelUsed = configRow?.api_provider
      ? (MODEL_BY_PROVIDER[configRow.api_provider] ?? configRow.api_provider)
      : null;

    // Last customer message is the AI's input — same "what does the
    // customer want answered" the standalone auto-responder uses.
    let incomingText: string;
    let incomingMsg: { content_text: string | null; received_at: string } | null = null;

    if (incomingTextOverride !== undefined && incomingTextOverride !== "") {
      // Mensagem já disponível no caller — evita race condition de leitura do banco
      incomingText = incomingTextOverride;
      // Ainda precisamos do received_at para filtrar a query do bot depois
      const { data: msgRow } = await db
        .from("messages")
        .select("content_text, received_at")
        .eq("conversation_id", run.conversation_id!)
        .eq("sender_type", "customer")
        .order("received_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      incomingMsg = msgRow as { content_text: string | null; received_at: string } | null;
    } else {
      // Trigger inicial: busca normalmente do banco
      const { data: lastCustomerMsg } = await db
        .from("messages")
        .select("content_text, received_at")
        .eq("conversation_id", run.conversation_id!)
        .eq("sender_type", "customer")
        .order("received_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      incomingMsg = lastCustomerMsg as { content_text: string | null; received_at: string } | null;
      incomingText = incomingMsg?.content_text ?? "";
    }

    // skipDebounce: true — debounceAiAgentReply (handleReplyForActiveRun)
    // already serializes replies per run_id before this ever runs, so
    // responder.ts's own 4s sleep-and-recheck would just double the delay
    // for no extra protection.
    const beforeAiCall = new Date().toISOString();

    const detectedTag = await handleAiAutoResponse(
      run.account_id,
      run.contact_id!,
      run.conversation_id!,
      incomingText,
      systemPromptOverride,
      true, // skipDebounce
      historyAfter,
    );

    // Filtra pelo momento imediatamente anterior à chamada da IA —
    // garante que pegamos apenas a mensagem recém-enviada, ignorando
    // bot messages de runs anteriores que possam ter timestamps mais recentes.
    const { data: lastBotMsg } = await db
      .from("messages")
      .select("content_text")
      .eq("conversation_id", run.conversation_id!)
      .eq("sender_type", "bot")
      .gt("received_at", beforeAiCall)
      .order("received_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    lastReply =
      (lastBotMsg as { content_text: string | null } | null)?.content_text ??
      "";

    // Exit-code convention: the AI's system prompt can instruct it to
    // end a reply with a #TAG keyword (e.g. #NEGOCIACAO) that a Switch
    // node downstream branches on (subject_key: "ai_exit_code"). Only
    // overwrite when a tag is actually found — no match means "still
    // talking," not "clear the previous exit code." Uses the tag
    // handleAiAutoResponse detected BEFORE stripping it from the text it
    // sends/persists — re-matching against `lastReply` (the persisted,
    // already-stripped copy) would never find any of the built-in tags
    // (#ACORDOFORMALIZADO, #EQUIPEHUMANA, etc.), since those are removed
    // before the message is saved.
    if (detectedTag) {
      exitCodeFound = detectedTag;
      await updateRunVars(db, run, { ai_exit_code: exitCodeFound });
    }

    const baseOutput = {
      last_reply: lastReply.slice(-300),
      ai_exit_code: exitCodeFound,
      model_used: modelUsed,
      ...(!aiConfigUsable
        ? { error_reason: "ai_config_disabled_or_missing" }
        : {}),
      ...(lastReply === "" ? { warning: "ai_returned_empty_reply" } : {}),
    };

    return {
      ok: true,
      lastReply,
      exitCodeFound,
      modelUsed,
      aiConfigUsable,
      baseOutput,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, detail, err, lastReply, exitCodeFound, modelUsed, aiConfigUsable };
  }
}

// ============================================================
// The synchronous advance loop. Walks through auto-advance nodes
// until it hits one that suspends (send_buttons/send_list) or
// terminates (handoff/end). Each suspending node persists the
// new current_node_key before returning.
// ============================================================

export async function advanceFromNodeKey(
  db: AdminClient,
  run: FlowRunRow,
  startNodeKey: string,
  nodes: Map<string, FlowNodeRow>,
  triggerMessage?: ParsedInbound,
): Promise<{ outcome: "advanced" | "completed" | "handed_off" | "transferred" }> {
  let currentKey: string | null = startNodeKey;
  // Defensive cap — if a flow has a cycle (which the validator
  // SHOULD catch but doesn't yet in v1), we bail rather than loop.
  for (let safety = 0; safety < 64; safety += 1) {
    if (!currentKey) {
      await logEvent(db, run.id, "error", null, {
        reason: "next_node_key was null mid-advance",
      });
      await endRun(db, run, "failed", "missing_next_node", {
        node_key: null,
        error_message: "next_node_key was null mid-advance",
      });
      return { outcome: "completed" };
    }
    const node: FlowNodeRow | null = nodes.get(currentKey) ?? null;
    if (!node) {
      await logEvent(db, run.id, "error", currentKey, {
        reason: "node_not_found",
      });
      await endRun(db, run, "failed", "node_not_found", {
        node_key: currentKey,
        error_message: "node_not_found",
      });
      return { outcome: "completed" };
    }
    await logEvent(db, run.id, "node_entered", node.node_key, {
      node_type: node.node_type,
    });
    const nodeStartedAt = Date.now();
    // Snapshot BEFORE the node's own logic runs (and possibly mutates
    // run.vars via updateRunVars) — this is the node's "input" for the
    // debug timeline, consistent across every node type without each
    // dispatch branch needing to capture it separately.
    const inputSnapshot: Record<string, unknown> = { ...run.vars };
    const nodeCompleted = (output: Record<string, unknown> = {}) =>
      logRunEvent(db, {
        run_id: run.id,
        flow_id: run.flow_id,
        account_id: run.account_id,
        node_key: node.node_key,
        node_type: node.node_type,
        event_type: "node_completed",
        status: "success",
        duration_ms: Date.now() - nodeStartedAt,
        payload: { input: inputSnapshot, output },
      });
    const nodeError = (
      error_message: string,
      err?: unknown,
      output: Record<string, unknown> = {},
    ) =>
      logRunEvent(db, {
        run_id: run.id,
        flow_id: run.flow_id,
        account_id: run.account_id,
        node_key: node.node_key,
        node_type: node.node_type,
        event_type: "node_error",
        status: "error",
        error_message,
        duration_ms: Date.now() - nodeStartedAt,
        payload: buildErrorPayload(
          inputSnapshot,
          error_message,
          err,
          node.node_type,
          output,
        ),
      });

    if (node.node_type === "start") {
      currentKey = (node.config as unknown as StartNodeConfig).next_node_key;
      await nodeCompleted({ next_node_key: currentKey });
      continue;
    }
    if (node.node_type === "send_message") {
      const cfg = node.config as unknown as SendMessageNodeConfig;
      const message_text = interpolateVars(cfg.text, run.vars);
      try {
        const { whatsapp_message_id } = await sendTextViaProvider(run, {
          text: message_text,
        });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "send_message",
          whatsapp_message_id,
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_text_failed",
          detail,
        });
        await endRun(db, run, "failed", "send_text_failed", {
          node_key: node.node_key,
          node_type: node.node_type,
          error_message: detail,
          err,
          input: inputSnapshot,
          output: { message_text },
        });
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      await nodeCompleted({ message_text });
      continue;
    }
    if (node.node_type === "send_media") {
      const cfg = node.config as unknown as SendMediaNodeConfig;
      const caption = cfg.caption
        ? interpolateVars(cfg.caption, run.vars)
        : undefined;
      try {
        const { whatsapp_message_id } = await sendMediaViaProvider(run, {
          kind: cfg.media_type,
          link: cfg.media_url,
          caption,
          filename: cfg.filename,
        });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "send_media",
          media_type: cfg.media_type,
          whatsapp_message_id,
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_media_failed",
          detail,
        });
        await endRun(db, run, "failed", "send_media_failed", {
          node_key: node.node_key,
          node_type: node.node_type,
          error_message: detail,
          err,
          input: inputSnapshot,
          output: { media_url: cfg.media_url, caption },
        });
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      await nodeCompleted({ media_url: cfg.media_url, caption });
      continue;
    }
    if (node.node_type === "collect_input") {
      // Send the prompt and suspend. Customer's next TEXT reply will
      // wake us up via handleReplyForActiveRun's collect_input branch.
      const cfg = node.config as unknown as CollectInputNodeConfig;
      const message_text = interpolateVars(cfg.prompt_text, run.vars);
      try {
        const { whatsapp_message_id } = await sendTextViaProvider(run, {
          text: message_text,
        });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "collect_input",
          whatsapp_message_id,
        });
        const { data: msg } = await db
          .from("messages")
          .select("id")
          .eq("message_id", whatsapp_message_id)
          .maybeSingle();
        await db
          .from("flow_runs")
          .update({
            last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
          })
          .eq("id", run.id);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "collect_input_prompt_failed",
          detail,
        });
        await endRun(db, run, "failed", "collect_input_prompt_failed", {
          node_key: node.node_key,
          node_type: node.node_type,
          error_message: detail,
          err,
          input: inputSnapshot,
          output: { message_text },
        });
        return { outcome: "completed" };
      }
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      await nodeCompleted({ message_text });
      return { outcome: "advanced" };
    }
    if (node.node_type === "condition") {
      const cfg = node.config as unknown as ConditionNodeConfig;
      let branch: "true" | "false";
      let conditionSubjectValue: string | undefined;
      try {
        conditionSubjectValue = await resolveSubjectValue(
          db,
          run,
          cfg.subject,
          cfg.subject_key,
        );
        branch = evaluateConditionPredicate({
          operator: cfg.operator,
          subjectValue: conditionSubjectValue,
          configValue: cfg.value,
        })
          ? "true"
          : "false";
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "condition_evaluation_failed",
          detail,
        });
        await endRun(db, run, "failed", "condition_evaluation_failed", {
          node_key: node.node_key,
          node_type: node.node_type,
          error_message: detail,
          err,
          input: inputSnapshot,
        });
        return { outcome: "completed" };
      }
      currentKey =
        branch === "true" ? cfg.true_next : cfg.false_next;
      await logEvent(db, run.id, "node_entered", node.node_key, {
        condition_result: branch,
        advancing_to: currentKey,
      });
      await nodeCompleted({
        branch_chosen: branch,
        variable_value: conditionSubjectValue ?? null,
        advancing_to: currentKey,
      });
      continue;
    }
    if (node.node_type === "switch") {
      const cfg = node.config as unknown as SwitchNodeConfig;
      let matchedBranchIndex: number | null = null;
      // Evaluated in order, stopping at the first match (first-branch-
      // wins routing) — conditions_evaluated below reflects exactly
      // the branches actually tested, not the full configured list.
      const conditionsEvaluated: Array<{
        branch: string;
        result: boolean;
        conditions: SwitchBranchEvaluation["conditions"];
      }> = [];
      try {
        for (let i = 0; i < cfg.branches.length; i++) {
          const evaluation = await evaluateSwitchBranch(db, run, cfg.branches[i]);
          conditionsEvaluated.push({
            branch: cfg.branches[i].label,
            result: evaluation.passed,
            conditions: evaluation.conditions,
          });
          if (evaluation.passed) {
            matchedBranchIndex = i;
            break;
          }
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "switch_evaluation_failed",
          detail,
        });
        await endRun(db, run, "failed", "switch_evaluation_failed", {
          node_key: node.node_key,
          node_type: node.node_type,
          error_message: detail,
          err,
          input: inputSnapshot,
          output: { conditions_evaluated: conditionsEvaluated },
        });
        return { outcome: "completed" };
      }
      currentKey =
        matchedBranchIndex === null
          ? cfg.default_next
          : cfg.branches[matchedBranchIndex].next_node_key;
      const chosenBranch =
        matchedBranchIndex === null
          ? "fallback"
          : cfg.branches[matchedBranchIndex].label;
      // Best-effort single "the value that decided this" — a switch can
      // have multiple conditions per branch (unlike `condition`'s single
      // subject), so this is the first condition's resolved value in the
      // branch that actually matched (or the last one tried, on fallback).
      // conditions_evaluated carries the full per-condition detail.
      const lastEvaluation = conditionsEvaluated[conditionsEvaluated.length - 1];
      const variableValue = lastEvaluation?.conditions[0]?.resolved_value ?? null;
      await logEvent(db, run.id, "node_entered", node.node_key, {
        switch_result:
          matchedBranchIndex === null
            ? "default"
            : cfg.branches[matchedBranchIndex].label,
        advancing_to: currentKey,
        branch_chosen:
          matchedBranchIndex === null
            ? null
            : cfg.branches[matchedBranchIndex].label,
        branch_index: matchedBranchIndex,
        fell_through: matchedBranchIndex === null,
      });
      await nodeCompleted({
        conditions_evaluated: conditionsEvaluated,
        chosen_branch: chosenBranch,
        variable_value: variableValue,
        advancing_to: currentKey,
      });
      continue;
    }
    if (node.node_type === "set_tag") {
      const cfg = node.config as unknown as SetTagNodeConfig;
      try {
        if (cfg.mode === "add") {
          await db
            .from("contact_tags")
            .upsert(
              { contact_id: run.contact_id!, tag_id: cfg.tag_id },
              { onConflict: "contact_id,tag_id" },
            );
        } else {
          await db
            .from("contact_tags")
            .delete()
            .eq("contact_id", run.contact_id!)
            .eq("tag_id", cfg.tag_id);
        }
        await nodeCompleted({ mode: cfg.mode, tag_id: cfg.tag_id });
      } catch (err) {
        // Non-fatal — log + advance. A tag-write failure shouldn't
        // strand the customer mid-flow.
        const detail = err instanceof Error ? err.message : String(err);
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "set_tag_failed",
          detail,
        });
        await nodeError(detail, err, { mode: cfg.mode, tag_id: cfg.tag_id });
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "send_buttons") {
      const cfg = node.config as unknown as SendButtonsNodeConfig;
      const message_text = interpolateVars(cfg.text, run.vars);
      try {
        await sendButtonsAndSuspend(db, run, node);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_buttons_failed",
          detail,
        });
        await endRun(db, run, "failed", "send_buttons_failed", {
          node_key: node.node_key,
          node_type: node.node_type,
          error_message: detail,
          err,
          input: inputSnapshot,
          output: { message_text },
        });
        return { outcome: "completed" };
      }
      // Persist the new current_node_key via optimistic UPDATE.
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      await nodeCompleted({ message_text });
      return { outcome: "advanced" };
    }
    if (node.node_type === "send_list") {
      const cfg = node.config as unknown as SendListNodeConfig;
      const message_text = interpolateVars(cfg.text, run.vars);
      try {
        await sendListAndSuspend(db, run, node);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_list_failed",
          detail,
        });
        await endRun(db, run, "failed", "send_list_failed", {
          node_key: node.node_key,
          node_type: node.node_type,
          error_message: detail,
          err,
          input: inputSnapshot,
          output: { message_text },
        });
        return { outcome: "completed" };
      }
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      await nodeCompleted({ message_text });
      return { outcome: "advanced" };
    }
    if (node.node_type === "handoff") {
      await executeHandoff(db, run, node);
      return { outcome: "handed_off" };
    }
    if (node.node_type === "handoff_agent") {
      await executeHandoffAgent(db, run, node);
      return { outcome: "handed_off" };
    }
    if (node.node_type === "handoff_team") {
      await executeHandoffTeam(db, run, node);
      return { outcome: "handed_off" };
    }
    if (node.node_type === "end") {
      await logEvent(db, run.id, "completed", node.node_key);
      await nodeCompleted();
      await endRun(db, run, "completed", "end_node");
      return { outcome: "completed" };
    }
    if (node.node_type === "http_fetch") {
      const cfg = node.config as unknown as HttpFetchNodeConfig;
      const url = interpolateVars(cfg.url, run.vars);
      const timeoutMs = (cfg.timeout_seconds ?? 10) * 1000;
      try {
        const res = await fetch(url, {
          method: cfg.method,
          headers: cfg.headers,
          body:
            cfg.method === "GET" || !cfg.body_template
              ? undefined
              : interpolateVars(cfg.body_template, run.vars),
          signal: AbortSignal.timeout(timeoutMs),
        });
        let responseBodyText: string;
        if (cfg.response_var) {
          let parsed: unknown;
          try {
            parsed = await res.clone().json();
          } catch {
            parsed = await res.text();
          }
          await updateRunVars(db, run, { [cfg.response_var]: parsed });
          responseBodyText =
            typeof parsed === "string" ? parsed : JSON.stringify(parsed);
        } else {
          responseBodyText = await res.clone().text();
        }
        const response_body =
          responseBodyText.length > 2000
            ? `${responseBodyText.slice(0, 2000)}...[truncado]`
            : responseBodyText;
        await logEvent(db, run.id, "node_entered", node.node_key, {
          node_type: "http_fetch",
          status: res.status,
        });
        await nodeCompleted({
          method: cfg.method,
          url,
          response_status: res.status,
          response_body,
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "http_fetch_failed",
          detail,
        });
        await nodeError(detail, err, { method: cfg.method, url });
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "set_variable") {
      const cfg = node.config as unknown as SetVariableNodeConfig;
      const patch: Record<string, unknown> = {};
      for (const a of cfg.assignments ?? []) {
        if (!a.variable) continue;
        patch[a.variable] = interpolateVars(a.value, run.vars);
      }
      await updateRunVars(db, run, patch);
      const variables_set = Object.entries(patch).map(([key, value]) => {
        const str = String(value);
        return {
          key,
          value: str.length > 200 ? `${str.slice(0, 200)}...[truncado]` : str,
        };
      });
      await logEvent(db, run.id, "node_entered", node.node_key, {
        variables_set,
      });
      currentKey = cfg.next_node_key;
      await nodeCompleted({
        variables_set: Object.fromEntries(
          variables_set.map((v) => [v.key, v.value]),
        ),
      });
      continue;
    }
    if (node.node_type === "smart_delay") {
      const cfg = node.config as unknown as SmartDelayNodeConfig;
      if (cfg.message) {
        try {
          await sendTextViaProvider(run, {
            text: interpolateVars(cfg.message, run.vars),
          });
          await logEvent(db, run.id, "message_sent", node.node_key, {
            node_type: "smart_delay",
          });
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          await logEvent(db, run.id, "error", node.node_key, {
            reason: "smart_delay_message_failed",
            detail,
          });
          await nodeError(detail, err, {
            message_text: interpolateVars(cfg.message, run.vars),
          });
        }
      }
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (advanced) {
        const wakeAt = new Date(
          Date.now() + cfg.delay_seconds * 1000,
        ).toISOString();
        await db
          .from("flow_runs")
          .update({ status: "delayed", wake_at: wakeAt })
          .eq("id", run.id);
      } else {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      await nodeCompleted({ delay_seconds: cfg.delay_seconds });
      return { outcome: "advanced" };
    }
    if (node.node_type === "anchor") {
      const cfg = node.config as unknown as AnchorNodeConfig;
      currentKey = cfg.next_node_key;
      await nodeCompleted();
      continue;
    }
    if (node.node_type === "go_to") {
      const cfg = node.config as unknown as GoToNodeConfig;
      if (run.hops_count >= MAX_HOPS) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "go_to_hop_limit_exceeded",
        });
        await endRun(db, run, "error", "go_to_hop_limit_exceeded", {
          node_key: node.node_key,
          node_type: node.node_type,
          error_message: "go_to hop limit exceeded",
          input: inputSnapshot,
        });
        return { outcome: "completed" };
      }
      run.hops_count += 1;
      await db
        .from("flow_runs")
        .update({ hops_count: run.hops_count })
        .eq("id", run.id);
      currentKey = cfg.target_node_key;
      await nodeCompleted({ target_node_key: cfg.target_node_key });
      continue;
    }
    if (node.node_type === "go_to_flow") {
      const cfg = node.config as unknown as GoToFlowNodeConfig;
      const targetFlow = await loadFlow(db, cfg.flow_id);
      if (
        !targetFlow ||
        targetFlow.account_id !== run.account_id ||
        targetFlow.status !== "active" ||
        !targetFlow.entry_node_id
      ) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "go_to_flow_invalid_target",
          flow_id: cfg.flow_id,
        });
        await endRun(db, run, "error", "go_to_flow_invalid_target", {
          node_key: node.node_key,
          node_type: node.node_type,
          error_message: `go_to_flow_invalid_target:${cfg.flow_id}`,
          input: inputSnapshot,
          output: { flow_id: cfg.flow_id },
        });
        return { outcome: "completed" };
      }
      await nodeCompleted({ flow_id: cfg.flow_id });
      await endRun(db, run, "transferred", "go_to_flow");
      const targetNodes = await loadAllNodes(db, targetFlow.id);
      await startTransferredRun(db, targetFlow, run, cfg.pass_vars, targetNodes);
      return { outcome: "transferred" };
    }
    if (node.node_type === "send_template") {
      const cfg = node.config as unknown as SendTemplateNodeConfig;
      try {
        const provider = run.config_id
          ? await getConfigProvider(run.config_id)
          : "meta";
        if (provider === "waha") {
          if (cfg.fallback_text) {
            await sendTextViaProvider(run, {
              text: interpolateVars(cfg.fallback_text, run.vars),
            });
          }
        } else {
          await engineMetaSendTemplate({
            accountId: run.account_id,
            configId: run.config_id ?? undefined,
            conversationId: run.conversation_id!,
            contactId: run.contact_id!,
            templateName: cfg.template_name,
            languageCode: cfg.language_code,
            components: cfg.components,
          });
        }
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "send_template",
          template_name: cfg.template_name,
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_template_failed",
          detail,
        });
        await endRun(db, run, "failed", "send_template_failed", {
          node_key: node.node_key,
          node_type: node.node_type,
          error_message: detail,
          err,
          input: inputSnapshot,
          output: { template_name: cfg.template_name },
        });
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      await nodeCompleted({ message_text: cfg.template_name });
      continue;
    }
    if (node.node_type === "add_note") {
      const cfg = node.config as unknown as AddNoteNodeConfig;
      const note_text = interpolateVars(cfg.note_text, run.vars);
      try {
        await db.from("contact_notes").insert({
          contact_id: run.contact_id!,
          user_id: run.user_id,
          note_text,
        });
        await nodeCompleted({ note_text });
      } catch (err) {
        // Non-fatal — a note-write failure shouldn't strand the customer.
        const detail = err instanceof Error ? err.message : String(err);
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "add_note_failed",
          detail,
        });
        await nodeError(detail, err, { note_text });
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "receive_attachment") {
      const cfg = node.config as unknown as ReceiveAttachmentNodeConfig;
      if (cfg.prompt_text) {
        try {
          const { whatsapp_message_id } = await sendTextViaProvider(run, {
            text: interpolateVars(cfg.prompt_text, run.vars),
          });
          await logEvent(db, run.id, "message_sent", node.node_key, {
            node_type: "receive_attachment",
            whatsapp_message_id,
          });
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          await logEvent(db, run.id, "error", node.node_key, {
            reason: "receive_attachment_prompt_failed",
            detail,
          });
          await endRun(db, run, "failed", "receive_attachment_prompt_failed", {
            node_key: node.node_key,
            node_type: node.node_type,
            error_message: detail,
            err,
            input: inputSnapshot,
            output: { message_text: interpolateVars(cfg.prompt_text, run.vars) },
          });
          return { outcome: "completed" };
        }
      }
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      await nodeCompleted();
      return { outcome: "advanced" };
    }
    if (node.node_type === "ai_agent") {
      const cfg = node.config as unknown as AiAgentNodeConfig;
      const core = await runAiAgentCore(
        db,
        run,
        cfg.system_prompt_override || undefined,
        undefined,       // trigger keyword não é input — AI lê do DB e recebe vazio
        run.started_at,  // exclui trigger e histórico de runs anteriores
      );
      if (!core.ok) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "ai_agent_failed",
          detail: core.detail,
          exit_reason: "error",
        });
        await endRun(db, run, "failed", "ai_agent_failed", {
          node_key: node.node_key,
          node_type: node.node_type,
          error_message: core.detail,
          err: core.err,
          input: inputSnapshot,
          output: {
            last_reply: core.lastReply.slice(-300),
            ai_exit_code: core.exitCodeFound,
            model_used: core.modelUsed,
            ...(!core.aiConfigUsable
              ? { error_reason: "ai_config_disabled_or_missing" }
              : {}),
          },
        });
        return { outcome: "completed" };
      }

      const { lastReply, exitCodeFound, baseOutput } = core;
      await logEvent(db, run.id, "message_sent", node.node_key, {
        node_type: "ai_agent",
        mode: cfg.mode,
        last_reply: lastReply.slice(-300),
      });

      if (cfg.mode === "takeover") {
        await logEvent(db, run.id, "handoff", node.node_key, {
          reason: "ai_agent_takeover",
          turns_used: 1,
          // Not one of exit_code_detected/max_turns/single_response —
          // a takeover ends the run via handoff, it doesn't advance to
          // another node or hit the turn cap. Labeling it as either of
          // those would misdescribe what actually happened.
          exit_reason: "takeover",
        });
        await nodeCompleted({
          ...baseOutput,
          turns_used: 1,
          exit_reason: "takeover",
        });
        await endRun(db, run, "handed_off", "ai_agent_takeover");
        return { outcome: "handed_off" };
      }

      if (cfg.mode === "loop") {
        const maxTurns = cfg.max_turns ?? 20;
        const priorTurns =
          typeof run.vars.__ai_turns__ === "number"
            ? (run.vars.__ai_turns__ as number)
            : 0;
        const turns = priorTurns + 1;
        if (exitCodeFound || turns >= maxTurns) {
          // Cap hit OR the agent's reply just carried a #TAG exit code
          // (ai_exit_code was set above) — either way the loop is done:
          // reset the counter (in case this node is ever re-entered
          // later via go_to) and advance to the same configured
          // next_node_key so a downstream Switch can route on
          // ai_exit_code instead of the loop suspending for another
          // customer reply that will never come.
          await updateRunVars(db, run, { __ai_turns__: 0 });
          const nextKey = cfg.next_node_key ?? null;
          const exitReason = exitCodeFound ? "exit_code_detected" : "max_turns";
          await logEvent(db, run.id, "node_entered", node.node_key, {
            turns_used: turns,
            exit_reason: exitCodeFound ? "exit_code_matched" : "limit_reached",
          });
          await nodeCompleted({
            ...baseOutput,
            turns_used: turns,
            exit_reason: exitReason,
          });

          if (nextKey && nodes.get(nextKey)?.node_type === "ai_agent") {
            // Don't chain straight into another ai_agent node's turn
            // with the SAME customer message that just closed this one
            // out — runAiAgentCore always reads "the last customer
            // message," which hasn't changed yet, so an immediate
            // continue here would process it twice and send two real
            // replies for one customer message. Park at the next node
            // instead and let the customer's actual next reply drive it
            // via handleReplyForActiveRun's (debounced) ai_agent branch.
            const advanced = await advanceCurrentNodeKey(
              db,
              run.id,
              run.current_node_key,
              nextKey,
            );
            if (!advanced) {
              await logEvent(db, run.id, "error", node.node_key, {
                reason: "lost_race_during_advance",
              });
            }
            return { outcome: "advanced" };
          }

          currentKey = nextKey;
          continue;
        }
        await updateRunVars(db, run, { __ai_turns__: turns });
        const advanced = await advanceCurrentNodeKey(
          db,
          run.id,
          run.current_node_key,
          node.node_key,
        );
        if (!advanced) {
          await logEvent(db, run.id, "error", node.node_key, {
            reason: "lost_race_during_advance",
          });
        }
        // Still under the turn cap — suspends at this same node
        // waiting for the customer's next reply, doesn't move to
        // another node yet. Not one of the 3 requested exit_reason
        // values (none mean "still looping, no tag yet") — reusing
        // "awaiting_reply" from the node_entered event above rather
        // than mislabeling it as max_turns/single_response.
        await logEvent(db, run.id, "node_entered", node.node_key, {
          turns_used: turns,
          exit_reason: "awaiting_reply",
        });
        await nodeCompleted({
          ...baseOutput,
          turns_used: turns,
          exit_reason: "awaiting_reply",
        });
        return { outcome: "advanced" };
      }

      // mode === "once"
      currentKey = cfg.next_node_key ?? null;
      await logEvent(db, run.id, "node_entered", node.node_key, {
        turns_used: 1,
        exit_reason: "next_node_set",
      });
      await nodeCompleted({
        ...baseOutput,
        turns_used: 1,
        exit_reason: "single_response",
      });
      continue;
    }
    // Unknown node type — shouldn't happen given the CHECK constraint.
    await logEvent(db, run.id, "error", node.node_key, {
      reason: `unknown_node_type:${node.node_type}`,
    });
    await endRun(db, run, "failed", "unknown_node_type", {
      node_key: node.node_key,
      node_type: node.node_type,
      error_message: `unknown_node_type:${node.node_type}`,
      input: inputSnapshot,
    });
    return { outcome: "completed" };
  }
  // Safety break — log + fail.
  await logEvent(db, run.id, "error", currentKey, {
    reason: "advance_loop_safety_break",
  });
  await endRun(db, run, "failed", "advance_loop_overflow", {
    node_key: currentKey,
    error_message: "advance_loop_safety_break",
  });
  return { outcome: "completed" };
}

/**
 * Optimistic UPDATE — only advance current_node_key when it matches
 * the value we read at the top of dispatch. If another webhook beat
 * us, the row's pointer has already moved and our UPDATE returns
 * zero rows; we treat that as a no-op and let the other run continue.
 */
async function advanceCurrentNodeKey(
  db: AdminClient,
  runId: string,
  expectedOldKey: string | null,
  newKey: string,
): Promise<boolean> {
  // PostgREST: when expectedOldKey is null we can't `.eq` (would match
  // any row); use `.is('current_node_key', null)` instead.
  let q = db
    .from("flow_runs")
    .update({
      current_node_key: newKey,
      last_advanced_at: new Date().toISOString(),
    })
    .eq("id", runId)
    .eq("status", "active");
  if (expectedOldKey === null) {
    q = q.is("current_node_key", null);
  } else {
    q = q.eq("current_node_key", expectedOldKey);
  }
  const { data, error } = await q.select("id");
  if (error) {
    console.error("[flows] advanceCurrentNodeKey error:", error.message);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

// ============================================================
// Public entry point — the webhook calls this on every inbound.
// ============================================================

export async function dispatchInboundToFlows(
  input: DispatchInboundInput & { isFirstInboundMessage: boolean },
): Promise<DispatchInboundResult> {
  const db = supabaseAdmin();
  try {
    const activeRun = await loadActiveRunForContact(
      db,
      input.accountId,
      input.contactId,
    );

    // Idempotency — only matters if there's already a run for this
    // contact. For new runs, the partial unique index catches duplicate
    // starts at INSERT time.
    if (activeRun) {
      const dupe = await isDuplicateInbound(
        db,
        input.accountId,
        input.contactId,
        inboundMessageId(input.message),
      );
      if (dupe) {
        return {
          consumed: true,
          flow_run_id: activeRun.id,
          outcome: "duplicate_inbound_ignored",
        };
      }
      // One SELECT for the whole flow's nodes — advance loop is now
      // in-memory. See loadAllNodes.
      const nodes = await loadAllNodes(db, activeRun.flow_id);
      return handleReplyForActiveRun(db, activeRun, input.message, nodes);
    }

    // No active run → look for a flow whose entry trigger matches.
    const flow = await findEntryFlow(
      db,
      input.accountId,
      input.message,
      input.isFirstInboundMessage,
      input.configId,
    );
    if (!flow || !flow.entry_node_id) {
      return { consumed: false, outcome: "no_match" };
    }
    const nodes = await loadAllNodes(db, flow.id);
    return startNewRun(db, flow, input, nodes);
  } catch (err) {
    console.error(
      "[flows] dispatchInboundToFlows threw:",
      err instanceof Error ? err.message : err,
    );
    return { consumed: false, outcome: "no_match" };
  }
}

/**
 * Debounce for ai_agent loop-mode replies. Two customer messages sent
 * a couple seconds apart (e.g. "segunda via de boleto" then "2") each
 * arrive as their own webhook call and their own `handleReplyForActiveRun`
 * invocation — without this, each independently calls `runAiAgentCore`
 * and the AI answers twice instead of once with the combined context.
 *
 * Keyed by run_id: only one pending timer per active run. A reply that
 * arrives while another is still waiting cancels the earlier timer
 * (and resolves its promise to `false` immediately, so that older
 * request doesn't hang for the rest of the window) and restarts the
 * clock. Only the reply that survives the full window uninterrupted
 * proceeds — by then `runAiAgentCore` re-reads the latest customer
 * message from `messages`, so it naturally picks up whatever the
 * customer sent last, combined turn included.
 */
const AI_AGENT_REPLY_DEBOUNCE_MS = 4000;
const aiAgentReplyDebounceTimers = new Map<
  string,
  { timer: ReturnType<typeof setTimeout>; resolve: (proceed: boolean) => void }
>();

function debounceAiAgentReply(runId: string): Promise<boolean> {
  const pending = aiAgentReplyDebounceTimers.get(runId);
  if (pending) {
    clearTimeout(pending.timer);
    pending.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      aiAgentReplyDebounceTimers.delete(runId);
      resolve(true);
    }, AI_AGENT_REPLY_DEBOUNCE_MS);
    aiAgentReplyDebounceTimers.set(runId, { timer, resolve });
  });
}

async function handleReplyForActiveRun(
  db: AdminClient,
  run: FlowRunRow,
  message: ParsedInbound,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult> {
  // This event is about the delivery (which message, what kind), not
  // the captured value — text_length only. The actual reply text is
  // logged on collect_input's own node_entered event below.
  await logEvent(db, run.id, "reply_received", run.current_node_key, {
    meta_message_id: inboundMessageId(message),
    reply_kind: message.kind,
    reply_id: message.kind === "interactive_reply" ? message.reply_id : null,
    text_length: message.kind === "text" ? message.text.length : null,
    // For the debug timeline — this event previously only recorded
    // length, losing the actual content. Not consumed by ai_agent's
    // own per-turn processing below, which re-reads the customer's
    // message from `messages` directly (same source runAiAgentCore
    // uses on the initial-entry path too).
    reply_text: message.kind === "text" ? message.text : null,
  });

  if (!run.current_node_key) {
    // Defensive — a run with status='active' but no current node is
    // malformed. Fail the run rather than spin.
    await endRun(db, run, "failed", "active_run_missing_current_node", {
      node_key: null,
      error_message: "active_run_missing_current_node",
    });
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: "no_match",
    };
  }

  const currentNode = nodes.get(run.current_node_key) ?? null;
  if (!currentNode) {
    await endRun(db, run, "failed", "current_node_not_found", {
      node_key: run.current_node_key,
      error_message: "current_node_not_found",
    });
    return { consumed: true, flow_run_id: run.id, outcome: "no_match" };
  }

  // WAHA has no native interactive reply — a send_buttons/send_list
  // node sent over WAHA (sendButtonsViaProvider/sendListViaProvider)
  // instead sends a numbered plain-text list and stashes a
  // { "1": reply_id, ... } map on run.vars.__waha_button_map. If the
  // customer's plain-text reply matches an entry in that map AND we're
  // actually sitting on a send_buttons/send_list node right now,
  // translate it into the same interactive_reply shape a real Meta tap
  // would produce, so the matching logic below never needs to know
  // WAHA is involved.
  //
  // The node_type guard matters: without it, a stale map left over
  // from an earlier send_buttons/send_list node would misfire against
  // an unrelated later collect_input node — e.g. a customer legitimately
  // typing "1" as a free-text answer would otherwise be mis-routed as
  // a button tap instead of captured as their actual reply.
  const wahaButtonMap = run.vars?.__waha_button_map as Record<string, string> | undefined;
  let effectiveMessage: ParsedInbound = message;
  if (
    wahaButtonMap &&
    message.kind === "text" &&
    (currentNode.node_type === "send_buttons" || currentNode.node_type === "send_list")
  ) {
    const mappedReplyId = wahaButtonMap[message.text.trim()];
    if (mappedReplyId) {
      effectiveMessage = {
        kind: "interactive_reply",
        reply_id: mappedReplyId,
        reply_title: message.text.trim(),
        meta_message_id: message.meta_message_id,
        message_id: message.message_id,
      };
    }
  }

  // ai_agent in loop mode suspends parked at itself awaiting the
  // customer's next reply (see the "loop" branch in
  // advanceFromNodeKey) — unlike send_buttons/collect_input, it isn't
  // driven by matching a button id or capturing into a var: every
  // text reply just feeds another AI turn. Handled here, before the
  // interactive/collect_input matching below and before the fallback
  // policy — fallback.ts was designed for unmatched send_buttons/
  // send_list replies, not for this, and previously a reply parked
  // here silently fell through to it (reprompt_count incrementing
  // with nothing actually sent, eventually handing off after
  // max_reprompts) instead of ever reaching the AI again.
  if (currentNode.node_type === "ai_agent") {
    const cfg = currentNode.config as unknown as AiAgentNodeConfig;

    // Debounce — see debounceAiAgentReply's own comment. If a newer
    // reply for this run supersedes us before the window elapses, bail
    // without touching turns/vars/events; the newer call handles it.
    const shouldProceed = await debounceAiAgentReply(run.id);
    if (!shouldProceed) {
      return { consumed: true, flow_run_id: run.id, outcome: "advanced" };
    }

    const core = await runAiAgentCore(
      db,
      run,
      cfg.system_prompt_override || undefined,
      undefined,       // incomingText lido do DB — mensagem já persistida pelo webhook
      run.started_at,  // historyAfter — corta histórico de runs anteriores
    );
    if (!core.ok) {
      await logEvent(db, run.id, "error", currentNode.node_key, {
        reason: "ai_agent_failed",
        detail: core.detail,
        exit_reason: "error",
      });
      await endRun(db, run, "failed", "ai_agent_failed", {
        node_key: currentNode.node_key,
        node_type: currentNode.node_type,
        error_message: core.detail,
        err: core.err,
        output: {
          last_reply: core.lastReply.slice(-300),
          ai_exit_code: core.exitCodeFound,
          model_used: core.modelUsed,
          ...(!core.aiConfigUsable
            ? { error_reason: "ai_config_disabled_or_missing" }
            : {}),
        },
      });
      return { consumed: true, flow_run_id: run.id, outcome: "completed" };
    }

    const { lastReply, exitCodeFound, baseOutput } = core;
    await logEvent(db, run.id, "message_sent", currentNode.node_key, {
      node_type: "ai_agent",
      mode: cfg.mode,
      last_reply: lastReply.slice(-300),
    });

    const nodeStartedAt = Date.now();
    const inputSnapshot: Record<string, unknown> = { ...run.vars };
    const nodeCompleted = (output: Record<string, unknown> = {}) =>
      logRunEvent(db, {
        run_id: run.id,
        flow_id: run.flow_id,
        account_id: run.account_id,
        node_key: currentNode.node_key,
        node_type: currentNode.node_type,
        event_type: "node_completed",
        status: "success",
        duration_ms: Date.now() - nodeStartedAt,
        payload: { input: inputSnapshot, output },
      });

    const maxTurns = cfg.max_turns ?? 20;
    const priorTurns =
      typeof run.vars.__ai_turns__ === "number"
        ? (run.vars.__ai_turns__ as number)
        : 0;
    const turns = priorTurns + 1;

    if (exitCodeFound || turns >= maxTurns) {
      // Same exit condition as the initial-entry branch in
      // advanceFromNodeKey: a #TAG in the reply, or the turn cap hit.
      // Reset the counter and hand off to advanceFromNodeKey to walk
      // the rest of the graph from next_node_key — current_node_key
      // is already this node, so there's nothing to advance INTO
      // first (unlike the entry case, which transitions from a prior
      // node via `continue` in that function's own loop).
      await updateRunVars(db, run, { __ai_turns__: 0 });
      const exitReason = exitCodeFound ? "exit_code_detected" : "max_turns";
      await logEvent(db, run.id, "node_entered", currentNode.node_key, {
        turns_used: turns,
        exit_reason: exitCodeFound ? "exit_code_matched" : "limit_reached",
      });
      await nodeCompleted({
        ...baseOutput,
        turns_used: turns,
        exit_reason: exitReason,
      });

      const nextKey = cfg.next_node_key ?? null;
      if (!nextKey) {
        await logEvent(db, run.id, "error", null, {
          reason: "next_node_key was null mid-advance",
        });
        await endRun(db, run, "failed", "missing_next_node", {
          node_key: null,
          error_message: "next_node_key was null mid-advance",
        });
        return { consumed: true, flow_run_id: run.id, outcome: "completed" };
      }

      if (nodes.get(nextKey)?.node_type === "ai_agent") {
        // Same guard as advanceFromNodeKey's own loop-mode exit branch
        // — don't hand this straight to advanceFromNodeKey, which would
        // immediately run the next ai_agent node's own turn against the
        // SAME customer message that just closed this node out. Park
        // there instead and let the customer's actual next reply drive it.
        const advanced = await advanceCurrentNodeKey(
          db,
          run.id,
          run.current_node_key,
          nextKey,
        );
        if (!advanced) {
          await logEvent(db, run.id, "error", currentNode.node_key, {
            reason: "lost_race_during_advance",
          });
        }
        return { consumed: true, flow_run_id: run.id, outcome: "advanced" };
      }

      const outcome = await advanceFromNodeKey(db, run, nextKey, nodes);
      return {
        consumed: true,
        flow_run_id: run.id,
        outcome: outcome.outcome,
      };
    }

    // Still under the turn cap — stays parked at this same node
    // awaiting the next reply. current_node_key already equals this
    // node's key (that's how we got here), so no advanceCurrentNodeKey
    // call is needed, unlike the initial-entry branch.
    await updateRunVars(db, run, { __ai_turns__: turns });
    await logEvent(db, run.id, "node_entered", currentNode.node_key, {
      turns_used: turns,
      exit_reason: "awaiting_reply",
    });
    await nodeCompleted({
      ...baseOutput,
      turns_used: turns,
      exit_reason: "awaiting_reply",
    });
    return { consumed: true, flow_run_id: run.id, outcome: "advanced" };
  }

  // Two ways a reply can advance:
  //   1. Interactive button/list tap on a send_buttons/send_list node.
  //   2. Text reply on a collect_input node — capture into vars.
  //
  // Everything else falls through to the fallback policy below.
  let matched: string | null = null;
  if (
    effectiveMessage.kind === "interactive_reply" &&
    (currentNode.node_type === "send_buttons" ||
      currentNode.node_type === "send_list")
  ) {
    matched = matchReplyId(currentNode, effectiveMessage.reply_id);
  } else if (
    effectiveMessage.kind === "attachment" &&
    currentNode.node_type === "receive_attachment"
  ) {
    const cfg = currentNode.config as unknown as ReceiveAttachmentNodeConfig;
    const kind = mimeToAttachmentKind(effectiveMessage.mime_type);
    if (!cfg.allowed_types?.length || (kind && cfg.allowed_types.includes(kind))) {
      await updateRunVars(db, run, { [cfg.var_name]: effectiveMessage.url });
      await logEvent(db, run.id, "node_entered", currentNode.node_key, {
        captured_key: cfg.var_name,
        mime_type: effectiveMessage.mime_type,
      });
      matched = cfg.next_node_key;
    }
    // else: attachment type not allowed — falls through to the
    // fallback policy below, same as an unmatched collect_input reply.
  } else if (
    effectiveMessage.kind === "text" &&
    currentNode.node_type === "collect_input"
  ) {
    const cfg = currentNode.config as unknown as CollectInputNodeConfig;
    const captured = effectiveMessage.text.trim();
    if (captured.length > 0 && cfg.var_key) {
      // Persist captured value + reset reprompt count atomically.
      const newVars = { ...run.vars, [cfg.var_key]: captured };
      const { error: capErr } = await db
        .from("flow_runs")
        .update({
          vars: newVars,
          reprompt_count: 0,
        })
        .eq("id", run.id);
      if (!capErr) {
        // Mirror the UPDATE in-memory so downstream interpolation in
        // the advance loop sees the captured var without us having to
        // re-SELECT the whole row.
        run.vars = newVars;
        run.reprompt_count = 0;
        // user_input carries the raw reply — a deliberate reversal of
        // this event's prior privacy-conservative stance (captured_key
        // + captured_length only), per an explicit request for n8n-level
        // input/output detail on the debug timeline. Same access model
        // as before (flow_run_events stays scoped to the run's owner).
        await logEvent(db, run.id, "node_entered", currentNode.node_key, {
          captured_key: cfg.var_key,
          captured_length: captured.length,
          user_input: captured,
        });
        matched = cfg.next_node_key;
      }
    }
  }

  if (matched) {
    // Reset reprompt count on a successful match. Skip the write when
    // already 0 — the collect_input capture branch above already
    // zeroed it, and interactive-reply matches against a fresh run
    // (post-prior-reset) are also already 0. The previous re-read of
    // the whole row was needed only because we weren't mirroring the
    // capture UPDATE into the in-memory `run`; now that we do, the
    // local copy is the source of truth.
    if (run.reprompt_count !== 0) {
      const { error } = await db
        .from("flow_runs")
        .update({ reprompt_count: 0 })
        .eq("id", run.id);
      if (!error) run.reprompt_count = 0;
    }
    const outcome = await advanceFromNodeKey(db, run, matched, nodes);
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: outcome.outcome,
    };
  }

  // No match → fallback. Apply the policy.
  const policy = resolveFallbackPolicy(
    (await loadFlow(db, run.flow_id))?.fallback_policy,
  );
  const newReprompts = run.reprompt_count + 1;
  await db
    .from("flow_runs")
    .update({ reprompt_count: newReprompts })
    .eq("id", run.id);

  const action = decideFallback({ policy, reprompt_count: newReprompts });
  await logEvent(db, run.id, "fallback_fired", run.current_node_key, {
    action: action.type,
    reprompt_count: newReprompts,
  });
  if (action.type === "ignore") {
    // Don't consume — let automations have a shot at it.
    return { consumed: false, flow_run_id: run.id, outcome: "no_match" };
  }
  if (action.type === "reprompt") {
    // Re-send the same prompt. Same node, no current_node_key change.
    if (currentNode.node_type === "send_buttons") {
      await sendButtonsAndSuspend(db, run, currentNode);
    } else if (currentNode.node_type === "send_list") {
      await sendListAndSuspend(db, run, currentNode);
    } else if (currentNode.node_type === "collect_input") {
      // Customer typed something we couldn't accept (empty after trim,
      // or var_key missing — rare). Re-send the prompt so they try again.
      const cfg = currentNode.config as unknown as CollectInputNodeConfig;
      try {
        await sendTextViaProvider(run, {
          text: interpolateVars(cfg.prompt_text, run.vars),
        });
      } catch (err) {
        await logEvent(db, run.id, "error", currentNode.node_key, {
          reason: "reprompt_send_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { consumed: true, flow_run_id: run.id, outcome: "fallback_fired" };
  }
  if (action.type === "handoff") {
    if (run.conversation_id) {
      await db
        .from("conversations")
        .update({ status: "pending", updated_at: new Date().toISOString() })
        .eq("id", run.conversation_id);
    }
    await logEvent(db, run.id, "handoff", run.current_node_key, {
      reason: "fallback_exhausted",
    });
    await endRun(db, run, "handed_off", "fallback_exhausted");
    return { consumed: true, flow_run_id: run.id, outcome: "handed_off" };
  }
  // action.type === 'end'
  await endRun(db, run, "completed", "fallback_exhausted_end");
  return { consumed: true, flow_run_id: run.id, outcome: "completed" };
}

async function startNewRun(
  db: AdminClient,
  flow: FlowRow,
  input: DispatchInboundInput,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult> {
  // INSERT — partial unique index `idx_one_active_run_per_contact`
  // catches concurrent inserts with 23505. We catch and return as
  // consumed:true (the parallel webhook handles it).
  const { data: inserted, error: insErr } = await db
    .from("flow_runs")
    .insert({
      flow_id: flow.id,
      // Tenancy: NOT NULL post-017. The partial unique index
      // `idx_one_active_run_per_contact` is over (account_id,
      // contact_id) WHERE status='active', so two accounts sharing
      // a contact phone number each run their own flows independently.
      account_id: flow.account_id,
      // Audit: preserves the flow's author on the run row for log
      // attribution.
      user_id: flow.user_id,
      contact_id: input.contactId,
      conversation_id: input.conversationId,
      // Which channel this run started on (migration 057) — NULL for
      // Meta (meta-send.ts still resolves "the account's Meta config"
      // on its own) or when the caller didn't pass one. Fixed for the
      // life of the run; a later reply on a different channel still
      // sends back through this one (see handleReplyForActiveRun,
      // which never re-reads input.configId).
      config_id: input.configId ?? null,
      status: "active",
      current_node_key: flow.entry_node_id,
    })
    .select("*")
    .maybeSingle();
  if (insErr) {
    // 23505 = unique_violation → another webhook is starting the run.
    const msg = insErr.message ?? "";
    if (msg.includes("23505") || msg.includes("duplicate key")) {
      return { consumed: true, outcome: "duplicate_inbound_ignored" };
    }
    console.error("[flows] startNewRun insert error:", insErr.message);
    return { consumed: false, outcome: "no_match" };
  }
  const run = inserted as FlowRunRow;
  await logEvent(db, run.id, "started", flow.entry_node_id, {
    flow_id: flow.id,
    trigger_type: flow.trigger_type,
    meta_message_id: inboundMessageId(input.message),
  });
  await logRunEvent(db, {
    run_id: run.id,
    flow_id: flow.id,
    account_id: flow.account_id,
    node_key: flow.entry_node_id,
    event_type: "run_started",
    status: "success",
    payload: { trigger_type: flow.trigger_type },
  });
  // Bump the flow's execution counter — used by the builder UI to
  // surface "X runs since activation" on the flow card.
  //
  // Atomic RPC (migration 012) rather than read-modify-write: two
  // concurrent webhooks starting runs for different contacts on the
  // same flow would otherwise both read N and both write N+1, losing
  // a count. Mirrors the automations engine's use of
  // `increment_automation_execution_count` (migration 007).
  const { error: incErr } = await db.rpc("increment_flow_execution_count", {
    p_flow_id: flow.id,
  });
  if (incErr) {
    // Non-fatal — the run itself succeeded; only the counter is off.
    console.error("[flows] execution_count rpc error:", incErr.message);
  }

  // Run the advance loop starting from the entry node.
  const outcome = await advanceFromNodeKey(db, run, flow.entry_node_id!, nodes, input.message);
  return {
    consumed: true,
    flow_run_id: run.id,
    outcome: outcome.outcome === "advanced" ? "started" : outcome.outcome,
  };
}

/**
 * go_to_flow's run-creation path. Mirrors startNewRun's INSERT, but
 * there's no inbound ParsedInbound to log — the transfer is
 * engine-driven, not a fresh customer message — and it optionally
 * seeds the new run's vars from the source run (`pass_vars`). Caller
 * (the go_to_flow branch in advanceFromNodeKey) has already ended the
 * source run with status='transferred' before calling this, so the
 * partial unique index `idx_one_active_run_per_contact` never sees
 * two active rows for the same contact.
 */
async function startTransferredRun(
  db: AdminClient,
  targetFlow: FlowRow,
  sourceRun: FlowRunRow,
  passVars: boolean,
  nodes: Map<string, FlowNodeRow>,
): Promise<void> {
  const { data: inserted, error: insErr } = await db
    .from("flow_runs")
    .insert({
      flow_id: targetFlow.id,
      account_id: targetFlow.account_id,
      user_id: targetFlow.user_id,
      contact_id: sourceRun.contact_id,
      conversation_id: sourceRun.conversation_id,
      config_id: sourceRun.config_id,
      status: "active",
      current_node_key: targetFlow.entry_node_id,
      vars: passVars ? sourceRun.vars : {},
    })
    .select("*")
    .maybeSingle();
  if (insErr) {
    // 23505 = unique_violation — same race as startNewRun; the contact
    // already has an active run (started by a parallel webhook), so
    // this transfer is a no-op rather than a hard failure.
    const msg = insErr.message ?? "";
    if (msg.includes("23505") || msg.includes("duplicate key")) return;
    console.error("[flows] startTransferredRun insert error:", insErr.message);
    return;
  }
  const newRun = inserted as FlowRunRow;
  await logEvent(db, newRun.id, "started", targetFlow.entry_node_id, {
    flow_id: targetFlow.id,
    trigger_type: "go_to_flow",
    transferred_from_run_id: sourceRun.id,
  });
  await logRunEvent(db, {
    run_id: newRun.id,
    flow_id: targetFlow.id,
    account_id: targetFlow.account_id,
    node_key: targetFlow.entry_node_id,
    event_type: "run_started",
    status: "success",
    payload: { trigger_type: "go_to_flow", transferred_from_run_id: sourceRun.id },
  });
  const { error: incErr } = await db.rpc("increment_flow_execution_count", {
    p_flow_id: targetFlow.id,
  });
  if (incErr) {
    console.error("[flows] execution_count rpc error:", incErr.message);
  }
  await advanceFromNodeKey(db, newRun, targetFlow.entry_node_id!, nodes);
}
