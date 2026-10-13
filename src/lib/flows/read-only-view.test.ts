import { describe, expect, it } from "vitest";

import { REDACTED_HEADER_VALUE, redactNodesForReadOnly } from "./read-only-view";

describe("redactNodesForReadOnly", () => {
  const http = (headers: unknown) => ({ node_key: "h", node_type: "http_fetch", config: { url: "https://x.test", headers } });

  it("http_fetch: valores de cabeçalho viram máscara (só os NOMES ficam); marcadores {{cred.X}} continuam visíveis", () => {
    const [out] = redactNodesForReadOnly([http({ Authorization: "Bearer abc123", "X-Api-Key": "segredo", Token: "{{cred.ddm}}", "Content-Type": "application/json" })]);
    expect((out.config as { headers: Record<string, string> }).headers).toEqual({
      Authorization: REDACTED_HEADER_VALUE,
      "X-Api-Key": REDACTED_HEADER_VALUE,
      Token: "{{cred.ddm}}",
      "Content-Type": REDACTED_HEADER_VALUE,
    });
    expect(JSON.stringify(out)).not.toMatch(/abc123|segredo/);
  });

  it("não mexe nos outros nós, em http_fetch sem cabeçalho e não altera o original", () => {
    const original = [http({ A: "x" }), { node_key: "m", node_type: "send_message", config: { text: "oi", headers: { A: "x" } } }, http(undefined)];
    const out = redactNodesForReadOnly(original);
    expect(out[1]).toBe(original[1]);
    expect(out[2]).toBe(original[2]);
    expect((original[0].config as { headers: Record<string, string> }).headers.A).toBe("x");
  });
});
