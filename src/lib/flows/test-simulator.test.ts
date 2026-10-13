import { describe, expect, it } from "vitest";
import {
  respondToFlowTest,
  startFlowTest,
  type FlowTestSession,
  type TestNode,
} from "./test-simulator";

const contact = { name: "Ana", phone: "5511999999999", email: "ana@example.test", company: "Teste" };
const node = (key: string, type: string, config: Record<string, unknown> = {}): TestNode => ({
  node_key: key,
  node_type: type,
  config,
});

function run(nodes: TestNode[], vars: Record<string, unknown> = {}, tags: string[] = []): FlowTestSession {
  return startFlowTest({ entryNodeId: nodes[0]?.node_key ?? null, nodes, vars, tags, contact });
}

describe("flow test sandbox", () => {
  it("blocks flows without entry node or missing destination", () => {
    const blank = startFlowTest({ entryNodeId: null, nodes: [], contact });
    expect(blank.status).toBe("blocked");
    expect(blank.ending).toContain("entrada");

    const incomplete = run([node("start", "start", { next_node_key: "missing" })]);
    expect(incomplete.status).toBe("blocked");
    expect(incomplete.ending).toContain("missing");
  });

  it("walks the graph, renders variables, and finishes without external calls", () => {
    const flow = [
      node("start", "start", { next_node_key: "send" }),
      node("send", "send_message", { text: "Olá {{vars.name}}", next_node_key: "end" }),
      node("end", "end"),
    ];
    const state = run(flow, { name: "Clara" });
    expect(state.status).toBe("finished");
    expect(state.messages.some((m) => m.text === "Olá Clara")).toBe(true);
    expect(state.trace.map((step) => step.node_key)).toEqual(["start", "send", "end"]);
  });

  it("captures customer input, routes a true condition and preserves original state", () => {
    const flow = [
      node("ask", "collect_input", { prompt_text: "Nome?", var_key: "nome", next_node_key: "cond" }),
      node("cond", "condition", { subject: "var", subject_key: "nome", operator: "equals", value: "Ana", true_next: "yes", false_next: "no" }),
      node("yes", "send_message", { text: "Oi {{vars.nome}}", next_node_key: "end" }),
      node("no", "end"),
      node("end", "end"),
    ];
    const first = run(flow);
    expect(first.wait?.kind).toBe("text");
    expect(first.messages[0].text).toBe("Nome?");
    const second = respondToFlowTest(first, flow, { kind: "text", text: "Ana" });
    expect(first.vars.nome).toBeUndefined();
    expect(second.vars.nome).toBe("Ana");
    expect(second.status).toBe("finished");
    expect(second.messages.some((m) => m.text === "Oi Ana")).toBe(true);
  });

  it("routes false branches with production's case-sensitive equality", () => {
    const flow = [
      node("cond", "condition", { subject: "contact_field", subject_key: "name", operator: "equals", value: "ana", true_next: "wrong", false_next: "correct" }),
      node("wrong", "send_message", { text: "Wrong", next_node_key: "end" }),
      node("correct", "send_message", { text: "Correct", next_node_key: "end" }),
      node("end", "end"),
    ];
    const state = run(flow);
    expect(state.messages.find((m) => m.text === "Correct")).toBeTruthy();
    expect(state.messages.find((m) => m.text === "Wrong")).toBeFalsy();
  });

  it("waits for a choice and routes the matching button", () => {
    const flow = [
      node("buttons", "send_buttons", {
        text: "Escolha",
        buttons: [
          { reply_id: "a", title: "Sim", next_node_key: "yes" },
          { reply_id: "b", title: "Não", next_node_key: "no" },
        ],
      }),
      node("yes", "end"),
      node("no", "end"),
    ];
    const first = run(flow);
    expect(first.wait?.kind).toBe("choice");
    const invalid = respondToFlowTest(first, flow, { kind: "choice", id: "not-an-option" });
    expect(invalid).toBe(first);
    const second = respondToFlowTest(first, flow, { kind: "choice", id: "b" });
    expect(second.status).toBe("finished");
    expect(second.trace.some((t) => t.node_key === "no")).toBe(true);
    expect(second.trace.some((t) => t.node_key === "yes")).toBe(false);
  });

  it("supports list rows as choices", () => {
    const flow = [
      node("list", "send_list", { text: "Opções", sections: [{ title: "A", rows: [{ reply_id: "go", title: "Ir", next_node_key: "end" }] }] }),
      node("end", "end"),
    ];
    const first = run(flow);
    expect(first.wait?.kind).toBe("choice");
    const second = respondToFlowTest(first, flow, { kind: "choice", id: "go" });
    expect(second.status).toBe("finished");
  });

  it("evaluates ordered switch branches with tags and AND/OR", () => {
    const flow = [
      node("s", "switch", {
        branches: [
          { id: "one", label: "Primeiro", combinator: "and", conditions: [
            { subject: "tag", subject_key: "vip", operator: "present" },
            { subject: "var", subject_key: "plano", operator: "equals", value: "premium" },
          ], next_node_key: "first" },
          { id: "two", label: "Segundo", combinator: "or", conditions: [
            { subject: "var", subject_key: "plano", operator: "equals", value: "premium" },
            { subject: "var", subject_key: "plano", operator: "equals", value: "basic" },
          ], next_node_key: "second" },
        ],
        default_next: "default",
      }),
      node("first", "end"),
      node("second", "end"),
      node("default", "end"),
    ];
    expect(run(flow, { plano: "premium" }, ["vip"]).trace.at(-1)?.node_key).toBe("first");
    expect(run(flow, { plano: "premium" }).trace.at(-1)?.node_key).toBe("second");
    expect(run(flow, { plano: "other" }).trace.at(-1)?.node_key).toBe("default");
  });

  it("sets variables and tags only in the simulated session", () => {
    const flow = [
      node("set", "set_variable", { assignments: [
        { variable: "first", value: "A" },
        { variable: "second", value: "{{vars.first}}B" },
      ], next_node_key: "tag" }),
      node("tag", "set_tag", { mode: "add", tag_id: "vip", next_node_key: "end" }),
      node("end", "end"),
    ];
    const session = run(flow);
    expect(session.vars).toMatchObject({ first: "A", second: "AB" });
    expect(session.tags).toEqual(["vip"]);
    expect(flow[0].config.assignments).toEqual([
      { variable: "first", value: "A" },
      { variable: "second", value: "{{vars.first}}B" },
    ]);
  });

  it("blocks infinite zero-delay cycles after a finite number of visits", () => {
    const flow = [node("loop", "go_to", { target_node_key: "loop" })];
    const session = run(flow);
    expect(session.status).toBe("blocked");
    expect(session.visits).toBe(100);
    expect(session.ending).toContain("ciclo");
  });

  it("requests a manual AI reply and advances for once mode", () => {
    const flow = [
      node("ai", "ai_agent", { mode: "once", next_node_key: "end" }),
      node("end", "end"),
    ];
    const before = run(flow);
    expect(before.wait?.kind).toBe("ai_response");
    const after = respondToFlowTest(before, flow, { kind: "ai_response", text: "Resposta simulada" });
    expect(after.status).toBe("finished");
    expect(after.messages.some((m) => m.text === "Resposta simulada")).toBe(true);
  });

  it("simulates AI loop with the configured turn limit", () => {
    const flow = [
      node("ai", "ai_agent", { mode: "loop", max_turns: 2, next_node_key: "end" }),
      node("end", "end"),
    ];
    const first = respondToFlowTest(run(flow), flow, { kind: "ai_response", text: "Primeira" });
    expect(first.wait?.kind).toBe("ai_customer");
    const next = respondToFlowTest(first, flow, { kind: "text", text: "Cliente de novo" });
    expect(next.wait?.kind).toBe("ai_response");
    const done = respondToFlowTest(next, flow, { kind: "ai_response", text: "Segunda" });
    expect(done.status).toBe("finished");
    expect(done.aiTurns.ai).toBe(2);
  });

  it("ends simulated AI takeover without calling the model", () => {
    const flow = [node("ai", "ai_agent", { mode: "takeover" })];
    const result = respondToFlowTest(run(flow), flow, { kind: "ai_response", text: "Olá" });
    expect(result.ending).toContain("takeover");
  });

  it("never calls external HTTP; requires an explicit mocked response", () => {
    const flow = [
      node("http", "http_fetch", { url: "https://example.invalid", response_var: "result", next_node_key: "end" }),
      node("end", "end"),
    ];
    const first = run(flow);
    expect(first.wait?.kind).toBe("http_response");
    expect(first.vars.result).toBeUndefined();
    const value = { status: "ok" };
    const next = respondToFlowTest(first, flow, { kind: "http_response", value });
    expect(next.vars.result).toEqual(value);
    expect(next.status).toBe("finished");
  });

  it("supports simulated attachments with type restrictions", () => {
    const flow = [
      node("media", "receive_attachment", { prompt_text: "Envie documento", var_name: "anexo", allowed_types: ["document"], next_node_key: "end" }),
      node("end", "end"),
    ];
    const first = run(flow);
    expect(first.wait?.kind).toBe("attachment");
    expect(respondToFlowTest(first, flow, { kind: "attachment", mediaType: "image" })).toBe(first);
    const end = respondToFlowTest(first, flow, { kind: "attachment", mediaType: "document" });
    expect(end.status).toBe("finished");
    expect(end.vars.anexo).toBe("simulated://document");
  });

  it("simulates delay, media, template, note and handoff without writes", () => {
    const flow = [
      node("delay", "smart_delay", { delay_seconds: 3600, message: "Aguarde", next_node_key: "media" }),
      node("media", "send_media", { media_type: "image", media_url: "https://example.invalid/image", caption: "Imagem", next_node_key: "template" }),
      node("template", "send_template", { template_name: "boas_vindas", next_node_key: "note" }),
      node("note", "add_note", { note_text: "interno", next_node_key: "handoff" }),
      node("handoff", "handoff_team", { team_id: "team" }),
    ];
    const session = run(flow);
    expect(session.status).toBe("finished");
    expect(session.ending).toContain("transferência");
    expect(session.messages.some((m) => m.text.includes("Mídia simulada"))).toBe(true);
    expect(session.trace.some((t) => t.detail.includes("não executado"))).toBe(true);
  });

  it("stops at cross-flow and Webchat boundaries rather than triggering them", () => {
    expect(run([node("jump", "go_to_flow", { flow_id: "x" })]).ending).toContain("outro fluxo");
    expect(run([node("webchat", "send_webchat", { message_text: "Clique aqui" })]).ending).toContain("Webchat");
  });

  it("rejects unknown nodes instead of guessing their behavior", () => {
    const session = run([node("new", "unknown_future_type")]);
    expect(session.status).toBe("blocked");
    expect(session.ending).toContain("unknown_future_type");
  });
});
