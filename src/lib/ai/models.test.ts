import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  getAiModelsForProvider,
  getProviderForModel,
  isModelCompatibleWithProvider,
  resolveAiModel,
} from "./models";

describe("AI model registry", () => {
  it("lists only models from the selected provider", () => {
    const openai = getAiModelsForProvider("openai").map((m) => m.id);
    expect(openai).toContain("gpt-4o-mini");
    expect(openai).toContain("gpt-6-luna");
    expect(openai).not.toContain("gemini-2.5-flash");
  });

  it("identifies the provider for a registered model", () => {
    expect(getProviderForModel("gpt-4.1-mini")).toBe("openai");
    expect(getProviderForModel("gemini-2.5-flash")).toBe("gemini");
    expect(getProviderForModel("unknown-model")).toBeNull();
  });

  it("checks provider compatibility", () => {
    expect(isModelCompatibleWithProvider("gpt-4o-mini", "openai")).toBe(true);
    expect(isModelCompatibleWithProvider("gpt-4o-mini", "gemini")).toBe(false);
  });
});

describe("resolveAiModel", () => {
  it("prefers the node override", () => {
    expect(
      resolveAiModel({
        provider: "openai",
        nodeModel: "gpt-4.1",
        accountModel: "gpt-4o-mini",
      }),
    ).toEqual({ model: "gpt-4.1", source: "node" });
  });

  it("falls back to the account model", () => {
    expect(
      resolveAiModel({
        provider: "openai",
        accountModel: "gpt-4.1-mini",
      }),
    ).toEqual({ model: "gpt-4.1-mini", source: "account" });
  });

  it("falls back to the provider default when account model is missing", () => {
    expect(
      resolveAiModel({ provider: "openai" }),
    ).toEqual({
      model: DEFAULT_MODEL_BY_PROVIDER.openai,
      source: "provider_default",
    });
  });

  it("ignores an incompatible account model", () => {
    expect(
      resolveAiModel({
        provider: "openai",
        accountModel: "gemini-2.5-flash",
      }),
    ).toEqual({
      model: DEFAULT_MODEL_BY_PROVIDER.openai,
      source: "provider_default",
    });
  });

  it("returns null for unknown providers", () => {
    expect(resolveAiModel({ provider: "other" })).toBeNull();
  });
});
