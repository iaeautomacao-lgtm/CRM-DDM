import { describe, expect, it } from "vitest";

import { flowTokenForRun, parseFlowToken } from "./flow-token";

const ID = "11111111-1111-4111-8111-111111111111";

describe("flow_token", () => {
  it("fr:<run> e dq:<item> fazem ida e volta; o resto é recusado", () => {
    expect(flowTokenForRun(ID)).toBe(`fr:${ID}`);
    expect(parseFlowToken(`fr:${ID}`)).toEqual({ kind: "run", id: ID });
    expect(parseFlowToken(`dq:${ID}`)).toEqual({ kind: "queue", id: ID });
    for (const bad of [ID, "fr:abc", "xx:" + ID, "", null, undefined, 42, `fr:${ID}x`]) expect(parseFlowToken(bad), String(bad)).toBeNull();
  });

  it("o token não carrega dado pessoal: só prefixo e uuid", () => {
    expect(flowTokenForRun(ID)).toMatch(/^fr:[0-9a-f-]{36}$/);
  });
});
