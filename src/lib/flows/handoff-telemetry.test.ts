import { describe, expect, it } from "vitest";
import { flowExitTagsFromNodes } from "./exit-tag-routing";
import {
  pickRoundToolFailure,
  switchDefaultSubreason,
  type HandoffContextEvent,
} from "./engine";

const toolResult = (
  toolName: string,
  result: string,
  createdAt: string,
): HandoffContextEvent => ({
  node_key: "agente_ddm",
  node_type: "ai_agent",
  event_type: "tool_result",
  payload: { tool_name: toolName, result },
  created_at: createdAt,
});

const FAIL = '{"ok":false,"error":"TOOL_SERVER_ERROR"}';
const OK = '{"nome":"Maria"}';

describe("pickRoundToolFailure", () => {
  it("ignora erro de tool de rodada anterior (antes da última mensagem do cliente)", () => {
    const events = [
      toolResult("consultar_debitos", OK, "2026-10-05T20:05:00Z"),
      toolResult("localizar_devedor", FAIL, "2026-10-05T19:00:00Z"),
    ];
    expect(pickRoundToolFailure(events, "2026-10-05T20:00:00Z")).toEqual({
      toolError: null,
      toolName: null,
    });
  });

  it("anexa o erro da mesma rodada", () => {
    const events = [toolResult("consultar_debitos", FAIL, "2026-10-05T20:05:00Z")];
    expect(pickRoundToolFailure(events, "2026-10-05T20:00:00Z")).toEqual({
      toolError: "TOOL_SERVER_ERROR",
      toolName: "consultar_debitos",
    });
  });

  it("ignora erro recuperado por chamada posterior da mesma tool", () => {
    const events = [
      toolResult("localizar_devedor", OK, "2026-10-05T20:06:00Z"),
      toolResult("localizar_devedor", FAIL, "2026-10-05T20:05:00Z"),
    ];
    expect(pickRoundToolFailure(events, "2026-10-05T20:00:00Z").toolError).toBeNull();
  });

  it("sem início de rodada conhecido, ainda respeita a recuperação", () => {
    const events = [
      toolResult("localizar_devedor", OK, "2026-10-05T20:06:00Z"),
      toolResult("localizar_devedor", FAIL, "2026-10-05T20:05:00Z"),
      toolResult("consultar_debitos", FAIL, "2026-10-05T20:04:00Z"),
    ];
    expect(pickRoundToolFailure(events, null).toolName).toBe("consultar_debitos");
  });
});

describe("switchDefaultSubreason", () => {
  it("distingue max_turns, tag não roteada e ausência de tag", () => {
    expect(switchDefaultSubreason({ aiExitCode: null, aiExitReason: "max_turns" })).toBe(
      "SWITCH_DEFAULT_MAX_TURNS",
    );
    expect(switchDefaultSubreason({ aiExitCode: "#XPTO", aiExitReason: "exit_code_detected" })).toBe(
      "SWITCH_DEFAULT_TAG_NAO_ROTEADA",
    );
    expect(switchDefaultSubreason({ aiExitCode: null, aiExitReason: null })).toBe(
      "SWITCH_DEFAULT_SEM_TAG",
    );
  });
});

describe("flowExitTagsFromNodes", () => {
  it("coleta as tags dos ramos que olham ai_exit_code", () => {
    const tags = flowExitTagsFromNodes([
      {
        node_type: "switch",
        config: {
          branches: [
            { conditions: [{ subject: "var", subject_key: "ai_exit_code", operator: "equals", value: "#MINHA_TAG" }] },
            { conditions: [{ subject: "var", subject_key: "ai_exit_code", operator: "contains", value: "outra" }] },
            { conditions: [{ subject: "var", subject_key: "cpf", operator: "equals", value: "#NAO" }] },
          ],
          default_next: "x",
        },
      },
      {
        node_type: "condition",
        config: { subject: "var", subject_key: "ai_exit_code", operator: "equals", value: "#RECUSA" },
      },
      { node_type: "send_message", config: { text: "#IGNORADA" } },
    ]);
    expect(tags.sort()).toEqual(["#MINHA_TAG", "#OUTRA", "#RECUSA"]);
  });
});
