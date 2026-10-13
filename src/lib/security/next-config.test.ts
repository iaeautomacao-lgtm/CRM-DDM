import { describe, expect, it } from "vitest";

import nextConfig from "../../../next.config";

describe("next.config: endurecimento de resposta", () => {
  it("não anuncia o framework (X-Powered-By desligado)", () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});
